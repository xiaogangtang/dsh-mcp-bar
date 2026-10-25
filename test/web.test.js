import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { injectWebRoutes, isTrustedWebRequest } from '../lib/web.js';
import { ProbeError } from '../lib/probe.js';

function trusted(headers, trustedHosts) {
  return isTrustedWebRequest({ headers }, trustedHosts);
}

test('isTrustedWebRequest：回环 Host 与同源判断', () => {
  assert.equal(trusted({ host: 'localhost:3000' }), true);
  assert.equal(trusted({ host: '127.0.0.1:8080' }), true);
  assert.equal(trusted({ host: '[::1]:8080' }), true);
  assert.equal(trusted({ host: 'app.localhost:3000' }), true);
  assert.equal(trusted({ host: 'example.com:3000' }), false);
  assert.equal(trusted({ host: '192.168.1.10:3000' }), false);
  assert.equal(trusted({}), false);
  assert.equal(trusted({ host: 'bad host' }), false);
});

test('isTrustedWebRequest：trustedHosts、Sec-Fetch-Site 与 Origin', () => {
  assert.equal(trusted({ host: 'example.com:3000' }, ['example.com:3000']), true);
  assert.equal(trusted({ host: 'example.com:3000' }, ['example.com:4000']), false);
  assert.equal(trusted({ host: 'example.com:3000' }, [42, null, 'bad host']), false);

  assert.equal(trusted({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(trusted({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }), true);

  assert.equal(trusted({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true);
  assert.equal(trusted({ host: 'localhost:3000', origin: 'http://localhost:4000' }), false);
  assert.equal(trusted({ host: 'localhost:3000', origin: 'https://evil.example' }), false);
  assert.equal(trusted({ host: 'localhost:3000', origin: 'null' }), false);
  assert.equal(trusted({ host: 'localhost:3000', origin: ['http://localhost:3000'] }), true);
});

function makeReq({ method = 'POST', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  return req;
}

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    finished: false,
    writeHead(status, headers = {}) {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
      return res;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.finished = true;
    },
    body() {
      return Buffer.concat(chunks).toString('utf8');
    },
    json() {
      return JSON.parse(res.body());
    },
  };
  return res;
}

function makeContext() {
  const injections = [];
  return {
    injections,
    inject(deps, callback) {
      injections.push({ deps, callback });
    },
  };
}

function makeWctx(name, trustedHosts = []) {
  const registrations = [];
  const effectCleanups = [];
  const wctx = {
    [name]: { trustedHosts },
    webServer: {
      register(config) {
        const registration = { config, disposed: false };
        registrations.push(registration);
        return () => {
          registration.disposed = true;
        };
      },
    },
    effect(fn) {
      const cleanup = fn();
      effectCleanups.push(cleanup);
      return () => cleanup?.();
    },
  };
  return {
    wctx,
    registrations,
    disposeEffects() {
      for (const cleanup of effectCleanups.splice(0)) cleanup?.();
    },
  };
}

async function call(registration, options) {
  const res = makeRes();
  await registration.config.handler(makeReq(options), res);
  return res;
}

async function mountWith(api, { trustedHosts = [] } = {}) {
  const ctx = makeContext();
  injectWebRoutes(ctx, api, {});
  const startup = makeWctx('webStartup', trustedHosts);
  const injection = ctx.injections.find((item) => item.deps.includes('webStartup'));
  injection.callback(startup.wctx);
  assert.equal(startup.registrations.length, 1);
  return { startup, registration: startup.registrations[0] };
}

test('injectWebRoutes：同源 POST 按白名单分发', async () => {
  const api = {
    status: async (params) => ({ servers: [], counts: { total: 0 }, echo: params }),
  };
  const { registration } = await mountWith(api);
  assert.equal(registration.config.kind, 'prefix');
  assert.equal(registration.config.path, '/mcp-bar/api');

  const res = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: { method: 'status', params: { tab: 'all' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(res.json(), { ok: true, servers: [], counts: { total: 0 }, echo: { tab: 'all' } });
});

test('injectWebRoutes：信任 fence 与 HTTP 方法限制', async () => {
  const { registration } = await mountWith({ status: async () => ({}) });

  const forbidden = await call(registration, {
    headers: { host: 'evil.example' },
    body: { method: 'status' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(forbidden.json(), { ok: false, message: 'forbidden' });

  const crossSite = await call(registration, {
    headers: { host: 'localhost:4173', 'sec-fetch-site': 'cross-site' },
    body: { method: 'status' },
  });
  assert.equal(crossSite.statusCode, 403);

  const get = await call(registration, {
    method: 'GET',
    headers: { host: 'localhost:4173' },
  });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, 'POST');
});

test('injectWebRoutes：trustedHosts 允许额外来源', async () => {
  const { registration } = await mountWith(
    { status: async () => ({ trusted: true }) },
    { trustedHosts: ['harness.test:1234'] },
  );
  const allowed = await call(registration, {
    headers: { host: 'harness.test:1234', origin: 'http://harness.test:1234' },
    body: { method: 'status' },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().trusted, true);
});

test('injectWebRoutes：未知方法、坏 JSON 与超限请求体', async () => {
  const { registration } = await mountWith({ status: async () => ({}) });

  const unknown = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: { method: 'evalEverything' },
  });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().message, /未知方法「evalEverything」/);

  const inherited = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: { method: 'constructor' },
  });
  assert.equal(inherited.statusCode, 400);
  assert.match(inherited.json().message, /未知方法/);

  const badJson = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: '{nope',
  });
  assert.equal(badJson.statusCode, 400);
  assert.match(badJson.json().message, /不是合法 JSON/);

  const empty = await call(registration, {
    headers: { host: 'localhost:4173' },
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().message, /未知方法/);

  const huge = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: JSON.stringify({ method: 'status', params: { padding: 'x'.repeat(1024 * 1024 + 64) } }),
  });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json().message, /不能超过 1 MiB/);
});

test('injectWebRoutes：错误响应保留 ProbeError kind', async () => {
  const api = {
    probe: async () => {
      throw new ProbeError('凭据无效', 'auth');
    },
    create: async () => {
      throw new Error('名称已存在');
    },
  };
  const { registration } = await mountWith(api);

  const auth = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: { method: 'probe', params: { id: 'x' } },
  });
  assert.equal(auth.statusCode, 400);
  assert.deepEqual(auth.json(), { ok: false, message: '凭据无效', kind: 'auth' });

  const generic = await call(registration, {
    headers: { host: 'localhost:4173' },
    body: { method: 'create', params: {} },
  });
  assert.equal(generic.statusCode, 400);
  assert.deepEqual(generic.json(), { ok: false, message: '名称已存在' });
});

test('injectWebRoutes：webRuntime 回退与热切换', async () => {
  const ctx = makeContext();
  injectWebRoutes(ctx, { status: async () => ({ ok: 1 }) }, {});

  const runtime = makeWctx('webRuntime', ['runtime.test:1']);
  const runtimeInjection = ctx.injections.find((item) => item.deps.includes('webRuntime'));
  runtimeInjection.callback(runtime.wctx);
  assert.equal(runtime.registrations.length, 1);
  assert.equal(runtime.registrations[0].disposed, false);

  const startup = makeWctx('webStartup');
  const startupInjection = ctx.injections.find((item) => item.deps.includes('webStartup'));
  startupInjection.callback(startup.wctx);
  assert.equal(runtime.registrations[0].disposed, true, 'webStartup 到位后应卸载 webRuntime 路由');
  assert.equal(startup.registrations.length, 1);

  startup.disposeEffects();
  assert.equal(startup.registrations[0].disposed, true);
  assert.equal(runtime.registrations.length, 2, 'webStartup 退出后应回退到 webRuntime');

  runtime.disposeEffects();
  assert.equal(runtime.registrations[1].disposed, true);
});
