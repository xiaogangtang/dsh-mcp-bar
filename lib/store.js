/**
 * 持久化：`~/.dsh/storages/mcp_bar.json` 下的 servers 表。
 *
 * 只保存用户配置（含 env / headers 凭据），不保存运行状态。
 * 插件启动时按记录重建动态 mcp-client 条目，因此重启后仍然生效。
 *
 * zod 的解析顺序：优先插件自己的 node_modules（开发 / 单测），缺失时回退到
 * 宿主内 dsh-storage-domain 自带的 zod。这样 clone 后不执行 npm install 也能
 * 直接安装运行，且不会因为本地 zod 版本与宿主不一致而漂移。
 */
import { createRequire } from 'node:module';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { serverRecordSchema } from './record.js';

function zodFromStorageDomain(requireFn) {
  // 宿主把 @deepseek-ai/* 注入给插件，但不会注入裸 zod；
  // 借已解析到的 storage-domain 模块路径去拿它依赖的 zod。
  const resolved = typeof requireFn === 'function'
    ? requireFn.resolve('@deepseek-ai/dsh-storage-domain/package.json')
    : import.meta.resolve('@deepseek-ai/dsh-storage-domain');
  return createRequire(resolved)('zod').z;
}

function loadZod() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('zod').z;
  } catch {
    // 依次尝试 ESM 解析与 CJS 解析两条路径找到宿主的 storage-domain。
    const attempts = [
      () => zodFromStorageDomain(),
      () => zodFromStorageDomain(localRequire),
    ];
    let lastError;
    for (const attempt of attempts) {
      try {
        return attempt();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`无法解析 zod：请在插件目录执行 npm install 后重试（${lastError instanceof Error ? lastError.message : lastError}）`);
  }
}

const z = loadZod();

export const serverDomainSpec = defineDomain({
  name: 'mcp_bar',
  version: 1,
  tables: {
    servers: domainTable(serverRecordSchema(z)),
  },
});

export class ServerStore {
  constructor(domain) {
    this.domain = domain;
    this.table = domain.tables.get('servers');
    if (!this.table) throw new Error('mcp-bar: 存储表 servers 不存在');
  }

  get(key) {
    return this.table.get(key);
  }

  async put(record) {
    await this.table.put(record.key, record);
    return record;
  }

  async delete(key) {
    return this.table.delete(key);
  }

  all() {
    return [...this.table.entries()].map(([, value]) => value);
  }
}
