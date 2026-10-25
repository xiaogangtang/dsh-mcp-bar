/**
 * MCP Bar —— DeepSeek Harness 的 MCP 管理插件（宿主半区）。
 *
 * 解决的问题：DSH 原生 MCP 配置写在 `cordis.patch.yml` 里，改一条要重启、
 * 看状态要翻日志。MCP Bar 用侧边栏里的完整管理面板接管这件事：
 *   - 表单 / JSON 新建，启停、编辑、删除、搜索
 *   - 连接测试（initialize + tools/list）与工具查看
 *   - 记录持久化，启动时自动重建动态 mcp-client 条目
 *   - 可视化接管 profile 中已有的原生 mcp-client 条目
 *
 * 不内置连接器目录，不依赖 dsh-mcp-connector。
 */
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { ServerStore, serverDomainSpec } from './store.js';
import { normalizeServerInput, serverFromNativeConfig } from './record.js';
import { parseMcpServersJson } from './json-import.js';
import { probeServer, ProbeError } from './probe.js';
import {
  disableNativeEntry,
  enableNativeEntry,
  entryIdFor,
  isMcpClientEntry,
  removeEntry,
  resolveEntry,
  setEntryDisabled,
  upsertEntry,
} from './provision.js';
import { injectWebRoutes } from './web.js';
import { formatArgs } from './args.js';
import { groupNativeItems, nativeEntryIds } from './native.js';

export const name = 'mcp-bar';
export const inject = ['tools', 'storageDomain', 'loader'];

export const Config = z.object({
  /** 本插件托管的动态条目 id 前缀。 */
  entryPrefix: z.string().default('mcp-bar'),
  /** 探测超时（initialize + tools/list）。 */
  probeTimeoutMs: z.number().default(20_000),
});

const PROVISION_WAIT_MS = 15_000;
const TAKEOVER_WAIT_MS = 15_000;

function now() {
  return Date.now();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizePrefix(value) {
  const cleaned = String(value ?? 'mcp-bar').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'mcp-bar';
}

function publicTool(schema, serverName) {
  const prefix = `mcp__${serverName}__`;
  const publicName = String(schema.name);
  const rawName = publicName.startsWith(prefix) ? publicName.slice(prefix.length) : publicName;
  return {
    name: rawName,
    publicName,
    title: typeof schema.title === 'string' ? schema.title : rawName,
    description: typeof schema.description === 'string' ? schema.description : '',
    inputSchema: schema.parameters && typeof schema.parameters === 'object' ? schema.parameters : {},
  };
}

function toolsToPublic(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: String(tool.name ?? ''),
    publicName: String(tool.name ?? ''),
    title: tool.title || String(tool.name ?? ''),
    description: tool.description || '',
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {},
  }));
}

function configSummary(record) {
  if (record.transport === 'stdio') {
    return [record.command, formatArgs(record.args)].filter(Boolean).join(' ');
  }
  return record.url ?? '';
}

function environmentKeys(record) {
  return Object.keys(record.env ?? {});
}

function waitWithin(task, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
    timer.unref?.();
  });
  return Promise.race([
    task.then(
      () => ({ settled: true }),
      (error) => ({ settled: true, error }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export async function apply(ctx, config) {
  const logger = ctx.logger('mcp-bar');
  const entryPrefix = normalizePrefix(config?.entryPrefix);
  const probeTimeoutMs = Number(config?.probeTimeoutMs) > 0 ? Number(config.probeTimeoutMs) : 20_000;

  const domain = await ctx.storageDomain.open(serverDomainSpec);
  ctx.effect(() => () => {
    domain.close().catch((error) => logger.warn(`domain close failed: ${errorMessage(error)}`));
  });
  const store = new ServerStore(domain);

  /** key -> { message, at }，只保存运行期错误，不落盘。 */
  const provisionErrors = new Map();

  function findRecord(key) {
    return store.get(key);
  }

  function records() {
    return store.all();
  }

  function ourEntryId(key) {
    return entryIdFor(entryPrefix, key);
  }

  /** 记录接管时登记的全部原生条目 id（兼容只有 nativeEntryId 的旧记录）。 */
  function recordNativeEntryIds(record) {
    const ids = Array.isArray(record?.nativeEntryIds) ? record.nativeEntryIds : [];
    return [...new Set([...ids, record?.nativeEntryId].filter(Boolean))];
  }

  function allNativeItems() {
    const owned = records();
    const ownedNames = new Set(owned.map((record) => record.serverName));
    const suppressed = new Set(owned.flatMap((record) => recordNativeEntryIds(record)));
    const items = [];
    for (const entry of ctx.loader.entries()) {
      if (!isMcpClientEntry(entry)) continue;
      if (entry.id.startsWith(`${entryPrefix}-`)) continue;
      if (suppressed.has(entry.id)) continue;
      const entryConfig = entry.options?.config;
      if (!isObject(entryConfig) || typeof entryConfig.serverName !== 'string') continue;
      if (ownedNames.has(entryConfig.serverName)) continue;
      items.push({ entry, config: entryConfig, id: entry.id, serverName: entryConfig.serverName });
    }
    return items;
  }

  /** 同一 serverName 在 loader 中只应出现一次；重复来源合并为一条记录展示。 */
  function listNativeItems() {
    return groupNativeItems(allNativeItems());
  }

  function toolMapFor(serverNames) {
    const names = [...new Set(serverNames)].filter((name) => typeof name === 'string' && name !== '');
    const map = new Map(names.map((serverName) => [serverName, []]));
    if (names.length === 0) return map;
    let schemas = [];
    try {
      schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
    } catch (error) {
      logger.warn(`read tool schemas failed: ${errorMessage(error)}`);
      return map;
    }
    for (const schema of schemas) {
      if (!schema || typeof schema.name !== 'string') continue;
      for (const serverName of names) {
        const prefix = `mcp__${serverName}__`;
        if (!schema.name.startsWith(prefix)) continue;
        map.get(serverName).push(publicTool(schema, serverName));
        break;
      }
    }
    return map;
  }

  function entryState(entry) {
    if (!entry) return 'missing';
    try {
      return entry.disabled === true ? 'disabled' : 'enabled';
    } catch {
      return 'unknown';
    }
  }

  function stateOf(enabled, toolCount, entry, error) {
    if (!enabled) return 'disabled';
    if (error) return 'error';
    if (toolCount > 0) return 'connected';
    if (!entry) return 'error';
    return entryState(entry) === 'enabled' ? 'pending' : 'disabled';
  }

  function serverView(record, toolsByServer, entry) {
    const tools = toolsByServer.get(record.serverName) ?? [];
    const error = provisionErrors.get(record.key);
    const state = stateOf(record.enabled !== false, tools.length, entry ?? resolveEntry(ctx, ourEntryId(record.key)), error);
    return {
      id: record.key,
      key: record.key,
      name: record.serverName,
      serverName: record.serverName,
      origin: 'bar',
      originLabel: 'MCP Bar',
      transport: record.transport,
      transportLabel: record.transport === 'stdio' ? 'stdio' : 'HTTP',
      endpoint: configSummary(record),
      enabled: record.enabled !== false,
      state,
      toolCount: tools.length,
      error: error?.message,
      canEdit: true,
      canTest: true,
      canTakeover: false,
      canRemove: true,
      nativeEntryId: record.nativeEntryId,
      timeoutMs: record.timeoutMs,
      envKeys: environmentKeys(record),
      updatedAt: record.updatedAt,
    };
  }

  function nativeView(item, toolsByServer) {
    const tools = toolsByServer.get(item.serverName) ?? [];
    const enabled = entryState(item.entry) === 'enabled';
    const state = stateOf(enabled, tools.length, item.entry);
    return {
      id: `native:${item.id}`,
      key: `native:${item.id}`,
      name: item.serverName,
      serverName: item.serverName,
      origin: 'profile',
      originLabel: 'profile 配置',
      transport: item.config.transport === 'stdio' ? 'stdio' : 'streamable-http',
      transportLabel: item.config.transport === 'stdio' ? 'stdio' : 'HTTP',
      endpoint: item.config.transport === 'stdio'
        ? [item.config.command, formatArgs(item.config.args)].filter(Boolean).join(' ')
        : (item.config.url ?? ''),
      enabled,
      state,
      toolCount: tools.length,
      error: undefined,
      canEdit: false,
      canTest: true,
      canTakeover: true,
      canRemove: false,
      nativeEntryId: item.id,
      duplicateCount: 1 + (item.duplicates?.length ?? 0),
      timeoutMs: item.config.toolCallTimeoutMs,
      envKeys: Object.keys(item.config.env ?? {}),
      updatedAt: undefined,
    };
  }

  function buildStatus() {
    const own = records();
    const natives = listNativeItems();
    const names = [...own.map((record) => record.serverName), ...natives.map((item) => item.serverName)];
    const toolsByServer = toolMapFor(names);
    const servers = [
      ...own.map((record) => serverView(record, toolsByServer)),
      ...natives.map((item) => nativeView(item, toolsByServer)),
    ];
    const toolNames = new Set();
    for (const tools of toolsByServer.values()) {
      for (const tool of tools) toolNames.add(tool.publicName);
    }
    const counts = {
      total: servers.length,
      owned: own.length,
      native: natives.length,
      duplicateNative: natives.reduce((sum, item) => sum + (item.duplicates?.length ?? 0), 0),
      enabled: servers.filter((server) => server.enabled).length,
      connected: servers.filter((server) => server.state === 'connected').length,
      pending: servers.filter((server) => server.state === 'pending').length,
      error: servers.filter((server) => server.state === 'error').length,
      disabled: servers.filter((server) => server.state === 'disabled').length,
      tools: toolNames.size,
    };
    return { servers, counts, generatedAt: now() };
  }

  function findNative(entryId) {
    if (typeof entryId !== 'string' || entryId === '') return undefined;
    const direct = resolveEntry(ctx, entryId);
    if (direct && isMcpClientEntry(direct)) {
      const config = direct.options?.config ?? {};
      const group = listNativeItems().find((item) => item.serverName === config.serverName);
      return {
        entry: direct,
        config,
        id: direct.id,
        serverName: config.serverName,
        duplicates: group?.duplicates ?? [],
      };
    }
    return allNativeItems().find((item) => item.id === entryId);
  }

  function assertNameAvailable(serverName, { excludeKey, ignoreNativeEntryId } = {}) {
    const clash = records().find((record) => record.serverName === serverName && record.key !== excludeKey);
    if (clash) throw new Error(`名称「${serverName}」已经被另一条 MCP Bar 配置使用`);
    const nativeClash = listNativeItems().find((item) => item.serverName === serverName && item.id !== ignoreNativeEntryId);
    if (nativeClash) {
      throw new Error(`profile 中已有同名 Server「${serverName}」，请先在列表中接管它，或换一个名称`);
    }
  }

  function newKey() {
    for (;;) {
      const key = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      if (!store.get(key)) return key;
    }
  }

  function toRecord(server, key, extra = {}) {
    return {
      ...server,
      ...extra,
      key,
      createdAt: extra.createdAt ?? now(),
      updatedAt: now(),
    };
  }

  async function provisionRecord(record, waitMs = PROVISION_WAIT_MS) {
    const task = upsertEntry(ctx, entryPrefix, record);
    // 超时后任务仍可能失败；保留错误供下一次状态查询显示。
    task.catch((error) => {
      provisionErrors.set(record.key, { message: errorMessage(error), at: now() });
    });
    const result = await waitWithin(task, waitMs);
    if (result.error) {
      provisionErrors.set(record.key, { message: errorMessage(result.error), at: now() });
      return result;
    }
    if (result.settled) provisionErrors.delete(record.key);
    return result;
  }

  async function bootstrap() {
    const own = records();
    // 先停用被接管的原生条目（含同名的多个来源），避免启动期重复注册工具。
    for (const record of own) {
      const ids = recordNativeEntryIds(record);
      if (ids.length === 0) continue;
      let entries = ids.map((id) => resolveEntry(ctx, id)).filter(Boolean);
      if (entries.length === 0) {
        entries = [...ctx.loader.entries()].filter((candidate) => (
          isMcpClientEntry(candidate)
          && !candidate.id.startsWith(`${entryPrefix}-`)
          && candidate.options?.config?.serverName === record.serverName
        ));
      }
      for (const entry of entries) {
        await disableNativeEntry(ctx, entry).catch((error) => {
          logger.warn(`disable native entry for ${record.serverName} failed: ${errorMessage(error)}`);
        });
      }
    }
    await Promise.all(own.map((record) => provisionRecord(record).catch((error) => {
      provisionErrors.set(record.key, { message: errorMessage(error), at: now() });
    })));
    if (own.length > 0) logger.info(`restored ${own.length} MCP server(s)`);
  }

  async function requireRecord(id) {
    const record = findRecord(id);
    if (!record) throw new Error('这条 MCP Server 不存在，可能已被删除');
    return record;
  }

  async function takeoverOne(item) {
    if (!item) throw new Error('找不到要接管的 profile Server');
    assertNameAvailable(item.serverName, { ignoreNativeEntryId: item.id });
    const server = serverFromNativeConfig(item.config, item.id);
    const key = newKey();
    const record = toRecord(server, key, {
      nativeEntryId: item.id,
      nativeEntryIds: nativeEntryIds(item),
    });
    const disabled = [];
    for (const source of [item, ...(item.duplicates ?? [])]) {
      await disableNativeEntry(ctx, source.entry).catch(() => {});
      disabled.push(source.entry);
    }
    try {
      await store.put(record);
      const result = await provisionRecord(record, TAKEOVER_WAIT_MS);
      if (result.error) throw result.error;
      return { ok: true, server: serverView(record, toolMapFor([record.serverName])), warning: result.settled ? undefined : '条目已保存，仍在后台连接' };
    } catch (error) {
      await store.delete(key).catch(() => {});
      for (const entry of disabled) await enableNativeEntry(ctx, entry).catch(() => {});
      throw error;
    }
  }

  const api = {
    async status() {
      return buildStatus();
    },

    async detail(params = {}) {
      const id = String(params.id ?? '');
      if (id.startsWith('native:')) {
        const entryId = id.slice('native:'.length);
        const item = findNative(entryId);
        if (!item) throw new Error('profile 中的这条 Server 已不存在');
        const toolsByServer = toolMapFor([item.serverName]);
        const view = nativeView(item, toolsByServer);
        return {
          server: view,
          tools: toolsByServer.get(item.serverName) ?? [],
          config: item.config,
          rawConfig: true,
        };
      }
      const record = await requireRecord(id);
      const toolsByServer = toolMapFor([record.serverName]);
      return {
        server: serverView(record, toolsByServer),
        tools: toolsByServer.get(record.serverName) ?? [],
        config: record,
        rawConfig: false,
      };
    },

    async create(params = {}) {
      const { server, warnings } = normalizeServerInput(params.server ?? {});
      assertNameAvailable(server.serverName);
      const record = toRecord(server, newKey());
      await store.put(record);
      provisionErrors.delete(record.key);
      const result = await provisionRecord(record);
      if (result.error) {
        await store.delete(record.key).catch(() => {});
        throw new Error(`保存失败：${errorMessage(result.error)}`);
      }
      const toolsByServer = toolMapFor([record.serverName]);
      return {
        server: serverView(record, toolsByServer),
        warnings: [
          ...warnings,
          ...(result.settled ? [] : ['配置已保存，连接仍在后台进行，稍后可在列表中查看状态']),
        ],
      };
    },

    async update(params = {}) {
      const record = await requireRecord(params.id);
      const { server, warnings } = normalizeServerInput(params.server ?? {});
      assertNameAvailable(server.serverName, { excludeKey: record.key });
      const next = toRecord(server, record.key, { createdAt: record.createdAt, nativeEntryId: record.nativeEntryId });
      await store.put(next);
      provisionErrors.delete(next.key);
      const result = await provisionRecord(next);
      const toolsByServer = toolMapFor([next.serverName]);
      return {
        server: serverView(next, toolsByServer),
        warnings: [
          ...warnings,
          ...(result.error ? [`已保存，但重新连接失败：${errorMessage(result.error)}`] : []),
          ...(result.settled || result.error ? [] : ['配置已保存，连接仍在后台进行']),
        ],
      };
    },

    async remove(params = {}) {
      const record = await requireRecord(params.id);
      await removeEntry(ctx, entryPrefix, record).catch((error) => {
        logger.warn(`remove entry failed: ${errorMessage(error)}`);
      });
      await store.delete(record.key);
      provisionErrors.delete(record.key);
      let restoredNative = false;
      for (const id of recordNativeEntryIds(record)) {
        const entry = resolveEntry(ctx, id);
        if (!entry) continue;
        await enableNativeEntry(ctx, entry).catch((error) => {
          logger.warn(`restore native entry failed: ${errorMessage(error)}`);
        });
        restoredNative = true;
      }
      return { removed: true, restoredNative };
    },

    async setEnabled(params = {}) {
      const record = await requireRecord(params.id);
      const enabled = params.enabled !== false;
      const next = { ...record, enabled, updatedAt: now() };
      await store.put(next);
      if (!enabled) {
        provisionErrors.delete(next.key);
        const result = await waitWithin(setEntryDisabled(ctx, entryPrefix, next, true), PROVISION_WAIT_MS);
        if (result.error) {
          provisionErrors.set(next.key, { message: errorMessage(result.error), at: now() });
          throw new Error(`停用失败：${errorMessage(result.error)}`);
        }
      } else {
        provisionErrors.delete(next.key);
        const result = await provisionRecord(next);
        if (result.error) throw new Error(`启用失败：${errorMessage(result.error)}`);
      }
      const toolsByServer = toolMapFor([next.serverName]);
      const entry = resolveEntry(ctx, ourEntryId(next.key));
      return { server: serverView(next, toolsByServer, entry) };
    },

    async probe(params = {}) {
      let target;
      let label;
      if (params.server) {
        const normalized = normalizeServerInput(params.server).server;
        target = normalized;
        label = normalized.serverName;
      } else if (typeof params.id === 'string' && params.id.startsWith('native:')) {
        const item = findNative(params.id.slice('native:'.length));
        if (!item) throw new Error('profile 中的这条 Server 已不存在');
        target = serverFromNativeConfig(item.config, item.id);
        label = target.serverName;
      } else {
        const record = await requireRecord(params.id);
        target = record;
        label = record.serverName;
      }
      const result = await probeServer(target, { timeoutMs: probeTimeoutMs });
      return {
        serverName: label,
        transport: result.transport,
        protocolVersion: result.protocolVersion,
        latencyMs: result.latencyMs,
        toolCount: result.tools.length,
        tools: toolsToPublic(result.tools),
      };
    },

    async importJson(params = {}) {
      const { servers, warnings } = parseMcpServersJson(params.json);
      for (const server of servers) assertNameAvailable(server.serverName);
      const created = [];
      const pendingRecords = [];
      for (const server of servers) {
        const record = toRecord(server, newKey());
        await store.put(record);
        provisionErrors.delete(record.key);
        pendingRecords.push(record);
      }
      const results = await Promise.all(pendingRecords.map(async (record) => {
        const result = await provisionRecord(record, PROVISION_WAIT_MS);
        return { record, result };
      }));
      for (const { record, result } of results) {
        created.push({
          server: serverView(record, toolMapFor([record.serverName])),
          warning: result.error
            ? `已保存，但连接失败：${errorMessage(result.error)}`
            : result.settled ? undefined : '已保存，连接仍在后台进行',
        });
      }
      return { created, warnings };
    },

    async takeover(params = {}) {
      const item = findNative(params.entryId);
      return takeoverOne(item);
    },

    async takeoverAll() {
      const items = listNativeItems();
      const created = [];
      const failed = [];
      for (const item of items) {
        try {
          const result = await takeoverOne(item);
          created.push({ name: item.serverName, warning: result.warning });
        } catch (error) {
          failed.push({ name: item.serverName, message: errorMessage(error) });
        }
      }
      return { created, failed, total: items.length };
    },
  };

  injectWebRoutes(ctx, api, { logger });

  void bootstrap().catch((error) => logger.warn(`bootstrap failed: ${errorMessage(error)}`));
}

export { ProbeError };
