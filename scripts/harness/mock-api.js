/**
 * UI harness 的假宿主。
 *
 * 只拦截 `POST /mcp-bar/api`，返回与 `lib/index.js` 同形的 payload，
 * 让浏览器半区可以在没有 DSH 进程的情况下跑完列表、表单、详情、探测等流程。
 */
(() => {
	const API_PATH = "/mcp-bar/api";
	const DEFAULT_TIMEOUT = 60000;
	const latency = (minimum = 120) => new Promise((resolve) => {
		setTimeout(resolve, minimum + Math.round(Math.random() * 140));
	});

	let seq = 0;
	const nextKey = () => {
		for (;;) {
			const key = `s${String(++seq).padStart(12, "0")}`;
			if (!servers.some((server) => server.id === key)) return key;
		}
	};

	function tool(name, description, properties, required) {
		return {
			name,
			publicName: name,
			title: name,
			description,
			inputSchema: properties
				? { type: "object", properties, ...(required ? { required } : {}) }
				: {}
		};
	}

	function fileTools() {
		return [
			tool("read_file", "读取文件内容，支持按行范围截取。", {
				path: { type: "string", description: "绝对路径" },
				limit: { type: "number", description: "最多返回的行数" }
			}, ["path"]),
			tool("write_file", "写入或覆盖文件。", {
				path: { type: "string" },
				content: { type: "string" }
			}, ["path", "content"]),
			tool("list_directory", "列出目录下的文件与子目录。", { path: { type: "string" } }, ["path"]),
			tool("move_file", "移动或重命名文件。", { source: { type: "string" }, destination: { type: "string" } }),
			tool("search_files", "按名称递归搜索文件。", { path: { type: "string" }, pattern: { type: "string" } }),
			tool("get_file_info", "读取文件大小、时间与权限。", { path: { type: "string" } }),
			tool("list_allowed_directories", "列出允许访问的根目录。", null),
			tool("create_directory", "创建目录。", { path: { type: "string" } }),
			tool("directory_tree", "以树形结构返回目录内容。", { path: { type: "string" } }),
			tool("read_multiple_files", "一次读取多个文件。", { paths: { type: "array", items: { type: "string" } } }),
			tool("edit_file", "按旧文本替换的方式局部编辑。", { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }),
			tool("move_directory", "移动整个目录。", { source: { type: "string" }, destination: { type: "string" } })
		];
	}

	function githubTools() {
		return [
			tool("search_repositories", "按关键词搜索 GitHub 仓库。", { query: { type: "string" }, per_page: { type: "number" } }, ["query"]),
			tool("get_file_contents", "读取仓库中的文件。", { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }),
			tool("list_issues", "列出仓库 Issues。", { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }),
			tool("create_issue", "创建 Issue。", { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }),
			tool("search_code", "在 GitHub 上搜索代码片段。", { q: { type: "string" } }),
			tool("list_pull_requests", "列出 Pull Requests。", { owner: { type: "string" }, repo: { type: "string" } }),
			tool("get_pull_request", "读取单个 PR 的详情与 diff。", { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } }),
			tool("create_pull_request", "创建 Pull Request。", { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" } }),
			tool("list_branches", "列出分支。", { owner: { type: "string" }, repo: { type: "string" } }),
			tool("get_commit", "读取提交详情。", { owner: { type: "string" }, repo: { type: "string" }, sha: { type: "string" } }),
			tool("search_users", "搜索用户或组织。", { q: { type: "string" } }),
			tool("list_notifications", "列出当前账号的通知。", null)
		];
	}

	function postgresTools() {
		return [
			tool("list_tables", "列出数据库中的表。", { schema: { type: "string" } }),
			tool("describe_table", "查看表结构与索引。", { table: { type: "string" } }),
			tool("query", "执行只读 SQL。", { sql: { type: "string" }, limit: { type: "number" } }, ["sql"]),
			tool("list_schemas", "列出 schema。", null),
			tool("explain", "返回执行计划。", { sql: { type: "string" } }),
			tool("list_extensions", "列出已安装的扩展。", null)
		];
	}

	function playwrightTools() {
		return [
			tool("browser_navigate", "在浏览器中打开页面。", { url: { type: "string" } }),
			tool("browser_snapshot", "获取当前页面可访问性快照。", null),
			tool("browser_click", "点击页面元素。", { element: { type: "string" }, ref: { type: "string" } }),
			tool("browser_type", "向输入框键入文本。", { text: { type: "string" }, ref: { type: "string" } }),
			tool("browser_take_screenshot", "截取当前页面。", { filename: { type: "string" } }),
			tool("browser_close", "关闭浏览器。", null)
		];
	}

	function linearTools() {
		return [
			tool("list_issues", "列出 Linear Issues。", { team: { type: "string" }, limit: { type: "number" } }),
			tool("create_issue", "创建 Issue。", { title: { type: "string" }, teamId: { type: "string" } }),
			tool("search", "跨项目搜索。", { query: { type: "string" } })
		];
	}

	function initialServers() {
		const now = Date.now();
		return [
			{
				id: "s000000000001",
				origin: "bar",
				state: "connected",
				tools: fileTools(),
				config: {
					key: "s000000000001",
					serverName: "filesystem",
					transport: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/tanggang/Documents", "/tmp"],
					env: { HOME: "/Users/tanggang" },
					cwd: "/Users/tanggang/Documents",
					timeoutMs: 60000,
					enabled: true,
					createdAt: now - 86400000 * 6,
					updatedAt: now - 120000
				}
			},
			{
				id: "s000000000002",
				origin: "bar",
				state: "connected",
				tools: githubTools(),
				config: {
					key: "s000000000002",
					serverName: "github",
					transport: "streamable-http",
					url: "https://api.githubcopilot.com/mcp/",
					headers: { Authorization: "Bearer ghp_demo_7c41a0d1b2e94d32", "X-MCP-Readonly": "false" },
					timeoutMs: 90000,
					enabled: true,
					createdAt: now - 86400000 * 3,
					updatedAt: now - 3600000
				}
			},
			{
				id: "s000000000003",
				origin: "bar",
				state: "pending",
				tools: postgresTools(),
				config: {
					key: "s000000000003",
					serverName: "postgres",
					transport: "stdio",
					command: "uvx",
					args: ["postgres-mcp", "--access-mode=restricted"],
					env: { DATABASE_URI: "postgresql://readonly:demo@localhost:5432/analytics" },
					timeoutMs: 60000,
					enabled: true,
					createdAt: now - 86400000 * 2,
					updatedAt: now - 45000
				}
			},
			{
				id: "s000000000004",
				origin: "bar",
				state: "error",
				error: "initialize 失败：HTTP 401 Unauthorized（请检查 Authorization 请求头）",
				tools: [],
				config: {
					key: "s000000000004",
					serverName: "sentry",
					transport: "streamable-http",
					url: "https://mcp.sentry.dev/mcp",
					headers: { Authorization: "Bearer sntrys_expired_demo_token" },
					timeoutMs: 30000,
					enabled: true,
					createdAt: now - 86400000 * 2,
					updatedAt: now - 8600000
				}
			},
			{
				id: "s000000000005",
				origin: "bar",
				state: "disabled",
				tools: playwrightTools(),
				config: {
					key: "s000000000005",
					serverName: "playwright",
					transport: "stdio",
					command: "npx",
					args: ["-y", "@playwright/mcp@latest"],
					env: {},
					timeoutMs: 120000,
					enabled: false,
					createdAt: now - 86400000 * 8,
					updatedAt: now - 86400000
				}
			},
			{
				id: "native:linear-entry",
				origin: "profile",
				state: "connected",
				tools: linearTools(),
				config: {
					serverName: "linear",
					transport: "streamable-http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer lin_api_demo_91f3" },
					toolCallTimeoutMs: 60000,
					failOnStartupError: false
				}
			},
			{
				id: "native:notion-entry",
				origin: "profile",
				state: "pending",
				tools: [],
				config: {
					serverName: "notion",
					transport: "stdio",
					command: "npx",
					args: ["-y", "@notionhq/notion-mcp-server"],
					env: { NOTION_TOKEN: "ntn_demo_2b8f5d" },
					toolCallTimeoutMs: 60000,
					failOnStartupError: false
				}
			}
		];
	}

	let servers = initialServers();
	const activationTimers = new Map();

	function find(id) {
		return servers.find((server) => server.id === id);
	}

	function isNative(server) {
		return server.origin === "profile";
	}

	function endpointOf(server) {
		const config = server.config;
		if (config.transport === "stdio") {
			const args = Array.isArray(config.args) ? config.args : [];
			return [config.command, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].filter(Boolean).join(" ");
		}
		return config.url ?? "";
	}

	function view(server) {
		const enabled = server.state !== "disabled";
		const tools = enabled && server.state !== "error" ? server.tools : [];
		return {
			id: server.id,
			key: server.id,
			name: server.config.serverName,
			serverName: server.config.serverName,
			origin: server.origin,
			originLabel: server.origin === "profile" ? "profile 配置" : "MCP Bar",
			transport: server.config.transport === "stdio" ? "stdio" : "streamable-http",
			transportLabel: server.config.transport === "stdio" ? "stdio" : "HTTP",
			endpoint: endpointOf(server),
			enabled,
			state: server.state,
			toolCount: tools.length,
			error: server.error,
			canEdit: server.origin !== "profile",
			canTest: true,
			canTakeover: server.origin === "profile",
			canRemove: server.origin !== "profile",
			nativeEntryId: server.nativeEntryId ?? (server.origin === "profile" ? server.id.replace(/^native:/, "") : undefined),
			timeoutMs: server.config.timeoutMs ?? server.config.toolCallTimeoutMs ?? DEFAULT_TIMEOUT,
			envKeys: Object.keys(server.config.env ?? {}),
			updatedAt: server.config.updatedAt
		};
	}

	function counts(views) {
		return {
			total: views.length,
			owned: views.filter((server) => server.origin === "bar").length,
			native: views.filter((server) => server.origin === "profile").length,
			enabled: views.filter((server) => server.enabled).length,
			connected: views.filter((server) => server.state === "connected").length,
			pending: views.filter((server) => server.state === "pending").length,
			error: views.filter((server) => server.state === "error").length,
			disabled: views.filter((server) => server.state === "disabled").length,
			tools: views.reduce((sum, server) => sum + server.toolCount, 0)
		};
	}

	function statusPayload() {
		const views = servers.map(view);
		return { servers: views, counts: counts(views), generatedAt: Date.now() };
	}

	function toolsForName(name) {
		if (name === "filesystem") return fileTools();
		if (name === "github") return githubTools();
		if (name === "postgres") return postgresTools();
		if (name === "playwright") return playwrightTools();
		if (name === "linear") return linearTools();
		if (name === "notion") {
			return [
				tool("search", "在工作区中搜索页面。", { query: { type: "string" } }),
				tool("fetch", "读取页面内容。", { id: { type: "string" } }),
				tool("create_page", "新建页面。", { parent: { type: "string" }, title: { type: "string" } })
			];
		}
		return [tool("ping", "示例工具，用于演示连接成功。", null)];
	}

	function scheduleConnection(server, delay = 2200) {
		const existing = activationTimers.get(server.id);
		if (existing) clearTimeout(existing);
		server.state = "pending";
		delete server.error;
		const timer = setTimeout(() => {
			activationTimers.delete(server.id);
			if (!servers.includes(server) || server.state !== "pending") return;
			server.state = "connected";
			server.tools = toolsForName(server.config.serverName);
		}, delay);
		activationTimers.set(server.id, timer);
	}

	function normalizeInput(input) {
		if (input === null || typeof input !== "object") throw new Error("服务器配置必须是一个对象");
		const serverName = String(input.serverName ?? input.name ?? "").trim();
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
			throw new Error("名称只能包含字母、数字、下划线或短横线，长度 1–32");
		}
		const rawType = String(input.transport ?? input.type ?? "").toLowerCase();
		const transport = rawType === "stdio"
			? "stdio"
			: rawType === "" && input.command
				? "stdio"
				: "streamable-http";
		const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT;
		const base = { serverName, transport, timeoutMs, enabled: input.enabled !== false };
		if (transport === "stdio") {
			if (!input.command) throw new Error("stdio 类型需要填写命令");
			const args = Array.isArray(input.args)
				? input.args.map(String)
				: typeof input.args === "string"
					? input.args.split(/\s+/).filter(Boolean)
					: [];
			return {
				...base,
				command: String(input.command),
				args,
				env: { ...(input.env ?? {}) },
				cwd: input.cwd ? String(input.cwd) : undefined
			};
		}
		if (!input.url) throw new Error("HTTP 类型需要填写 URL");
		try {
			new URL(input.url);
		} catch {
			throw new Error("URL 格式不正确");
		}
		return { ...base, url: String(input.url), headers: { ...(input.headers ?? {}) } };
	}

	function assertNameFree(name, ignore) {
		const clash = servers.find((server) => server.config.serverName === name && server !== ignore);
		if (clash) {
			throw new Error(
				clash.origin === "profile"
					? `profile 中已有同名 Server「${name}」，请先在列表中接管它，或换一个名称`
					: `名称「${name}」已经被另一条 MCP Bar 配置使用`
			);
		}
	}

	function createFrom(input, extra = {}) {
		const server = {
			id: nextKey(),
			origin: "bar",
			state: "pending",
			tools: [],
			error: undefined,
			nativeEntryId: extra.nativeEntryId,
			config: {
				...normalizeInput(input),
				createdAt: Date.now(),
				updatedAt: Date.now()
			}
		};
		server.config.key = server.id;
		servers = [...servers, server];
		scheduleConnection(server);
		return server;
	}

	function extractServers(json) {
		let parsed;
		try {
			parsed = JSON.parse(String(json ?? ""));
		} catch {
			throw new Error("JSON 无法解析");
		}
		const found = [];
		const pushObject = (name, value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			found.push({ name, config: value });
		};
		const pushArray = (items) => {
			for (const item of items) {
				if (!item || typeof item !== "object") continue;
				pushObject(String(item.serverName ?? item.name ?? ""), item);
			}
		};
		if (Array.isArray(parsed)) pushArray(parsed);
		else if (parsed && typeof parsed === "object") {
			const bag = parsed.mcpServers ?? parsed.servers;
			if (bag && typeof bag === "object" && !Array.isArray(bag)) {
				for (const [name, value] of Object.entries(bag)) pushObject(name, value);
			} else if (parsed.serverName || parsed.name || parsed.command || parsed.url) {
				pushObject(String(parsed.serverName ?? parsed.name ?? ""), parsed);
			} else {
				for (const [name, value] of Object.entries(parsed)) pushObject(name, value);
			}
		}
		if (found.length === 0) throw new Error("JSON 里没有服务器配置");
		return found;
	}

	async function handle(method, params) {
		await latency();
		if (method === "status") return statusPayload();
		if (method === "detail") {
			const server = find(params.id);
			if (!server) throw new Error("这条 MCP Server 不存在，可能已被删除");
			const enabled = server.state !== "disabled";
			return {
				server: view(server),
				tools: enabled ? server.tools : [],
				config: server.config,
				rawConfig: server.origin === "profile"
			};
		}
		if (method === "create") {
			const input = normalizeInput(params.server ?? {});
			assertNameFree(input.serverName);
			const server = createFrom(input);
			return { server: view(server), warnings: [] };
		}
		if (method === "update") {
			const server = find(params.id);
			if (!server) throw new Error("这条 MCP Server 不存在，可能已被删除");
			const input = normalizeInput(params.server ?? {});
			assertNameFree(input.serverName, server);
			server.config = {
				...server.config,
				...input,
				updatedAt: Date.now()
			};
			scheduleConnection(server);
			return { server: view(server), warnings: [] };
		}
		if (method === "remove") {
			const server = find(params.id);
			if (!server) throw new Error("这条 MCP Server 不存在，可能已被删除");
			const restoredNative = Boolean(server.nativeEntryId);
			servers = servers.filter((candidate) => candidate !== server);
			const timer = activationTimers.get(server.id);
			if (timer) clearTimeout(timer);
			return { removed: true, restoredNative };
		}
		if (method === "setEnabled") {
			const server = find(params.id);
			if (!server) throw new Error("这条 MCP Server 不存在，可能已被删除");
			if (params.enabled === false) {
				const timer = activationTimers.get(server.id);
				if (timer) clearTimeout(timer);
				activationTimers.delete(server.id);
				server.state = "disabled";
				delete server.error;
			} else {
				scheduleConnection(server, 1600);
			}
			return { server: view(server) };
		}
		if (method === "probe") {
			let name;
			let transport;
			let command;
			let url;
			if (params.server) {
				const input = normalizeInput(params.server);
				name = input.serverName;
				transport = input.transport;
				command = input.command;
				url = input.url;
			} else {
				const server = find(params.id);
				if (!server) throw new Error("这条 MCP Server 不存在，可能已被删除");
				name = server.config.serverName;
				transport = server.config.transport;
				command = server.config.command;
				url = server.config.url;
			}
			await latency(520);
			if (name === "sentry" || /sentry/i.test(url ?? "")) {
				const error = new Error("HTTP 401 Unauthorized：Access token 已过期");
				error.kind = "auth";
				throw error;
			}
			if (command === "does-not-exist") {
				const error = new Error("spawn does-not-exist ENOENT");
				error.kind = "spawn";
				throw error;
			}
			const tools = toolsForName(name);
			return {
				serverName: name,
				transport,
				protocolVersion: "2025-06-18",
				latencyMs: 380 + Math.round(Math.random() * 260),
				toolCount: tools.length,
				tools
			};
		}
		if (method === "importJson") {
			const entries = extractServers(params.json);
			for (const entry of entries) assertNameFree(entry.name);
			const created = [];
			for (const entry of entries) {
				try {
					const input = normalizeInput({ ...entry.config, serverName: entry.name });
					const server = createFrom(input);
					created.push({ server: view(server) });
				} catch (error) {
					created.push({ server: null, warning: error.message });
				}
			}
			return { created: created.filter((item) => item.server), warnings: [] };
		}
		if (method === "takeover") {
			const server = find(`native:${params.entryId}`);
			if (!server) throw new Error("找不到要接管的 profile Server");
			assertNameFree(server.config.serverName, server);
			servers = servers.filter((candidate) => candidate !== server);
			const created = createFrom({ ...server.config, enabled: true }, { nativeEntryId: params.entryId });
			return { ok: true, server: view(created) };
		}
		if (method === "takeoverAll") {
			const natives = servers.filter((server) => server.origin === "profile");
			const created = [];
			const failed = [];
			for (const server of natives) {
				try {
					assertNameFree(server.config.serverName, server);
					servers = servers.filter((candidate) => candidate !== server);
					createFrom({ ...server.config, enabled: true }, { nativeEntryId: server.id.replace(/^native:/, "") });
					created.push({ name: server.config.serverName });
				} catch (error) {
					failed.push({ name: server.config.serverName, message: error.message });
				}
			}
			return { created, failed, total: natives.length };
		}
		throw new Error(`mock: 未知方法「${method}」`);
	}

	const originalFetch = window.fetch.bind(window);

	window.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input?.url ?? "";
		if (!url.endsWith(API_PATH)) return originalFetch(input, init);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		const method = String(body.method ?? "");
		try {
			const payload = await handle(method, body.params ?? {});
			return new Response(JSON.stringify({ ok: true, ...payload }), {
				status: 200,
				headers: { "content-type": "application/json" }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
				...(error?.kind ? { kind: error.kind } : {})
			}), {
				status: 400,
				headers: { "content-type": "application/json" }
			});
		}
	};

	window.__MCP_MOCK__ = {
		reset() {
			for (const timer of activationTimers.values()) clearTimeout(timer);
			activationTimers.clear();
			seq = 0;
			servers = initialServers();
			return statusPayload();
		},
		status() {
			return statusPayload();
		}
	};
})();
