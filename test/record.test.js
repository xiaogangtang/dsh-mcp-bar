import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  DEFAULT_TIMEOUT_MS,
  normalizeServerInput,
  serverFromNativeConfig,
  serverRecordSchema,
} from '../lib/record.js';

test('normalizeServerInput：最小 stdio 配置补全默认值', () => {
  const { server, warnings } = normalizeServerInput({
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  });
  assert.deepEqual(warnings, []);
  assert.equal(server.serverName, 'filesystem');
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(server.env, {});
  assert.deepEqual(server.headers, {});
  assert.equal(server.url, undefined);
  assert.equal(server.cwd, undefined);
  assert.equal(server.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(server.enabled, true);
});

test('normalizeServerInput：根据 command 推断传输类型并解析参数文本', () => {
  const { server } = normalizeServerInput({
    serverName: 'fs',
    command: 'node',
    args: 'server.js --root "/tmp/my docs"',
    cwd: '  /tmp/work  ',
  });
  assert.equal(server.transport, 'stdio');
  assert.deepEqual(server.args, ['server.js', '--root', '/tmp/my docs']);
  assert.equal(server.cwd, '/tmp/work');
});

test('normalizeServerInput：HTTP 配置与环境变量、请求头', () => {
  const { server } = normalizeServerInput({
    name: 'remote',
    transport: 'http',
    url: '  https://example.com/mcp  ',
    headers: { Authorization: 'Bearer token', 'X-Retry': 2 },
    env: [{ name: 'IGNORED', value: 'yes' }],
    timeoutMs: '45000',
  });
  assert.equal(server.transport, 'streamable-http');
  assert.equal(server.url, 'https://example.com/mcp');
  assert.deepEqual(server.headers, { Authorization: 'Bearer token', 'X-Retry': '2' });
  assert.deepEqual(server.env, {}, 'HTTP 配置不保存 env');
  assert.deepEqual(server.args, []);
  assert.equal(server.command, undefined);
  assert.equal(server.timeoutMs, 45_000);
});

test('normalizeServerInput：类型别名与 SSE 提示', () => {
  const http = normalizeServerInput({ name: 'a', type: 'streamablehttp', url: 'http://localhost:3000' });
  assert.equal(http.server.transport, 'streamable-http');
  const sse = normalizeServerInput({ name: 'b', type: 'sse', url: 'http://localhost:3000/sse' });
  assert.equal(sse.server.transport, 'streamable-http');
  assert.deepEqual(sse.warnings, ['旧版 SSE 配置已按 Streamable HTTP 保存']);
});

test('normalizeServerInput：名称与缺失字段校验', () => {
  assert.throws(() => normalizeServerInput({ command: 'x' }), /请填写名称/);
  assert.throws(() => normalizeServerInput({ name: 'has space', command: 'x' }), /名称只能包含/);
  assert.throws(() => normalizeServerInput({ name: 'a'.repeat(33), command: 'x' }), /长度 1–32/);
  assert.throws(() => normalizeServerInput({ name: 'a' }), /URL/);
  assert.throws(() => normalizeServerInput({ name: 'a', transport: 'stdio' }), /需要填写命令/);
  assert.throws(() => normalizeServerInput(null), /必须是一个对象/);
  assert.throws(() => normalizeServerInput([]), /必须是一个对象/);
});

test('normalizeServerInput：URL 只允许 http/https', () => {
  assert.throws(() => normalizeServerInput({ name: 'a', transport: 'http', url: 'not a url' }), /URL 格式不正确/);
  assert.throws(() => normalizeServerInput({ name: 'a', transport: 'http', url: 'ftp://example.com' }), /只支持 http/);
  assert.throws(() => normalizeServerInput({ name: 'a', transport: 'http', url: 'file:///tmp/x' }), /只支持 http/);
});

test('normalizeServerInput：超时边界', () => {
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', timeoutMs: 1_000 }).server.timeoutMs, 1_000);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', timeoutMs: 1_800_000 }).server.timeoutMs, 1_800_000);
  assert.throws(() => normalizeServerInput({ name: 'a', command: 'x', timeoutMs: 999 }), /1000–1800000/);
  assert.throws(() => normalizeServerInput({ name: 'a', command: 'x', timeoutMs: 1_800_001 }), /1000–1800000/);
  assert.throws(() => normalizeServerInput({ name: 'a', command: 'x', timeoutMs: 1.5 }), /整数毫秒/);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', toolCallTimeoutMs: 2_000 }).server.timeoutMs, 2_000);
});

test('normalizeServerInput：enabled / disabled 兼容', () => {
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', enabled: false }).server.enabled, false);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', enabled: 'off' }).server.enabled, false);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', disabled: true }).server.enabled, false);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', disabled: false }).server.enabled, true);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', enabled: 'false' }).server.enabled, false);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', enabled: '0' }).server.enabled, false);
  assert.equal(normalizeServerInput({ name: 'a', command: 'x', enabled: 'yes' }).server.enabled, true);
});

test('normalizeServerInput：env 与 headers 校验', () => {
  const { server } = normalizeServerInput({
    name: 'a',
    command: 'x',
    env: { TOKEN: 'abc', RETRIES: 3, DEBUG: true, '': 'skip' },
  });
  assert.deepEqual(server.env, { TOKEN: 'abc', RETRIES: '3', DEBUG: 'true' });
  assert.throws(
    () => normalizeServerInput({ name: 'a', command: 'x', env: { BAD: { nested: true } } }),
    /环境变量「BAD」的值必须是字符串/,
  );
  assert.throws(() => normalizeServerInput({ name: 'a', command: 'x', env: 'FOO=bar' }), /必须是键值对/);
  const rows = normalizeServerInput({
    name: 'a',
    command: 'x',
    env: [{ key: 'A', value: 1 }, { name: 'B', value: 'two' }, { key: '', value: 'skip' }, null],
  });
  assert.deepEqual(rows.server.env, { A: '1', B: 'two' });
});

test('serverFromNativeConfig：可安全接管字面量配置', () => {
  const server = serverFromNativeConfig({
    serverName: 'linear',
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/sse',
    headers: { Authorization: 'Bearer x' },
    toolCallTimeoutMs: 30_000,
  }, 'native-linear');
  assert.equal(server.serverName, 'linear');
  assert.equal(server.transport, 'streamable-http');
  assert.deepEqual(server.headers, { Authorization: 'Bearer x' });
  assert.equal(server.timeoutMs, 30_000);
  assert.equal(server.nativeEntryId, 'native-linear');
});

test('serverFromNativeConfig：拒绝非字面量表达式', () => {
  assert.throws(
    () => serverFromNativeConfig({ serverName: 'x', command: 42 }, 'e'),
    /含非字面量表达式/,
  );
  assert.throws(
    () => serverFromNativeConfig({ serverName: 'x', command: 'npx', args: [undefined] }, 'e'),
    /args 含非字面量表达式/,
  );
  assert.throws(
    () => serverFromNativeConfig({ serverName: 'x', command: 'npx', env: { TOKEN: 42 } }, 'e'),
    /环境变量 TOKEN 含非字面量表达式/,
  );
  assert.throws(() => serverFromNativeConfig(null, 'e'), /没有可读取的配置/);
});

test('serverRecordSchema：接受规范化记录并拒绝坏字段', () => {
  const schema = serverRecordSchema(z);
  const base = {
    key: 's123',
    serverName: 'demo',
    transport: 'stdio',
    args: [],
    env: {},
    headers: {},
    timeoutMs: 60_000,
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  };
  assert.equal(schema.safeParse(base).success, true);
  assert.equal(schema.safeParse({ ...base, serverName: 'bad name' }).success, false);
  assert.equal(schema.safeParse({ ...base, transport: 'sse' }).success, false);
  assert.equal(schema.safeParse({ ...base, timeoutMs: 0 }).success, false);
  assert.equal(schema.safeParse({ ...base, key: '' }).success, false);
  assert.equal(schema.safeParse({ ...base, env: { A: 1 } }).success, false);
});
