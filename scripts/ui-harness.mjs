#!/usr/bin/env node
/**
 * 启动 UI harness：把 scripts/harness 与 lib/client.js 以静态资源暴露出来。
 *
 *   npm run dev:ui            # http://127.0.0.1:4173
 *   PORT=4300 npm run dev:ui
 *
 * 只监听回环地址；mock API 全在浏览器内存里，不会读写真实 DSH 配置。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HARNESS = resolve(ROOT, 'scripts/harness');
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.map': 'application/json; charset=utf-8'
};

const FILES = new Map([
	['/', resolve(HARNESS, 'index.html')],
	['/index.html', resolve(HARNESS, 'index.html')],
	['/harness.css', resolve(HARNESS, 'harness.css')],
	['/harness.js', resolve(HARNESS, 'harness.js')],
	['/mock-api.js', resolve(HARNESS, 'mock-api.js')],
	['/lib/client.js', resolve(ROOT, 'lib/client.js')],
	['/vendor/react.js', resolve(ROOT, 'node_modules/react/umd/react.development.js')],
	['/vendor/react-dom.js', resolve(ROOT, 'node_modules/react-dom/umd/react-dom.development.js')]
]);

function inside(base, target) {
	return target === base || target.startsWith(`${base}${sep}`);
}

function routeFor(pathname) {
	const direct = FILES.get(pathname);
	if (direct) return direct;
	// 允许以后往 harness 目录里加截图或额外资源。
	const candidate = resolve(HARNESS, `.${pathname}`);
	return inside(HARNESS, candidate) ? candidate : undefined;
}

function send(res, status, body, headers = {}) {
	res.writeHead(status, {
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...headers
	});
	res.end(body);
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
	if (url.pathname === '/favicon.ico') {
		send(res, 204, '');
		return;
	}
	const file = routeFor(decodeURIComponent(url.pathname));
	if (!file) {
		send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
		return;
	}
	try {
		const info = await stat(file);
		if (!info.isFile()) throw new Error('not a file');
		const body = await readFile(file);
		send(res, 200, body, {
			'content-type': MIME[extname(file)] ?? 'application/octet-stream',
			'content-length': body.length
		});
	} catch (error) {
		send(res, 404, `not found: ${url.pathname}\n${error.message}`, {
			'content-type': 'text/plain; charset=utf-8'
		});
	}
});

server.listen(PORT, HOST, () => {
	console.log(`MCP Bar UI harness: http://${HOST}:${PORT}`);
	console.log('  数据是浏览器内存里的 mock，不会写真实配置。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
