#!/usr/bin/env node
/**
 * 交互回归：在 headless Chrome 里用真实浏览器半区走一遍主要流程。
 *
 *   node scripts/test-ui.mjs
 *
 * 需要 harness 服务已运行（npm run dev:ui）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:4173/';
const PORT = Number(process.env.CDP_PORT) > 0 ? Number(process.env.CDP_PORT) : 9334;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForPort() {
	for (let i = 0; i < 80; i += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (response.ok) return;
		} catch {
			// Chrome 还没起来。
		}
		await sleep(120);
	}
	throw new Error('Chrome DevTools 端口未就绪');
}

class Cdp {
	constructor(url) {
		this.url = url;
		this.id = 0;
		this.pending = new Map();
		this.errors = [];
	}

	async connect() {
		this.ws = new WebSocket(this.url);
		await new Promise((resolveConnect, reject) => {
			this.ws.onopen = resolveConnect;
			this.ws.onerror = () => reject(new Error('WS connect failed'));
		});
		this.ws.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined) {
				const entry = this.pending.get(message.id);
				if (!entry) return;
				this.pending.delete(message.id);
				if (message.error) entry.reject(new Error(message.error.message));
				else entry.resolve(message.result);
				return;
			}
			if (message.method === 'Runtime.exceptionThrown') {
				this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
			}
			if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
				this.errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
			}
		};
	}

	send(method, params = {}) {
		const id = ++this.id;
		return new Promise((resolveSend, reject) => {
			this.pending.set(id, { resolve: resolveSend, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const result = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result?.value;
	}
}

const failures = [];
const checks = [];
function check(name, condition, details) {
	checks.push(name);
	if (condition) {
		console.log(`  ✓ ${name}`);
		return;
	}
	failures.push({ name, details });
	console.log(`  ✗ ${name}${details === undefined ? '' : ` — ${JSON.stringify(details)}`}`);
}

const profile = await mkdtemp(join(tmpdir(), 'mcp-bar-test-'));
const chrome = spawn(CHROME, [
	'--headless=new',
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${profile}`,
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-gpu',
	'--hide-scrollbars',
	'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (chunk) => {
	chromeLog += chunk.toString();
});

try {
	await waitForPort();
	const create = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' });
	const target = await create.json();
	const cdp = new Cdp(target.webSocketDebuggerUrl);
	await cdp.connect();
	await cdp.send('Runtime.enable');
	await cdp.send('Page.enable');
	await cdp.send('Emulation.setDeviceMetricsOverride', {
		width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
	});
	await cdp.send('Page.navigate', { url: BASE });

	for (let i = 0; i < 60; i += 1) {
		const ready = await cdp.evaluate('Boolean(window.__MCP_UI__ && window.__MCP_UI__.controller)').catch(() => false);
		if (ready) break;
		await sleep(150);
	}

	console.log('交互检查…');

	const initial = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		for (let i = 0; i < 50 && c.getSnapshot().status !== "ready"; i++) {
			await new Promise((done) => setTimeout(done, 100));
		}
		const state = c.getSnapshot();
		return { status: state.status, counts: state.counts, names: state.servers.map((s) => s.name) };
	})()`);
	check('首屏加载 7 个服务器', initial.status === 'ready' && initial.counts.total === 7, initial);
	check('连接统计正确', initial.counts.connected === 3 && initial.counts.native === 2 && initial.counts.error === 1, initial.counts);

	const toggle = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		const pw = c.getSnapshot().servers.find((s) => s.name === "playwright");
		await c.toggleServer(pw);
		await wait(300);
		const pending = c.getSnapshot().servers.find((s) => s.name === "playwright");
		await wait(2100);
		await c.refresh();
		await wait(250);
		const after = c.getSnapshot().servers.find((s) => s.name === "playwright");
		return {
			pendingState: pending.state,
			pendingEnabled: pending.enabled,
			afterState: after.state,
			afterTools: after.toolCount,
			notice: c.getSnapshot().notice?.text
		};
	})()`);
	check('启用开关立即反映为未就绪', toggle.pendingEnabled === true && toggle.pendingState === 'pending', toggle);
	check('后台连接完成后变为已连接', toggle.afterState === 'connected' && toggle.afterTools === 6, toggle);

	const form = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		__MCP_UI__.openCreate("form");
		await c.saveForm();
		const invalid = { ...c.getSnapshot().fieldErrors };
		const invalidMessage = c.getSnapshot().formError;
		c.updateDraft({ serverName: "demo-http", transport: "streamable-http", url: "https://example.com/mcp", timeoutMs: "45000" });
		await c.saveForm();
		await wait(450);
		const created = c.getSnapshot().servers.find((s) => s.name === "demo-http");
		const view = c.getSnapshot().view;
		return {
			invalid,
			invalidMessage,
			created: created && {
				state: created.state,
				transport: created.transport,
				timeoutMs: created.timeoutMs,
				endpoint: created.endpoint
			},
			view,
			notice: c.getSnapshot().notice?.text
		};
	})()`);
	check('空表单阻止保存并标红字段', form.invalid.serverName && form.invalid.command, form);
	check('新建 HTTP 服务器成功', form.created?.transport === 'streamable-http' && form.created?.timeoutMs === 45000, form);
	check('保存后回到列表并提示', form.view === 'list' && String(form.notice ?? '').includes('demo-http'), form);

	const duplicate = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		__MCP_UI__.openCreate("form");
		c.updateDraft({ serverName: "github", transport: "streamable-http", url: "https://x.test/mcp" });
		await c.saveForm();
		return { view: c.getSnapshot().view, error: c.getSnapshot().formError };
	})()`);
	check('重名被拒绝且停留在表单', duplicate.view === 'create' && /github/.test(duplicate.error ?? ''), duplicate);

	const json = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		__MCP_UI__.openCreateJson("{oops");
		await c.saveForm();
		const invalidError = c.getSnapshot().formError;
		__MCP_UI__.openCreateJson(JSON.stringify({ mcpServers: {
			alpha: { command: "npx", args: ["-y", "alpha-mcp"] },
			beta: { url: "https://beta.test/mcp" }
		} }));
		await c.saveForm();
		await wait(550);
		const alpha = c.getSnapshot().servers.find((s) => s.name === "alpha");
		const beta = c.getSnapshot().servers.find((s) => s.name === "beta");
		const notice = c.getSnapshot().notice?.text;
		__MCP_UI__.openCreateJson(JSON.stringify({ mcpServers: { gamma: { command: "npx", args: ["-y", "gamma-mcp"] } } }));
		await c.saveForm();
		await wait(500);
		const gamma = c.getSnapshot().servers.find((s) => s.name === "gamma");
		return {
			invalidError,
			alpha: alpha && { transport: alpha.transport, state: alpha.state },
			beta: beta && { transport: beta.transport, state: beta.state },
			notice,
			gamma: gamma && { transport: gamma.transport }
		};
	})()`);
	check('非法 JSON 报错且不保存', /JSON/.test(json.invalidError ?? ''), json);
	check('批量导入 stdio + HTTP 两个服务器', json.alpha?.transport === 'stdio' && json.beta?.transport === 'streamable-http', json);
	check('单条 JSON 也按 stdio 创建', json.gamma?.transport === 'stdio', json);

	const edit = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		const gamma = c.getSnapshot().servers.find((s) => s.name === "gamma");
		await c.openEdit(gamma.id);
		const draft = c.getSnapshot().draft;
		c.updateDraft({ argsText: "-y gamma-mcp --strict" });
		await c.saveForm();
		await wait(500);
		const detail = await c.openDetail(gamma.id).then(() => c.getSnapshot().detail);
		const noticeCleared = c.getSnapshot().notice === null;
		return {
			loadedServerName: draft?.serverName,
			args: detail?.config?.args,
			view: c.getSnapshot().view,
			noticeCleared
		};
	})()`);
	check('编辑页回填现有配置', edit.loadedServerName === 'gamma', edit);
	check('编辑保存后参数已更新', Array.isArray(edit.args) && edit.args.includes('--strict'), edit);
	check('切换页面清掉旧提示', edit.noticeCleared === true, edit);

	const takeover = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		await c.goBack();
		const linear = c.getSnapshot().servers.find((s) => s.name === "linear");
		await __MCP_UI__.openDetail(linear.id);
		const canTakeover = c.getSnapshot().detail.server.canTakeover;
		c.requestTakeover(linear);
		await c.confirmDialog();
		await wait(500);
		const afterLinear = c.getSnapshot().servers.find((s) => s.name === "linear");
		const nativeAfter = c.getSnapshot().counts.native;
		c.requestTakeoverAll();
		await c.confirmDialog();
		await wait(600);
		const finalState = c.getSnapshot();
		return {
			canTakeover,
			linear: afterLinear && { origin: afterLinear.origin, nativeEntryId: afterLinear.nativeEntryId },
			nativeAfter,
			finalNative: finalState.counts.native,
			notionOrigin: finalState.servers.find((s) => s.name === "notion")?.origin,
			notice: finalState.notice?.text
		};
	})()`);
	check('profile 条目显示接管按钮', takeover.canTakeover === true, takeover);
	check('单个接管后成为 MCP Bar 记录', takeover.linear?.origin === 'bar' && takeover.linear?.nativeEntryId === 'linear-entry', takeover);
	check('全部接管清空 profile 条目', takeover.finalNative === 0 && takeover.notionOrigin === 'bar', takeover);

	const deletion = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		__MCP_UI__.showPanel();
		const demo = c.getSnapshot().servers.find((s) => s.name === "demo-http");
		c.requestDelete(demo);
		const dialog = c.getSnapshot().dialog;
		await c.confirmDialog();
		await wait(450);
		return {
			dialogKind: dialog?.kind,
			gone: !c.getSnapshot().servers.some((s) => s.name === "demo-http"),
			notice: c.getSnapshot().notice?.text
		};
	})()`);
	check('删除对话框与删除结果', deletion.dialogKind === 'delete' && deletion.gone === true, deletion);

	const probe = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		await c.runProbe({ id: "s000000000004" });
		const state = c.getSnapshot();
		return { phase: state.probe.phase, kind: state.probe.kind, error: state.probe.error };
	})()`);
	check('探测失败返回 auth 类型', probe.phase === 'error' && probe.kind === 'auth', probe);

	const search = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		__MCP_UI__.showPanel();
		c.setQuery("post");
		await new Promise((done) => setTimeout(done, 150));
		const rows = document.querySelectorAll(".mcpbar-row").length;
		const names = [...document.querySelectorAll(".mcpbar-row-name")].map((node) => node.textContent);
		const banner = Boolean(document.querySelector(".mcpbar-banner"));
		const query = c.getSnapshot().query;
		c.setQuery("");
		return { rows, names, banner, query };
	})()`);
	check('搜索只显示匹配行并隐藏 profile 提示', search.rows === 1 && search.banner === false, search);

	const overlay = await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		__MCP_UI__.openOverlay();
		await new Promise((done) => setTimeout(done, 80));
		const open = c.getSnapshot().overlayOpen;
		const body = Boolean(document.querySelector(".mcpbar-overlay-backdrop .mcpbar-root"));
		c.closeOverlay();
		await new Promise((done) => setTimeout(done, 30));
		return { open, body, closed: c.getSnapshot().overlayOpen };
	})()`);
	check('layout 不可用时回退到 overlay', overlay.open === true && overlay.body === true && overlay.closed === false, overlay);

	const dock = await cdp.evaluate(`(async () => {
		__MCP_UI__.showConversation();
		await new Promise((done) => setTimeout(done, 60));
		return { hasDock: Boolean(document.querySelector(".mcpbar-dock")) };
	})()`);
	check('对话页不再注入状态栏', dock.hasDock === false, dock);

	if (cdp.errors.length > 0) {
		console.log('\n浏览器错误：');
		for (const entry of [...new Set(cdp.errors)]) console.log(`  ! ${entry}`);
		failures.push({ name: '浏览器控制台错误', details: cdp.errors });
	}

	console.log(`\n${checks.length - failures.length}/${checks.length} 项通过`);
	if (failures.length > 0) {
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`交互测试失败：${error.stack || error.message}`);
	if (chromeLog.trim()) console.error(`\nChrome 输出：\n${chromeLog.slice(-2500)}`);
	process.exitCode = 1;
} finally {
	chrome.kill('SIGTERM');
	await sleep(300);
	await rm(profile, { recursive: true, force: true });
}
