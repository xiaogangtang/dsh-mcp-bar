/**
 * 浏览器半区与宿主半区之间的同源 HTTP API。
 *
 * 只挂载一个 POST 路由：`/mcp-bar/api`。方法名走白名单，杜绝任意反射调用。
 * 所有请求都经过浏览器信任 fence（回环 Host + 非跨站 + Origin 同源）。
 */
import { ProbeError } from './probe.js';

const API_WHITELIST = new Map([
  ['status', (api, params) => api.status(params ?? {})],
  ['detail', (api, params) => api.detail(params ?? {})],
  ['create', (api, params) => api.create(params ?? {})],
  ['update', (api, params) => api.update(params ?? {})],
  ['remove', (api, params) => api.remove(params ?? {})],
  ['setEnabled', (api, params) => api.setEnabled(params ?? {})],
  ['probe', (api, params) => api.probe(params ?? {})],
  ['importJson', (api, params) => api.importJson(params ?? {})],
  ['takeover', (api, params) => api.takeover(params ?? {})],
  ['takeoverAll', (api, params) => api.takeoverAll(params ?? {})],
]);

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseAuthority(host) {
  if (typeof host !== 'string' || host === '') return undefined;
  try {
    const url = new URL(`http://${host}`);
    return url.hostname ? { hostname: url.hostname, host: url.host } : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  const name = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return name === 'localhost'
    || name === '127.0.0.1'
    || name === '::1'
    || name === '0:0:0:0:0:0:0:1'
    || name.endsWith('.localhost');
}

function isTrustedAuthority(url, trustedHosts) {
  for (const raw of trustedHosts ?? []) {
    if (typeof raw !== 'string') continue;
    const authority = parseAuthority(raw);
    if (authority && authority.host === url.host) return true;
  }
  return false;
}

/** 回环 Host、非跨站、Origin 与 Host 同源。 */
export function isTrustedWebRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host');
  if (!host) return false;
  const hostUrl = parseAuthority(host);
  if (!hostUrl) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('请求体不能超过 1 MiB');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function errorPayload(error) {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ProbeError ? { kind: error.kind } : {}),
  };
}

function mount(wctx, api, { logger, trustedHosts = [] } = {}) {
  return wctx.webServer.register({
    kind: 'prefix',
    path: '/mcp-bar/api',
    handler: async (req, res) => {
      if (!isTrustedWebRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, message: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      let method = '';
      try {
        const body = await readJsonBody(req);
        method = typeof body?.method === 'string' ? body.method : '';
        const dispatch = API_WHITELIST.get(method);
        if (!dispatch) {
          writeJson(res, 400, { ok: false, message: `未知方法「${method}」` });
          return;
        }
        const result = await dispatch(api, body?.params ?? {});
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        logger?.warn?.(`api ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        writeJson(res, 400, errorPayload(error));
      }
    },
  });
}

/** 兼容不同 DSH 版本的 web 服务名；优先 webStartup。 */
export function injectWebRoutes(ctx, api, options = {}) {
  const candidates = new Map();
  let active;
  let dispose;
  const reconcile = () => {
    const next = candidates.get('webStartup') ?? candidates.get('webRuntime');
    if (next === active) return;
    dispose?.();
    dispose = undefined;
    active = next;
    if (next) {
      dispose = mount(next.wctx, api, { ...options, trustedHosts: next.trustedHosts });
      options.logger?.info?.('mcp-bar API mounted at /mcp-bar/api');
    }
  };

  for (const name of ['webStartup', 'webRuntime']) {
    ctx.inject(['webServer', name], (wctx) => {
      wctx.effect(() => {
        const candidate = { wctx, trustedHosts: wctx[name]?.trustedHosts ?? [] };
        candidates.set(name, candidate);
        reconcile();
        return () => {
          if (candidates.get(name) === candidate) candidates.delete(name);
          reconcile();
        };
      });
    });
  }
}
