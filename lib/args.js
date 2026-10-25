/**
 * 参数字符串 ↔ argv 数组。
 *
 * 表单里的「参数（空格分隔）」看起来像 shell，但这里**不执行 shell**：
 * 只做引号与反斜杠转义解析，避免用户输入被解释成命令。支持：
 *   --flag  "two words"  'single'  a\ b
 */
export function parseArgs(text) {
  if (text === undefined || text === null) return [];
  const source = String(text);
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let started = false;

  for (const ch of source) {
    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (escaped) current += '\\';
  if (quote !== null) throw new Error('参数里的引号没有闭合');
  if (started) args.push(current);
  return args;
}

/** argv → 可读的单行参数字符串（需要时加双引号）。 */
export function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return '';
  return args.map((arg) => {
    const value = String(arg);
    if (value === '') return '""';
    if (!/[\s"'\\]/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(' ');
}
