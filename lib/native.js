/**
 * 把 loader 中的 mcp-client 条目按 serverName 合并。
 *
 * dsh-mcp-client 对同一 serverName 只保留一份注册，重复条目（例如 profile
 * 静态条目 + 旧连接器遗留的动态条目）中只有一份真正生效。列表按名称合并，
 * 避免把同一组工具重复计数，也让接管时能一并停用所有来源。
 */
export function groupNativeItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item.serverName !== 'string') continue;
    const existing = groups.get(item.serverName);
    if (existing) {
      existing.duplicates.push(item);
      continue;
    }
    groups.set(item.serverName, { ...item, duplicates: [] });
  }
  return [...groups.values()];
}

/** 组内所有 loader 条目 id（首项在前）。 */
export function nativeEntryIds(item) {
  return [...new Set([item?.id, ...(item?.duplicates ?? []).map((duplicate) => duplicate.id)].filter(Boolean))];
}
