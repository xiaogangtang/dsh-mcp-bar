import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEntryConfig,
  disableNativeEntry,
  enableNativeEntry,
  entryIdFor,
  isMcpClientEntry,
  removeEntry,
  resolveEntry,
  setEntryDisabled,
  upsertEntry,
} from '../lib/provision.js';

function fakeCtx() {
  const entries = new Map();
  const calls = [];
  return {
    entries,
    calls,
    loader: {
      entries: () => [...entries.values()],
      resolve: (id) => entries.get(id),
      create: async (item) => {
        calls.push(['create', item]);
        const entry = {
          id: item.id,
          options: { name: item.name, config: item.config },
          disabled: item.disabled,
        };
        entries.set(item.id, entry);
        return entry;
      },
      update: async (id, patch) => {
        calls.push(['update', id, patch]);
        const entry = entries.get(id);
        if (!entry) throw new Error(`missing ${id}`);
        if (patch.config !== undefined) entry.options = { ...entry.options, config: patch.config };
        if (patch.disabled !== undefined) entry.disabled = patch.disabled;
        return entry;
      },
      remove: async (id) => {
        calls.push(['remove', id]);
        entries.delete(id);
      },
    },
  };
}

const stdioRecord = {
  key: 's1',
  serverName: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server'],
  env: { TOKEN: 'x' },
  cwd: undefined,
  timeoutMs: 60_000,
  enabled: true,
};

const httpRecord = {
  key: 's2',
  serverName: 'remote',
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer y' },
  timeoutMs: 30_000,
  enabled: false,
};

test('entryIdFor / isMcpClientEntry', () => {
  assert.equal(entryIdFor('mcp-bar', 's1'), 'mcp-bar-s1');
  assert.equal(isMcpClientEntry({ options: { name: '@deepseek-ai/dsh-mcp-client' } }), true);
  assert.equal(isMcpClientEntry({ options: { name: 'vendor/dsh-mcp-client' } }), true);
  assert.equal(isMcpClientEntry({ options: { name: '@deepseek-ai/dsh-mcp-client-extra' } }), false);
  assert.equal(isMcpClientEntry({ options: {} }), false);
  assert.equal(isMcpClientEntry(null), false);
});

test('buildEntryConfig：stdio 复制参数与环境变量', () => {
  const config = buildEntryConfig(stdioRecord);
  assert.deepEqual(config, {
    serverName: 'filesystem',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    env: { TOKEN: 'x' },
  });
  assert.notEqual(config.args, stdioRecord.args);
  assert.notEqual(config.env, stdioRecord.env);
  assert.equal(buildEntryConfig({ ...stdioRecord, cwd: '/tmp/work' }).cwd, '/tmp/work');
  assert.equal('key' in config, false);
  assert.equal('enabled' in config, false);
});

test('buildEntryConfig：HTTP 复制请求头', () => {
  const config = buildEntryConfig(httpRecord);
  assert.deepEqual(config, {
    serverName: 'remote',
    toolCallTimeoutMs: 30_000,
    failOnStartupError: false,
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer y' },
  });
  assert.notEqual(config.headers, httpRecord.headers);
});

test('upsertEntry：首次创建、再次更新、停用状态', async () => {
  const ctx = fakeCtx();
  const id = await upsertEntry(ctx, 'mcp-bar', stdioRecord);
  assert.equal(id, 'mcp-bar-s1');
  assert.equal(ctx.calls[0][0], 'create');
  assert.equal(ctx.entries.get(id).disabled, false);

  const updated = await upsertEntry(ctx, 'mcp-bar', { ...stdioRecord, args: ['--new'], enabled: false });
  assert.equal(updated, id);
  assert.deepEqual(ctx.calls[1], ['update', id, { config: buildEntryConfig({ ...stdioRecord, args: ['--new'] }), disabled: true }]);
  assert.deepEqual(ctx.entries.get(id).options.config.args, ['--new']);
  assert.equal(ctx.entries.get(id).disabled, true);
});

test('removeEntry / resolveEntry', async () => {
  const ctx = fakeCtx();
  const failing = { loader: { resolve: () => { throw new Error('boom'); } } };
  assert.equal(resolveEntry(failing, 'x'), undefined);
  assert.equal(await removeEntry(ctx, 'mcp-bar', stdioRecord), 'mcp-bar-s1');
  assert.equal(ctx.calls.length, 0, '不存在的条目不应触发 remove');

  await upsertEntry(ctx, 'mcp-bar', stdioRecord);
  assert.equal(resolveEntry(ctx, 'mcp-bar-s1').id, 'mcp-bar-s1');
  await removeEntry(ctx, 'mcp-bar', stdioRecord);
  assert.equal(ctx.entries.has('mcp-bar-s1'), false);
});

test('setEntryDisabled：缺失时创建，存在时更新', async () => {
  const ctx = fakeCtx();
  await setEntryDisabled(ctx, 'mcp-bar', httpRecord, true);
  assert.equal(ctx.calls[0][0], 'create');
  assert.equal(ctx.entries.get('mcp-bar-s2').disabled, true);

  await setEntryDisabled(ctx, 'mcp-bar', { ...httpRecord, url: 'https://example.com/v2' }, false);
  assert.equal(ctx.calls[1][0], 'update');
  assert.equal(ctx.calls[1][2].disabled, false);
  assert.equal(ctx.entries.get('mcp-bar-s2').options.config.url, 'https://example.com/v2');
});

test('disableNativeEntry / enableNativeEntry：幂等且忽略空条目', async () => {
  const ctx = fakeCtx();
  ctx.entries.set('native-a', { id: 'native-a', disabled: false, options: { name: '@deepseek-ai/dsh-mcp-client' } });
  await disableNativeEntry(ctx, null);
  await disableNativeEntry(ctx, { id: 'native-a', disabled: true });
  assert.equal(ctx.calls.length, 0);

  await disableNativeEntry(ctx, { id: 'native-a', disabled: false });
  assert.deepEqual(ctx.calls[0], ['update', 'native-a', { disabled: true }]);
  assert.equal(ctx.entries.get('native-a').disabled, true);

  await enableNativeEntry(ctx, { id: 'native-a', disabled: false });
  assert.equal(ctx.calls.length, 1, '已启用时不应重复更新');
  await enableNativeEntry(ctx, { id: 'native-a', disabled: true });
  assert.deepEqual(ctx.calls[1], ['update', 'native-a', { disabled: false }]);
  assert.equal(ctx.entries.get('native-a').disabled, false);
});
