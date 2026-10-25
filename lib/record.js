/**
 * 服务器记录的规范化与校验。
 *
 * 一份记录就是一条 `@deepseek-ai/dsh-mcp-client` 条目的可编辑投影：
 * 只保留 DSH 原生客户端真正支持的字段，避免表单里出现“填了但不生效”的项。
 */
import { parseArgs } from './args.js';

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const TRANSPORTS = ['stdio', 'streamable-http'];
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 1_800_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value) {
  const valueText = text(value);
  return valueText === '' ? undefined : valueText;
}

function stringMap(value, label) {
  if (value === undefined || value === null || value === '') return {};
  const out = {};
  if (Array.isArray(value)) {
    for (const row of value) {
      if (row === null || typeof row !== 'object') continue;
      const key = text(row.key ?? row.name);
      if (key === '') continue;
      out[key] = String(row.value ?? '');
    }
    return out;
  }
  if (typeof value !== 'object') throw new Error(`${label}必须是键值对`);
  for (const [key, item] of Object.entries(value)) {
    const name = text(key);
    if (name === '') continue;
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${label}「${name}」的值必须是字符串`);
    }
    out[name] = String(item);
  }
  return out;
}

function normalizeTransport(input, source) {
  const raw = text(input.transport ?? input.type).toLowerCase();
  if (raw === '' || raw === 'auto') return source.command ? 'stdio' : 'streamable-http';
  if (raw === 'stdio') return 'stdio';
  if (raw === 'http' || raw === 'streamable-http' || raw === 'streamablehttp') return 'streamable-http';
  if (raw === 'sse') return 'streamable-http';
  throw new Error(`不支持的传输类型「${input.transport ?? input.type}」，可选 stdio 或 HTTP`);
}

function normalizeTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error('超时时间必须是整数毫秒');
  if (number < MIN_TIMEOUT_MS || number > MAX_TIMEOUT_MS) {
    throw new Error(`超时时间需在 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} ms 之间`);
  }
  return number;
}

function normalizeEnabled(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return !['false', '0', 'no', 'off', 'disabled'].includes(value.toLowerCase());
  return Boolean(value);
}

/**
 * 把表单 / JSON / 原生条目统一成可存储的服务器字段（不含 key 与时间戳）。
 *
 * @param {object} input 任意来源的服务器配置
 * @returns {{server: object, warnings: string[]}}
 */
export function normalizeServerInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('服务器配置必须是一个对象');
  }
  const warnings = [];
  const serverName = text(input.serverName ?? input.name);
  if (serverName === '') throw new Error('请填写名称');
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error('名称只能包含字母、数字、下划线或短横线，长度 1–32');
  }

  const command = optionalText(input.command);
  const url = optionalText(input.url);
  const transport = normalizeTransport(input, { command, url });

  let args = [];
  if (Array.isArray(input.args)) args = input.args.map((item) => String(item));
  else if (typeof input.args === 'string' && input.args.trim() !== '') args = parseArgs(input.args);

  const env = stringMap(input.env, '环境变量');
  const headers = stringMap(input.headers, '请求头');

  const server = {
    serverName,
    transport,
    command: undefined,
    args: [],
    env: {},
    cwd: undefined,
    url: undefined,
    headers: {},
    timeoutMs: normalizeTimeout(input.timeoutMs ?? input.toolCallTimeoutMs),
    enabled: normalizeEnabled(input.enabled ?? (input.disabled === undefined ? undefined : !input.disabled)),
  };

  if (transport === 'stdio') {
    if (!command) throw new Error('stdio 类型需要填写命令');
    server.command = command;
    server.args = args;
    server.env = env;
    if (optionalText(input.cwd)) server.cwd = optionalText(input.cwd);
  } else {
    if (!url) throw new Error('HTTP 类型需要填写 URL');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('URL 格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL 只支持 http:// 或 https://');
    }
    server.url = url;
    server.headers = headers;
  }

  const rawType = text(input.transport ?? input.type).toLowerCase();
  if (rawType === 'sse') warnings.push('旧版 SSE 配置已按 Streamable HTTP 保存');

  return { server, warnings };
}

/** 原生 mcp-client 条目配置 → 可存储字段；拒绝无法安全导入的表达式值。 */
export function serverFromNativeConfig(config, entryId) {
  if (config === null || typeof config !== 'object') throw new Error('该条目没有可读取的配置');
  const literal = (value, label) => {
    if (typeof value !== 'string') throw new Error(`${label} 含非字面量表达式，暂不支持接管，请手动新建`);
    return value;
  };
  const raw = {
    name: literal(config.serverName, 'serverName'),
    transport: config.transport,
    command: config.command === undefined ? undefined : literal(config.command, 'command'),
    args: Array.isArray(config.args) ? config.args.map((item) => literal(item, 'args')) : [],
    env: {},
    cwd: config.cwd === undefined ? undefined : literal(config.cwd, 'cwd'),
    url: config.url === undefined ? undefined : literal(config.url, 'url'),
    headers: {},
    timeoutMs: config.toolCallTimeoutMs,
  };
  for (const [key, value] of Object.entries(config.env ?? {})) raw.env[key] = literal(value, `环境变量 ${key}`);
  for (const [key, value] of Object.entries(config.headers ?? {})) raw.headers[key] = literal(value, `请求头 ${key}`);
  const { server } = normalizeServerInput(raw);
  server.nativeEntryId = entryId;
  return server;
}

/** 存储表校验（zod v4）。字段在 normalize 阶段已经补齐。 */
export function serverRecordSchema(z) {
  return z.object({
    key: z.string().min(1),
    serverName: z.string().regex(SERVER_NAME_RE),
    transport: z.enum(['stdio', 'streamable-http']),
    command: z.string().optional(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()),
    timeoutMs: z.number().int().positive(),
    enabled: z.boolean(),
    nativeEntryId: z.string().optional(),
    nativeEntryIds: z.array(z.string()).optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  });
}
