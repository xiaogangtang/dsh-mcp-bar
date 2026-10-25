import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { probeServer, ProbeError } from '../lib/probe.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function readJson(req) {
  let source = '';
  req.setEncoding('utf8');
  for await (const chunk of req) source += chunk;
  return source ? JSON.parse(source) : {};
}

function sendJson(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function httpRecord(url, overrides = {}) {
  return { transport: 'streamable-http', url, headers: { 'x-test': 'yes' }, ...overrides };
}

test('probeServer：HTTP initialize → initialized → tools/list 分页，并清理会话', async () => {
  const seen = [];
  let deleted = 0;
  const mock = await listen(async (req, res) => {
    seen.push({ method: req.method, headers: req.headers });
    if (req.method === 'DELETE') {
      deleted += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    const body = await readJson(req);
    if (body.method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
      }, { 'mcp-session-id': 'sess-1' });
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === 'tools/list') {
      if (!body.params?.cursor) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
        });
      } else {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'sum', title: 'Sum', input_schema: { type: 'object' } }] },
        });
      }
      return;
    }
    sendJson(res, 400, { jsonrpc: '2.0', id: body.id, error: { message: 'unexpected' } });
  });

  try {
    const result = await probeServer(httpRecord(mock.url), { timeoutMs: 2_000 });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'streamable-http');
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.sessionful, true);
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0].name, 'echo');
    assert.equal(result.tools[0].description, 'echo back');
    assert.deepEqual(result.tools[0].inputSchema, { type: 'object' });
    assert.equal(result.tools[1].title, 'Sum');
    assert.deepEqual(result.tools[1].inputSchema, { type: 'object' });
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);

    const init = seen[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-test'], 'yes');
    assert.equal(init.headers['mcp-protocol-version'], undefined, 'initialize 不应带协议版本头');
    const initialized = seen[1];
    assert.equal(initialized.headers['mcp-session-id'], 'sess-1');
    assert.equal(initialized.headers['mcp-protocol-version'], '2025-06-18');
    const secondPage = seen[3];
    assert.equal(secondPage.headers['mcp-session-id'], 'sess-1');
    assert.equal(deleted, 1);
  } finally {
    await mock.close();
  }
});

test('probeServer：HTTP SSE 响应与缺失 protocolVersion 回退', async () => {
  const mock = await listen(async (req, res) => {
    const body = await readJson(req);
    if (body.method === 'initialize') {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { capabilities: {}, serverInfo: { name: 'sse', version: '1' } },
      });
      const text = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: ${payload}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(text);
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: [] } });
  });

  try {
    const result = await probeServer(httpRecord(mock.url), { timeoutMs: 2_000 });
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.sessionful, false);
    assert.deepEqual(result.tools, []);
  } finally {
    await mock.close();
  }
});

test('probeServer：HTTP 401/403 归类为 auth', async () => {
  for (const status of [401, 403]) {
    const mock = await listen((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    });
    try {
      await assert.rejects(
        probeServer(httpRecord(mock.url), { timeoutMs: 2_000 }),
        (error) => error instanceof ProbeError && error.kind === 'auth' && /HTTP 401|HTTP 403/.test(error.message),
      );
    } finally {
      await mock.close();
    }
  }
});

test('probeServer：JSON-RPC error 映射协议/鉴权错误', async () => {
  const protocolMock = await listen(async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { message: 'method not found' } });
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(protocolMock.url), { timeoutMs: 2_000 }),
      (error) => error instanceof ProbeError && error.kind === 'protocol' && /method not found/.test(error.message),
    );
  } finally {
    await protocolMock.close();
  }

  const authMock = await listen(async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { message: 'invalid token supplied' } });
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(authMock.url), { timeoutMs: 2_000 }),
      (error) => error instanceof ProbeError && error.kind === 'auth',
    );
  } finally {
    await authMock.close();
  }
});

test('probeServer：HTTP 状态码、initialize 结果与错误分页', async () => {
  const failing = await listen((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server exploded');
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(failing.url), { timeoutMs: 2_000 }),
      (error) => error instanceof ProbeError && error.kind === 'http' && /HTTP 500/.test(error.message),
    );
  } finally {
    await failing.close();
  }

  const invalid = await listen(async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: null });
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(invalid.url), { timeoutMs: 2_000 }),
      (error) => error instanceof ProbeError && error.kind === 'protocol' && /initialize/.test(error.message),
    );
  } finally {
    await invalid.close();
  }

  const looping = await listen(async (req, res) => {
    const body = await readJson(req);
    if (body.method === 'initialize') {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    } else if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
    } else {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: 'same' } });
    }
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(looping.url), { timeoutMs: 2_000 }),
      (error) => error instanceof ProbeError && /重复分页游标/.test(error.message),
    );
  } finally {
    await looping.close();
  }
});

test('probeServer：HTTP 网络错误与超时', async () => {
  await assert.rejects(
    probeServer(httpRecord('http://127.0.0.1:1/mcp'), { timeoutMs: 500 }),
    (error) => error instanceof ProbeError && error.kind === 'network',
  );

  const slow = await listen((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      } catch {}
    }, 400).unref?.();
  });
  try {
    await assert.rejects(
      probeServer(httpRecord(slow.url), { timeoutMs: 100 }),
      (error) => error instanceof ProbeError && error.kind === 'timeout',
    );
  } finally {
    await slow.close();
  }
});

function stdioRecord(args, overrides = {}) {
  return {
    transport: 'stdio',
    command: process.execPath,
    args,
    timeoutMs: 3_000,
    ...overrides,
  };
}

const NEWLINE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' },
    } }) + '\\n');
  } else if (message.method === 'tools/list') {
    process.stdout.write('not json, should be ignored\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }],
    } }) + '\\n');
  }
});
`;

const CONTENT_LENGTH_SERVER = `
const readline = require('node:readline');
function send(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'framed' }] } });
  }
});
`;

test('probeServer：stdio 换行帧与忽略非 JSON 日志', async () => {
  const result = await probeServer(stdioRecord(['-e', NEWLINE_SERVER]), { timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.equal(result.transport, 'stdio');
  assert.equal(result.sessionful, false);
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, 'echo');
  assert.deepEqual(result.tools[0].inputSchema, { type: 'object' });
});

test('probeServer：stdio Content-Length 帧', async () => {
  const result = await probeServer(stdioRecord(['-e', CONTENT_LENGTH_SERVER]), { timeoutMs: 5_000 });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['framed']);
});

test('probeServer：stdio 命令不存在 / 进程提前退出 / 超时', async () => {
  await assert.rejects(
    probeServer(stdioRecord([], { command: '__mcp_bar_missing_command__' }), { timeoutMs: 2_000 }),
    (error) => error instanceof ProbeError && error.kind === 'spawn' && /找不到命令/.test(error.message),
  );

  await assert.rejects(
    probeServer(stdioRecord(['-e', 'process.exit(3)']), { timeoutMs: 2_000 }),
    (error) => error instanceof ProbeError && error.kind === 'spawn' && /进程已退出/.test(error.message),
  );

  await assert.rejects(
    probeServer(stdioRecord(['-e', 'setInterval(() => {}, 1000)']), { timeoutMs: 150 }),
    (error) => error instanceof ProbeError && error.kind === 'timeout',
  );
});

test('probeServer：配置校验', async () => {
  await assert.rejects(probeServer(null), (error) => error instanceof ProbeError && /缺少服务器配置/.test(error.message));
  await assert.rejects(probeServer({ transport: 'stdio' }), (error) => /缺少命令/.test(error.message));
  await assert.rejects(probeServer({ transport: 'streamable-http' }), (error) => /缺少 URL/.test(error.message));
});
