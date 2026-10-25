#!/usr/bin/env node
/**
 * 用本机 Chrome 的 headless 模式给 harness 截图，做视觉验收。
 *
 *   node scripts/capture-ui.mjs
 *
 * 依赖：macOS 上安装的 Google Chrome；harness 服务需已在 4173 运行。
 * 产物：scripts/harness/shots/*.png
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:4173/';
const OUT = resolve(new URL('./harness/shots/', import.meta.url).pathname);
const PORT = Number(process.env.CDP_PORT) > 0 ? Number(process.env.CDP_PORT) : 9333;
const VIEWPORT = { width: 1440, height: 900 };

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
		this.listeners = new Set();
		this.closed = false;
	}

	async connect() {
		this.ws = new WebSocket(this.url);
		await new Promise((resolveConnect, reject) => {
			this.ws.onopen = resolveConnect;
			this.ws.onerror = (event) => reject(new Error(`WS error: ${event?.message ?? 'unknown'}`));
		});
		this.ws.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined) {
				const entry = this.pending.get(message.id);
				if (!entry) return;
				this.pending.delete(message.id);
				if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
				else entry.resolve(message.result);
				return;
			}
			for (const listener of this.listeners) listener(message);
		};
		this.ws.onclose = () => {
			this.closed = true;
		};
	}

	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	send(method, params = {}) {
		if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
		const id = ++this.id;
		const payload = JSON.stringify({ id, method, params });
		return new Promise((resolveSend, reject) => {
			this.pending.set(id, { resolve: resolveSend, reject });
			this.ws.send(payload);
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
			const detail = result.exceptionDetails.exception?.description
				?? result.exceptionDetails.text
				?? 'evaluate failed';
			throw new Error(detail);
		}
		return result.result?.value;
	}

	async screenshot(file) {
		const shot = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
		await writeFile(file, Buffer.from(shot.data, 'base64'));
	}
}

const errors = [];

async function main() {
	await mkdir(OUT, { recursive: true });
	await waitForPort();

	const create = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' });
	if (!create.ok) throw new Error(`创建标签页失败：HTTP ${create.status}`);
	const target = await create.json();

	const cdp = new Cdp(target.webSocketDebuggerUrl);
	await cdp.connect();
	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');
	await cdp.send('Log.enable');
	await cdp.send('Emulation.setDeviceMetricsOverride', {
		width: VIEWPORT.width,
		height: VIEWPORT.height,
		deviceScaleFactor: 1,
		mobile: false
	});

	cdp.onEvent((message) => {
		if (message.method === 'Runtime.exceptionThrown') {
			const details = message.params.exceptionDetails;
			errors.push(`exception: ${details.exception?.description ?? details.text}`);
		}
		if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
			errors.push(`console.error: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
		}
		if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
			const text = message.params.entry.text ?? '';
			if (!text.includes('favicon')) errors.push(`log: ${text}`);
		}
	});

	let loaded = false;
	cdp.onEvent((message) => {
		if (message.method === 'Page.loadEventFired') loaded = true;
	});
	await cdp.send('Page.navigate', { url: BASE });
	for (let i = 0; i < 50 && !loaded; i += 1) await sleep(100);
	await sleep(1000);

	const shot = async (name) => {
		await sleep(320);
		await cdp.screenshot(join(OUT, `${name}.png`));
		console.log(`  · ${name}.png`);
	};

	const setViewport = async (width, height) => {
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false
		});
		await sleep(260);
	};

	console.log('截图中…');
	await cdp.evaluate('__MCP_UI__.setTheme("light"); __MCP_UI__.showPanel(); true');
	await shot('01-list-light');

	await cdp.evaluate('__MCP_UI__.setTheme("dark"); true');
	await shot('02-list-dark');
	await cdp.evaluate('__MCP_UI__.setTheme("light"); true');

	await cdp.evaluate('__MCP_UI__.showConversation(); true');
	await shot('03-conversation-dock');

	await cdp.evaluate('__MCP_UI__.openCreate("form"); true');
	await shot('04-create-form-empty');

	await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		c.updateDraft({
			serverName: "filesystem",
			transport: "stdio",
			command: "npx",
			argsText: '-y @modelcontextprotocol/server-filesystem "/Users/tanggang/My Documents" /tmp',
			cwd: "/Users/tanggang",
			timeoutMs: "60000"
		});
		c.addDraftRow("envRows");
		c.updateDraftRow("envRows", 0, "key", "HOME");
		c.updateDraftRow("envRows", 0, "value", "/Users/tanggang");
		await c.runProbe({ draft: c.getSnapshot().draft });
		return __MCP_UI__.state.probe.phase;
	})()`);
	await shot('05-create-form-probed');

	const jsonSample = `{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "timeoutMs": 60000
    },
    "github": {
      "type": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ghp_xxx" }
    }
  }
}`;
	await cdp.evaluate(`__MCP_UI__.openCreateJson(${JSON.stringify(jsonSample)}); true`);
	await shot('06-create-json');

	await cdp.evaluate('__MCP_UI__.openDetail("s000000000001"); true');
	await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		await c.runProbe({ id: "s000000000001" });
		document.querySelector(".mcpbar-body")?.scrollTo(0, 0);
		return true;
	})()`);
	await shot('07-detail-filesystem');

	await cdp.evaluate('__MCP_UI__.openDetail("s000000000004"); true');
	await cdp.evaluate(`(async () => {
		const c = __MCP_UI__.controller;
		await c.runProbe({ id: "s000000000004" });
		document.querySelector(".mcpbar-probe-error")?.scrollIntoView({ block: "center" });
		return true;
	})()`);
	await shot('08-detail-sentry-error');

	await cdp.evaluate('__MCP_UI__.openOverlay(); true');
	await shot('09-overlay');
	await cdp.evaluate('__MCP_UI__.closeOverlay(); __MCP_UI__.goBack(); true');

	await setViewport(740, 900);
	await cdp.evaluate('__MCP_UI__.showPanel(); true');
	await shot('10-narrow-list');

	await cdp.evaluate('__MCP_UI__.setTheme("dark"); __MCP_UI__.openDetail("s000000000003"); true');
	await shot('11-narrow-detail-dark');

	await setViewport(390, 844);
	await cdp.evaluate('__MCP_UI__.setTheme("light"); __MCP_UI__.goBack(); __MCP_UI__.showPanel(); true');
	await shot('12-mobile-list');

	await cdp.evaluate('__MCP_UI__.setTheme("dark"); __MCP_UI__.openDetail("native:linear-entry"); true');
	await shot('13-mobile-native-dark');

	await setViewport(VIEWPORT.width, VIEWPORT.height);
	await cdp.evaluate('__MCP_UI__.setTheme("light"); __MCP_UI__.goBack(); true');
	await cdp.evaluate('__MCP_UI__.controller.setQuery("post"); true');
	await shot('14-list-search');
	await cdp.evaluate('__MCP_UI__.controller.setQuery(""); true');

	await cdp.evaluate(`(() => {
		const controller = __MCP_UI__.controller;
		const server = controller.getSnapshot().servers.find((item) => item.id === "s000000000002");
		controller.requestDelete(server);
		return true;
	})()`);
	await shot('15-delete-dialog');
	await cdp.evaluate('__MCP_UI__.controller.closeDialog(); true');

	await cdp.evaluate('__MCP_UI__.openDetail("native:linear-entry"); true');
	await shot('16-native-detail');

	if (errors.length > 0) {
		console.log('\n浏览器错误：');
		for (const entry of [...new Set(errors)]) console.log(`  ! ${entry}`);
	} else {
		console.log('\n浏览器控制台无错误。');
	}

	console.log(`\n输出目录：${OUT}`);
}

const profile = await mkdtemp(join(tmpdir(), 'mcp-bar-cdp-'));
const chrome = spawn(CHROME, [
	'--headless=new',
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${profile}`,
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-gpu',
	'--hide-scrollbars',
	'--force-color-profile=srgb',
	'--window-size=1440,900',
	'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeLog = '';
chrome.stderr.on('data', (chunk) => {
	chromeLog += chunk.toString();
});

try {
	await main();
} catch (error) {
	console.error(`截图失败：${error.stack || error.message}`);
	if (chromeLog.trim()) console.error(`\nChrome 输出：\n${chromeLog.slice(-3000)}`);
	process.exitCode = 1;
} finally {
	chrome.kill('SIGTERM');
	await sleep(300);
	await rm(profile, { recursive: true, force: true });
}
