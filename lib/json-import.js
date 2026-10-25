/**
 * 主流 `mcpServers` JSON 的宽松导入。
 *
 * 兼容：
 *   { "mcpServers": { "name": { "command": ... } } }
 *   { "name": { "type": "stdio" | "http", ... } }
 *   { "name": "server", "command": ... }            // 单条
 *   [ { "name": "server", "command": ... } ]        // 列表
 */
import { normalizeServerInput } from './record.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeServer(value) {
  if (!isPlainObject(value)) return false;
  return ['command', 'url', 'type', 'transport', 'serverName'].some((key) => key in value);
}

function pickEnabled(entry) {
  if (entry.enabled !== undefined) return entry.enabled;
  if (entry.enable !== undefined) return entry.enable;
  if (entry.disabled !== undefined) return !entry.disabled;
  return true;
}

function toInput(name, entry) {
  return {
    serverName: name,
    transport: entry.type ?? entry.transport,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    timeoutMs: entry.timeoutMs ?? entry.toolCallTimeoutMs,
    enabled: pickEnabled(entry),
  };
}

/**
 * @param {string|object} input JSON 文本或已解析对象
 * @returns {{servers: object[], warnings: string[]}}
 */
export function parseMcpServersJson(input) {
  let data;
  if (typeof input === 'string') {
    const source = input.replace(/^\uFEFF/, '').trim();
    if (source === '') throw new Error('JSON 不能为空');
    try {
      data = JSON.parse(source);
    } catch (error) {
      throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    data = input;
  }

  let entries = [];
  if (Array.isArray(data)) {
    entries = data.map((entry, index) => {
      if (!isPlainObject(entry)) throw new Error(`第 ${index + 1} 项不是对象`);
      const name = String(entry.serverName ?? entry.name ?? '').trim();
      if (!name) throw new Error(`第 ${index + 1} 项缺少 name`);
      return [name, entry];
    });
  } else if (isPlainObject(data)) {
    const wrappedKey = data.mcpServers !== undefined ? 'mcpServers' : 'servers';
    const wrapped = data[wrappedKey];
    if (wrapped !== undefined) {
      if (!isPlainObject(wrapped)) throw new Error(`${wrappedKey} 必须是一个对象`);
      entries = Object.entries(wrapped);
    } else if (looksLikeServer(data)) {
      const name = String(data.serverName ?? data.name ?? '').trim();
      if (!name) throw new Error('单条配置缺少 name');
      entries = [[name, data]];
    } else {
      entries = Object.entries(data);
    }
  } else {
    throw new Error('JSON 顶层必须是对象或数组');
  }

  if (entries.length === 0) throw new Error('没有找到任何 MCP Server 配置');

  const warnings = [];
  const servers = [];
  const seen = new Set();
  for (const [rawName, entry] of entries) {
    const name = String(rawName).trim();
    if (!name) throw new Error('Server 名称不能为空');
    if (seen.has(name)) throw new Error(`名称「${name}」在 JSON 中重复出现`);
    seen.add(name);
    if (!isPlainObject(entry)) throw new Error(`「${name}」的配置必须是对象`);
    try {
      const { server, warnings: itemWarnings } = normalizeServerInput(toInput(name, entry));
      servers.push(server);
      warnings.push(...itemWarnings.map((message) => `${name}: ${message}`));
    } catch (error) {
      throw new Error(`「${name}」配置无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { servers, warnings };
}
