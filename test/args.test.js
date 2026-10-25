import assert from 'node:assert/strict';
import test from 'node:test';
import { formatArgs, parseArgs } from '../lib/args.js';

test('parseArgs：空白分隔与空输入', () => {
  assert.deepEqual(parseArgs(''), []);
  assert.deepEqual(parseArgs('   \t\n '), []);
  assert.deepEqual(parseArgs(undefined), []);
  assert.deepEqual(parseArgs(null), []);
  assert.deepEqual(parseArgs('--transport stdio'), ['--transport', 'stdio']);
});

test('parseArgs：单引号与双引号保留空格', () => {
  assert.deepEqual(parseArgs('--path "/Users/me/My Docs" --name \'a b\''), [
    '--path',
    '/Users/me/My Docs',
    '--name',
    'a b',
  ]);
});

test('parseArgs：反斜杠转义与字面反斜杠', () => {
  assert.deepEqual(parseArgs('a\\ b c'), ['a b', 'c']);
  assert.deepEqual(parseArgs('"say \\"hi\\""'), ['say "hi"']);
  assert.deepEqual(parseArgs('C:\\Users\\me'), ['C:Usersme']);
  // 单引号内的反斜杠不转义（shell 语义）
  assert.deepEqual(parseArgs("'a\\b'"), ['a\\b']);
});

test('parseArgs：空字符串参数与转义结尾', () => {
  assert.deepEqual(parseArgs('"" second'), ['', 'second']);
  assert.deepEqual(parseArgs('tail\\'), ['tail\\']);
});

test('parseArgs：未闭合引号报错', () => {
  assert.throws(() => parseArgs('--path "unterminated'), /引号没有闭合/);
  assert.throws(() => parseArgs("'oops"), /引号没有闭合/);
});

test('formatArgs：需要时加引号并可回读', () => {
  assert.equal(formatArgs([]), '');
  assert.equal(formatArgs(['--flag', 'plain']), '--flag plain');
  assert.equal(formatArgs(['two words']), '"two words"');
  assert.equal(formatArgs(['']), '""');
  assert.equal(formatArgs(['say "hi"']), '"say \\"hi\\""');
  assert.equal(formatArgs(['a\\b']), '"a\\\\b"');

  const args = ['--path', '/Users/me/My Docs', 'quote"inside', "single'inside", '', 'a\\b'];
  assert.deepEqual(parseArgs(formatArgs(args)), args);
});
