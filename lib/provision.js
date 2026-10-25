/**
 * 动态 mcp-client 条目：创建 / 更新 / 停用 / 移除。
 *
 * serverName 决定模型看到的工具前缀（mcp__<serverName>__*），
 * 只要名称不变，启停和改参数都不会改变工具名。
 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

export function entryIdFor(entryPrefix, key) {
  return `${entryPrefix}-${key}`;
}

export function isMcpClientEntry(entry) {
  const name = entry?.options?.name;
  if (typeof name !== 'string') return false;
  return name === MCP_CLIENT_PACKAGE || name.endsWith('/dsh-mcp-client');
}

export function buildEntryConfig(record) {
  const base = {
    serverName: record.serverName,
    toolCallTimeoutMs: record.timeoutMs,
    // 单个 Server 启动失败不应阻止整个 Harness 启动；失败会在面板中显示为未就绪。
    failOnStartupError: false,
  };
  if (record.transport === 'stdio') {
    const config = {
      ...base,
      transport: 'stdio',
      command: record.command,
      args: [...(record.args ?? [])],
      env: { ...(record.env ?? {}) },
    };
    if (record.cwd) config.cwd = record.cwd;
    return config;
  }
  return {
    ...base,
    transport: 'streamable-http',
    url: record.url,
    headers: { ...(record.headers ?? {}) },
  };
}

export function resolveEntry(ctx, id) {
  try {
    return ctx.loader.resolve(id);
  } catch {
    return undefined;
  }
}

/** 幂等 upsert；返回条目 id。 */
export async function upsertEntry(ctx, entryPrefix, record) {
  const id = entryIdFor(entryPrefix, record.key);
  const config = buildEntryConfig(record);
  const existing = resolveEntry(ctx, id);
  if (existing) {
    await ctx.loader.update(id, { config, disabled: record.enabled === false });
  } else {
    await ctx.loader.create({
      id,
      name: MCP_CLIENT_PACKAGE,
      config,
      disabled: record.enabled === false,
    });
  }
  return id;
}

export async function removeEntry(ctx, entryPrefix, record) {
  const id = entryIdFor(entryPrefix, record.key);
  if (resolveEntry(ctx, id)) await ctx.loader.remove(id);
  return id;
}

export async function setEntryDisabled(ctx, entryPrefix, record, disabled) {
  const id = entryIdFor(entryPrefix, record.key);
  if (!resolveEntry(ctx, id)) {
    return upsertEntry(ctx, entryPrefix, record);
  }
  await ctx.loader.update(id, { config: buildEntryConfig(record), disabled });
  return id;
}

/** 停用 profile 里的原生条目（只影响运行时，不改用户 YAML）。 */
export async function disableNativeEntry(ctx, entry) {
  if (!entry || entry.disabled === true) return;
  await ctx.loader.update(entry.id, { disabled: true });
}

/** 恢复原生条目。 */
export async function enableNativeEntry(ctx, entry) {
  if (!entry || entry.disabled !== true) return;
  await ctx.loader.update(entry.id, { disabled: false });
}
