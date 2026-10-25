import test from 'node:test';
import assert from 'node:assert/strict';
import { groupNativeItems, nativeEntryIds } from '../lib/native.js';

test('groupNativeItems：同名条目合并为一组，首项为主条目', () => {
  const items = [
    { id: 'mcp-a', serverName: 'alpha', config: { command: 'uvx' } },
    { id: 'mcp-b', serverName: 'beta', config: { command: 'uvx' } },
    { id: 'mcp-a2', serverName: 'alpha', config: { command: 'node' } },
  ];
  const groups = groupNativeItems(items);
  assert.equal(groups.length, 2);
  const alpha = groups.find((group) => group.serverName === 'alpha');
  assert.equal(alpha.id, 'mcp-a');
  assert.deepEqual(alpha.duplicates.map((duplicate) => duplicate.id), ['mcp-a2']);
  const beta = groups.find((group) => group.serverName === 'beta');
  assert.deepEqual(beta.duplicates, []);
});

test('nativeEntryIds：首项在前且去重', () => {
  const item = {
    id: 'mcp-a',
    duplicates: [{ id: 'mcp-a2' }, { id: 'mcp-a' }],
  };
  assert.deepEqual(nativeEntryIds(item), ['mcp-a', 'mcp-a2']);
  assert.deepEqual(nativeEntryIds(undefined), []);
});

test('groupNativeItems：忽略缺少 serverName 的条目', () => {
  const groups = groupNativeItems([{ id: 'x' }, null, { id: 'y', serverName: 'ok' }]);
  assert.deepEqual(groups.map((group) => group.serverName), ['ok']);
});
