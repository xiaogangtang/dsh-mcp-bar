/**
 * 连接探测：对 HTTP / stdio MCP Server 执行 initialize + notifications/initialized
 * + tools/list，用于保存前校验、连接测试和工具预览。
 *
 * 探测是独立的短会话，不会干扰 DSH 正在运行的 mcp-client：
 *   - HTTP：POST + Mcp-Session-Id，结束后 DELETE 会话；
 *   - stdio：临时 spawn 一个进程，完成后结束整个进程组。
 */
const PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOLS = 5_000;
const MAX_PAGES = 50;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

export class ProbeError extends Error {
  constructor(message, kind = 'protocol') {
    super(message);
    this.name = 'ProbeError';
    this.kind = kind;
  }
}

function normalizeTool(tool) {
  const schema = tool.inputSchema ?? tool.input_schema ?? {};
  return {
    name: typeof tool.name === 'string' ? tool.name : String(tool.name ?? ''),
    title: typeof tool.title === 'string' ? tool.title : undefined,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: schema && typeof schema === 'object' ? schema : {},
  };
}

function payloadError(payload) {
  if (!payload || typeof payload !== 'object' || !payload.error) return null;
  const message = String(payload.error.message ?? payload.error.data ?? '').replace(/\s+/g, ' ').slice(0, 240);
  const kind = /unauthori[sz]ed|forbidden|invalid.?token|invalid.?key|credential|access.?denied|未授权|无权|密钥|令牌/i.test(message)
    ? 'auth'
    : 'protocol';
  return new ProbeError(`MCP 返回错误${message ? `：${message}` : ''}`, kind);
}

function parseJsonPayload(text, contentType = '') {
  if (!text.trim()) return undefined;
  if (contentType.includes('text/event-stream')) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        events.push(JSON.parse(data));
      } catch {}
    }
    return events.length > 0 ? events[events.length - 1] : undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readTextLimited(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ProbeError('MCP 响应体超过 2 MiB', 'protocol');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ProbeError('MCP 响应体超过 2 MiB', 'protocol');
  return text;
}

async function httpPost(record, payload, { signal, sessionId, protocolVersion }) {
  const headers = {
    ...(record.headers ?? {}),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  let response;
  try {
    response = await fetch(record.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
      redirect: 'follow',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ProbeError('连接超时', 'timeout');
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
    throw new ProbeError(`无法连接 ${record.url}（${cause}）`, 'network');
  }
  const text = await readTextLimited(response);
  const parsed = parseJsonPayload(text, response.headers.get('content-type') ?? '');
  if (response.status === 401 || response.status === 403) {
    throw new ProbeError(`凭据无效、已过期或权限不足（HTTP ${response.status}）`, 'auth');
  }
  if (!response.ok) {
    throw new ProbeError(`MCP 请求失败（HTTP ${response.status}）${text ? `：${text.slice(0, 180)}` : ''}`, 'http');
  }
  const rpcError = payloadError(parsed);
  if (rpcError) throw rpcError;
  return { response, text, payload: parsed };
}

async function closeHttpSession(record, sessionId, protocolVersion) {
  if (!sessionId) return;
  try {
    await fetch(record.url, {
      method: 'DELETE',
      headers: {
        ...(record.headers ?? {}),
        'mcp-session-id': sessionId,
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
      },
      signal: AbortSignal.timeout(2_000),
      redirect: 'follow',
    });
  } catch {}
}

async function probeHttp(record, { timeoutMs }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId = '';
  let protocolVersion = PROTOCOL_VERSION;
  try {
    const initialized = await httpPost(record, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-bar', version: '0.1.0' },
      },
    }, { signal: controller.signal });
    if (!initialized.payload?.result || typeof initialized.payload.result !== 'object') {
      throw new ProbeError('Server 未返回有效的 initialize 结果');
    }
    protocolVersion = initialized.payload.result.protocolVersion || PROTOCOL_VERSION;
    sessionId = initialized.response.headers.get('mcp-session-id') ?? '';

    await httpPost(record, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, { signal: controller.signal, sessionId, protocolVersion });

    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await httpPost(record, {
        jsonrpc: '2.0',
        id: page + 2,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      }, { signal: controller.signal, sessionId, protocolVersion });
      const pageTools = listed.payload?.result?.tools;
      if (!Array.isArray(pageTools)) throw new ProbeError('tools/list 未返回工具数组');
      tools.push(...pageTools.map(normalizeTool));
      if (tools.length > MAX_TOOLS) throw new ProbeError(`工具数量超过安全上限（${MAX_TOOLS}）`);
      const next = listed.payload?.result?.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      if (seen.has(next)) throw new ProbeError('tools/list 返回了重复分页游标');
      seen.add(next);
      cursor = next;
      if (page === MAX_PAGES - 1) throw new ProbeError('tools/list 分页超过安全上限');
    }
    return {
      ok: true,
      transport: 'streamable-http',
      protocolVersion,
      sessionful: Boolean(sessionId),
      tools,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    await closeHttpSession(record, sessionId, protocolVersion);
  }
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill();
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 1_500);
  timer.unref?.();
}

/**
 * 解析 stdio 上的一帧。返回 {messages, rest, needBytes}。
 * 同时兼容换行分隔 JSON 与 LSP 风格 Content-Length 头。
 */
function takeMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest === '') return { messages, rest: '' };
    if (/^content-length:/i.test(rest)) {
      const headerEnd = rest.indexOf('\r\n\r\n');
      const headerEndAlt = rest.indexOf('\n\n');
      const end = headerEnd >= 0 ? headerEnd : headerEndAlt;
      if (end < 0) return { messages, rest };
      const header = rest.slice(0, end);
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        rest = rest.slice(end + (headerEnd >= 0 ? 4 : 2));
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = end + (headerEnd >= 0 ? 4 : 2);
      if (Buffer.byteLength(rest.slice(bodyStart)) < length) return { messages, rest };
      const body = rest.slice(bodyStart, bodyStart + length);
      rest = rest.slice(bodyStart + length);
      try {
        messages.push(JSON.parse(body));
      } catch {}
      continue;
    }
    const newline = rest.indexOf('\n');
    if (newline < 0) return { messages, rest };
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      // 有些 Server 会把日志写到 stdout，跳过非 JSON 行。
    }
  }
}

async function probeStdio(record, { timeoutMs }) {
  const startedAt = Date.now();
  const { spawn } = await import('node:child_process');
  const child = spawn(record.command, record.args ?? [], {
    cwd: record.cwd || process.cwd(),
    env: { ...process.env, ...(record.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
  });

  let stderr = '';
  let stdoutBuffer = '';
  const pending = new Map();
  let exited = false;
  let exitInfo = null;
  let spawnFailed = false;

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES);
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const taken = takeMessages(stdoutBuffer);
    stdoutBuffer = taken.rest;
    for (const message of taken.messages) {
      if (message === null || typeof message !== 'object') continue;
      if (message.id !== undefined && pending.has(message.id)) {
        const job = pending.get(message.id);
        pending.delete(message.id);
        job.resolve(message);
      }
    }
  });

  const spawnFailure = new Promise((_, reject) => {
    child.once('error', (error) => {
      spawnFailed = true;
      reject(new ProbeError(
        error?.code === 'ENOENT' ? `找不到命令「${record.command}」` : `启动进程失败：${error.message}`,
        'spawn',
      ));
    });
  });
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    for (const job of pending.values()) {
      job.reject(new ProbeError(
        `进程已退出（${signal ? `信号 ${signal}` : `code ${code}`}）${stderr ? `：${stderr.slice(-400).trim()}` : ''}`,
        'spawn',
      ));
    }
    pending.clear();
  });

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new ProbeError('连接超时', 'timeout')), timeoutMs);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  });

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (exited) {
        reject(new ProbeError(`进程已退出${stderr ? `：${stderr.slice(-400).trim()}` : ''}`, 'spawn'));
        return;
      }
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        reject(new ProbeError(`写入进程失败：${error.message}`, 'spawn'));
      }
    });
  }
  function notify(method, params) {
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {}
  }

  const work = (async () => {
    const initialized = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-bar', version: '0.1.0' },
    });
    const rpcError = payloadError(initialized);
    if (rpcError) throw rpcError;
    if (!initialized.result || typeof initialized.result !== 'object') {
      throw new ProbeError('Server 未返回有效的 initialize 结果');
    }
    const protocolVersion = initialized.result.protocolVersion || PROTOCOL_VERSION;
    notify('notifications/initialized', {});

    const tools = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await request('tools/list', cursor ? { cursor } : {});
      const listError = payloadError(listed);
      if (listError) throw listError;
      const pageTools = listed.result?.tools;
      if (!Array.isArray(pageTools)) throw new ProbeError('tools/list 未返回工具数组');
      tools.push(...pageTools.map(normalizeTool));
      if (tools.length > MAX_TOOLS) throw new ProbeError(`工具数量超过安全上限（${MAX_TOOLS}）`);
      const next = listed.result?.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      if (seen.has(next)) throw new ProbeError('tools/list 返回了重复分页游标');
      seen.add(next);
      cursor = next;
      if (page === MAX_PAGES - 1) throw new ProbeError('tools/list 分页超过安全上限');
    }
    return {
      ok: true,
      transport: 'stdio',
      protocolVersion,
      sessionful: false,
      tools,
      latencyMs: Date.now() - startedAt,
    };
  })();

  try {
    return await Promise.race([work, spawnFailure, timeout]);
  } catch (error) {
    if (error instanceof ProbeError) {
      if (error.kind === 'spawn' && stderr && !error.message.includes('：')) {
        throw new ProbeError(`${error.message}：${stderr.slice(-400).trim()}`, 'spawn');
      }
      throw error;
    }
    throw new ProbeError(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'spawn');
  } finally {
    pending.clear();
    try {
      child.stdin.end();
    } catch {}
    killTree(child);
    if (exitInfo === null && !spawnFailed) {
      // 给 SIGTERM 一个机会，避免 uvx / node 子进程残留。
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 300);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

/**
 * @param {object} record { transport, command, args, env, cwd, url, headers, timeoutMs }
 * @returns {Promise<{ok: true, tools: object[], protocolVersion: string, latencyMs: number, transport: string}>}
 */
export async function probeServer(record, { timeoutMs } = {}) {
  if (!record || typeof record !== 'object') throw new ProbeError('缺少服务器配置');
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : (record.timeoutMs ?? 20_000);
  if (record.transport === 'stdio') {
    if (!record.command) throw new ProbeError('stdio 类型缺少命令');
    return probeStdio(record, { timeoutMs: budget });
  }
  if (!record.url) throw new ProbeError('HTTP 类型缺少 URL');
  return probeHttp(record, { timeoutMs: budget });
}
