# MCP Bar

DeepSeek Harness 的 MCP 管理插件。它把 MCP Server 的日常管理搬到了输入框上方：一条常驻状态栏，加上一个完整的管理面板。新建、启停、改配置、删条目、测连接、看工具，都不需要再改 `cordis.patch.yml` 或翻日志。

MCP Bar 是独立插件，不依赖 `dsh-mcp-connector`。两者同时管理同名 Server 会重复注册工具，装了这个就可以卸掉那个。

## 能力

- **状态栏**：输入框上方显示总数、已连接数、工具数；有异常或等待连接时用颜色提示。点击直接打开面板。
- **服务器列表**：合并展示 MCP Bar 自己管理的 Server 和 profile 中已有的原生 `mcp-client` 条目，带状态圆点、传输方式、地址 / 命令、工具数。支持搜索、启停、编辑、删除。
- **新建**：表单和 JSON 两种方式。表单覆盖名称、类型（stdio / Streamable HTTP）、超时、协议、命令与参数、URL 与请求头、环境变量、工作目录。JSON 兼容 `{"mcpServers": {...}}`、裸 map、单条对象和数组，以及 Claude / Cursor 风格的 `command + args`、`url`、`disabled`、`toolCallTimeoutMs` 字段。
- **连接测试**：走 `initialize` → `notifications/initialized` → `tools/list`，支持 stdio（换行帧 / Content-Length 帧）与 Streamable HTTP（含 SSE 响应、分页、会话清理）。失败时区分协议、鉴权、HTTP、超时、网络与进程启动错误。
- **工具查看**：列出一个 Server 暴露的工具、描述和输入 schema。
- **持久化**：记录保存在 DSH 的 storage domain `mcp_bar`。启动时根据记录重建动态 `mcp-client` 条目，重启后自动恢复。具体文件见[配置落在哪些文件](#配置落在哪些文件)。
- **原生条目接管**：profile 里已有的 `mcp-client` 条目可以直接接管，之后能在面板里编辑和启停；删除接管记录会恢复原条目。配置中含非字面量表达式时拒绝接管，避免把宿主代码写进存储。

## 安装

要求 DeepSeek Harness 0.2.x 与 Node.js 20+。

```bash
# 在 DSH 里为某个 profile 安装（把路径换成插件目录）
dsh plugin --profile <profile> add /path/to/dsh-mcp-bar

# 或者直接编辑 profile 的 package.json，把 dsh-mcp-bar 加进 bundles
```

插件声明了 `dsh.bundle.patch`，安装后插件自带的 `cordis.patch.yml` 会作为 bundle patch 参与 profile 组合。装完重启 DSH，输入框上方会出现 MCP 状态栏，侧边栏也会多一个「MCP 服务器」入口。

## 使用

点击状态栏或侧边栏打开面板：

1. **新建** → 选「表单」或「JSON」。stdio 填命令与参数，HTTP 填 URL 与请求头；保存前可以先点「测试连接」确认能拿到工具。
2. 列表里可以「停用 / 启用」。「停用」会把对应的动态条目标记为 disabled，工具从当前会话消失，但配置保留。
3. 编辑保存后会自动重建条目并重新连接；如果目标暂时连不上，配置仍然保存，状态显示为异常，稍后可以重试。
4. profile 中的原生 Server 会以「profile 配置」分组出现，可以一键接管到 MCP Bar 管理。

## 配置落在哪些文件

Server 配置本身只落一个文件；运行状态和动态 loader 条目不写盘。

| 内容 | 位置 |
|---|---|
| MCP Server 记录 | `~/.dsh/storages/mcp_bar.json`（设置了 `DSH_HOME` 时为 `$DSH_HOME/storages/mcp_bar.json`） |
| 动态 `mcp-bar-<key>` 条目 | 不落盘。插件启动时按存储记录重建 |
| profile 中的原生 `mcp-client` 条目 | profile 的 `cordis.patch.yml`，插件不修改；接管与停用只影响运行时 |
| 插件安装状态 | profile 的 `package.json`、`pnpm-lock.yaml` 与 `node_modules/` |

`mcp_bar.json` 是 DSH storage-json 的 `single` 单元文件，结构如下：

```json
{
  "unit": { "name": "mcp_bar", "version": 1 },
  "global": null,
  "tables": {
    "servers": {
      "s60d4b11350b5": {
        "key": "s60d4b11350b5",
        "serverName": "e2e_echo",
        "transport": "stdio",
        "command": "node",
        "args": ["server.mjs"],
        "env": {},
        "headers": {},
        "timeoutMs": 60000,
        "enabled": true,
        "nativeEntryId": null,
        "createdAt": 1792939997451,
        "updatedAt": 1792939997451
      }
    }
  }
}
```

几点约定：

- 文件在第一次保存 Server 时创建；每次新增、编辑、启停或删除都会原子重写整份单元文件。
- `env` 与 `headers` 会以明文保存。运行期错误和连接状态只存在内存里，不进入这个文件。
- 动态条目只存在于运行时。插件启动时会先停用被接管的原生条目，再从记录重建；因此不要把这些条目手写进 `cordis.patch.yml`。
- 接管原生条目时，`nativeEntryId` 记录来源；原来的 YAML 不会被改写，插件只在每次启动时于运行时停用它。删除接管记录会恢复原条目。
- 安装插件会修改 `~/.dsh/profiles/<profile>/package.json`（增加依赖并加入 `dsh.profile.bundles`），并更新该 profile 的 `pnpm-lock.yaml` 与 `node_modules/`。插件自己的 `cordis.patch.yml` 作为 bundle patch 参与组合；要改 `entryPrefix` 或 `probeTimeoutMs`，在 profile 的 `cordis.patch.yml` 中覆盖。

## 数据与安全

- 配置只包含用户填写的内容（含 env / headers 凭据），不包含运行状态；运行期错误只存在内存里。
- 浏览器半区与宿主半区通过同源 `POST /mcp-bar/api` 通信。方法名走白名单，请求需要同时满足：回环 Host（`localhost` / `127.0.0.1` / `::1` 等）、非 `Sec-Fetch-Site: cross-site`、`Origin` 与 `Host` 同源。请求体上限 1 MiB。
- stdio 探测会以当前用户权限启动配置中的命令。只添加你信任的 Server。

## 开发

```bash
npm install
npm run check      # 语法检查 + 单元测试
npm run dev:ui     # 静态 UI harness（React + mock API），不需要启动 DSH
```

目录结构：

```
lib/index.js       宿主半区：插件入口、状态聚合、API 实现
lib/record.js      表单 / JSON / 原生配置 → 存储记录的规范化
lib/args.js        命令参数解析与格式化
lib/json-import.js JSON 导入
lib/provision.js   动态 mcp-client 条目的增删改与原生条目接管
lib/probe.js       stdio / Streamable HTTP 连接探测
lib/store.js       storage domain（mcp_bar / servers）
lib/web.js         同源 HTTP API 与信任 fence
lib/client.js      浏览器半区：状态栏、面板、表单
scripts/           UI harness 与验收脚本
test/              node:test 单元测试
```

浏览器半区没有构建步骤：`lib/client.js` 是包在 `window.__ModuleLoader__.load(...)` 里的 CommonJS 工厂，直接用 `require("react")` 和 `React.createElement`。改完刷新页面即可。

## 已知限制

- 只支持 `stdio` 与 Streamable HTTP。旧版的 `sse` 配置在导入时会提示并按 Streamable HTTP 保存。
- 原生条目接管只处理字面量配置；含 Cordis 表达式的条目会提示手动新建。
- 动态 loader 条目不会写进 profile，而是插件启动时按存储记录重建。因此不要把 MCP Bar 创建的条目再手写进 `cordis.patch.yml`，否则会造成重复。
- 协议版本展示的是探测结果；实际工具调用协议由 `dsh-mcp-client` 决定。

## License

MIT
