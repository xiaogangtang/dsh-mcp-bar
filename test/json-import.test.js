import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpServersJson } from '../lib/json-import.js';

test('parseMcpServersJson：标准 mcpServers 包装', () => {
  const { servers, warnings } = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    },
  }));
  assert.deepEqual(warnings, []);
  assert.equal(servers.length, 2);
  const [filesystem, remote] = servers;
  assert.equal(filesystem.serverName, 'filesystem');
  assert.equal(filesystem.transport, 'stdio');
  assert.deepEqual(filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.equal(remote.serverName, 'remote');
  assert.equal(remote.transport, 'streamable-http');
  assert.deepEqual(remote.headers, { Authorization: 'Bearer token' });
});

test('parseMcpServersJson：servers 包装与 BOM', () => {
  const source = `\uFEFF${JSON.stringify({ servers: { a: { command: 'node', args: ['a.js'] } } })}`;
  const { servers } = parseMcpServersJson(source);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].serverName, 'a');
});

test('parseMcpServersJson：单条配置（含 name / serverName）', () => {
  const byName = parseMcpServersJson({ name: 'solo', command: 'uvx', args: 'mcp-server --flag' });
  assert.equal(byName.servers.length, 1);
  assert.equal(byName.servers[0].serverName, 'solo');
  assert.deepEqual(byName.servers[0].args, ['mcp-server', '--flag']);

  const byServerName = parseMcpServersJson({ serverName: 'solo2', url: 'http://127.0.0.1:3000' });
  assert.equal(byServerName.servers[0].serverName, 'solo2');
  assert.equal(byServerName.servers[0].transport, 'streamable-http');
});

test('parseMcpServersJson：数组与普通 map', () => {
  const list = parseMcpServersJson([
    { name: 'a', command: 'node' },
    { name: 'b', url: 'https://example.com/mcp' },
  ]);
  assert.deepEqual(list.servers.map((server) => server.serverName), ['a', 'b']);

  const map = parseMcpServersJson({
    a: { command: 'node' },
    b: { type: 'stdio', command: 'bun' },
  });
  assert.deepEqual(map.servers.map((server) => server.serverName), ['a', 'b']);
});

test('parseMcpServersJson：启停字段与超时别名', () => {
  const { servers } = parseMcpServersJson({
    mcpServers: {
      off1: { command: 'node', enabled: false },
      off2: { command: 'node', disabled: true },
      on1: { command: 'node', enable: true },
      timed: { command: 'node', timeoutMs: 12_000 },
      timed2: { command: 'node', toolCallTimeoutMs: 13_000 },
    },
  });
  const byName = Object.fromEntries(servers.map((server) => [server.serverName, server]));
  assert.equal(byName.off1.enabled, false);
  assert.equal(byName.off2.enabled, false);
  assert.equal(byName.on1.enabled, true);
  assert.equal(byName.timed.timeoutMs, 12_000);
  assert.equal(byName.timed2.timeoutMs, 13_000);
});

test('parseMcpServersJson：SSE 提示带 Server 名称', () => {
  const { warnings } = parseMcpServersJson({
    mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse' } },
  });
  assert.deepEqual(warnings, ['legacy: 旧版 SSE 配置已按 Streamable HTTP 保存']);
});

test('parseMcpServersJson：输入与结构错误', () => {
  assert.throws(() => parseMcpServersJson(''), /JSON 不能为空/);
  assert.throws(() => parseMcpServersJson('   '), /JSON 不能为空/);
  assert.throws(() => parseMcpServersJson('{oops'), /JSON 解析失败/);
  assert.throws(() => parseMcpServersJson('42'), /顶层必须是对象或数组/);
  assert.throws(() => parseMcpServersJson({ mcpServers: [] }), /mcpServers 必须是一个对象/);
  assert.throws(() => parseMcpServersJson({ servers: 'x' }), /servers 必须是一个对象/);
  assert.throws(() => parseMcpServersJson({}), /没有找到任何 MCP Server 配置/);
  assert.throws(() => parseMcpServersJson({ mcpServers: {} }), /没有找到任何 MCP Server 配置/);
  assert.throws(() => parseMcpServersJson([{}]), /第 1 项缺少 name/);
  assert.throws(() => parseMcpServersJson(['bad']), /第 1 项不是对象/);
  assert.throws(() => parseMcpServersJson({ mcpServers: { a: 'npx' } }), /「a」的配置必须是对象/);
});

test('parseMcpServersJson：名称重复与单条配置无效', () => {
  assert.throws(
    () => parseMcpServersJson([{ name: 'dup', command: 'a' }, { name: 'dup', command: 'b' }]),
    /名称「dup」在 JSON 中重复出现/,
  );
  assert.throws(
    () => parseMcpServersJson({ mcpServers: { 'bad name': { command: 'node' } } }),
    /「bad name」配置无效：名称只能包含/,
  );
  assert.throws(
    () => parseMcpServersJson({ mcpServers: { empty: { type: 'stdio' } } }),
    /「empty」配置无效：stdio 类型需要填写命令/,
  );
});
