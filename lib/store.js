/**
 * 持久化：`~/.dsh/storages/mcp_bar.json` 下的 servers 表。
 *
 * 只保存用户配置（含 env / headers 凭据），不保存运行状态。
 * 插件启动时按记录重建动态 mcp-client 条目，因此重启后仍然生效。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { serverRecordSchema } from './record.js';

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
