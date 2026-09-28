import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let worker, kv, cookie;
const origin = 'https://study.test';
async function request(path, options = {}) {
  const { auth = true, body, headers, ...rest } = options;
  return worker.dispatchFetch(origin + path, { ...rest, headers: { ...(auth && cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
before(async () => {
  const result = await build({ entryPoints: ['src/index.js'], bundle: true, format: 'esm', write: false });
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-08-01', kvNamespaces: ['DESK_STORE'], bindings: { PASSPHRASE: 'test-only-passphrase', SESSION_SECRET: 'test-only-secret-not-used-in-production', APP_TOKEN: 'test-only-app-token' }, serviceBindings: { ASSETS: () => new Response('static asset') } }));
  kv = await worker.getKVNamespace('DESK_STORE');
});
after(async () => worker?.dispose());

test('private APIs require a session; login issues a secure signed cookie', async () => {
  for (const path of ['/api/repos', '/api/pins', '/api/tasks']) {
    assert.equal((await request(path, { auth: false })).status, 401);
  }
  assert.equal((await request('/api/login', { auth: false, method: 'POST', body: { passphrase: 'wrong' } })).status, 403);
  const login = await request('/api/login', { auth: false, method: 'POST', body: { passphrase: 'test-only-passphrase' } });
  assert.equal(login.status, 200);
  const header = login.headers.get('Set-Cookie');
  assert.match(header, /HttpOnly; Secure; SameSite=Lax/);
  cookie = header.split(';')[0];
  assert.equal((await request('/api/pins')).status, 200);
  assert.equal((await request('/api/pins', { headers: { Cookie: cookie + 'tampered' } })).status, 401);
});

test('pins round-trip, reject invalid bodies and cross-origin writes', async () => {
  await kv.put('pins', JSON.stringify(['original-repo']));
  assert.deepEqual(await (await request('/api/pins')).json(), ['original-repo']);
  assert.equal((await request('/api/pins', { method: 'PUT', body: ['a', 'b'] })).status, 200);
  assert.deepEqual(await (await request('/api/pins')).json(), ['a', 'b']);
  assert.equal((await request('/api/pins', { method: 'PUT', body: [1] })).status, 400);
  assert.equal((await request('/api/pins', { method: 'PUT', body: '{' })).status, 400);
  assert.equal((await request('/api/pins', { method: 'PUT', body: [], headers: { Origin: 'https://other.test' } })).status, 403);
});

test('repos are served from a fresh cache without calling GitHub', async () => {
  const repos = [{ name: 'cached-repo' }];
  await kv.put('repos-cache', JSON.stringify({ fetchedAt: Date.now(), repos, tokenPresent: false }));
  const body = await (await request('/api/repos')).json();
  assert.deepEqual(body.repos, repos);
});

test('tasks read legacy lists until the first write, then round-trip with a version', async () => {
  const todo = [{ id: 'shared', text: 'One task', done: false }, { text: 'No ID yet', done: true }];
  const today = [{ id: 'shared', text: 'A separate task with the same old ID', done: true }];
  await kv.put('list:todo', JSON.stringify(todo));
  await kv.put('list:today', JSON.stringify(today));
  const legacy = await (await request('/api/tasks')).json();
  assert.equal(legacy.updatedAt, 0);
  assert.equal(legacy.tasks.length, 3);
  assert.equal(new Set(legacy.tasks.map((task) => task.id)).size, 3);
  assert.equal(legacy.tasks[2].today, true);

  const tasks = [{ id: 'a', text: 'Write the brief', done: false, today: true }];
  const saved = await (await request('/api/tasks', { method: 'PUT', body: tasks })).json();
  assert.ok(saved.updatedAt > 0);
  assert.deepEqual(await (await request('/api/tasks')).json(), { tasks, updatedAt: saved.updatedAt });
  assert.deepEqual(await kv.get('list:todo', 'json'), todo);

  assert.equal((await request('/api/tasks', { method: 'PUT', body: [] })).status, 200);
  assert.deepEqual((await (await request('/api/tasks')).json()).tasks, []);
});

test('task writes are validated and need a session or the app token', async () => {
  const task = { id: 'task', text: 'A task', done: false, today: true };
  for (const invalid of [[task, task], [{ ...task, today: 'yes' }], [{ ...task, done: 1 }], [{ ...task, id: '<unsafe>' }], [{ ...task, text: 'x'.repeat(1001) }], { tasks: [] }]) {
    assert.equal((await request('/api/tasks', { method: 'PUT', body: invalid })).status, 400);
  }
  assert.equal((await request('/api/tasks', { auth: false, method: 'PUT', body: [task] })).status, 401);
  assert.equal((await request('/api/tasks', { method: 'PUT', body: [task], headers: { Origin: 'https://other.test' } })).status, 403);

  const app = { auth: false, headers: { Authorization: 'Bearer test-only-app-token' } };
  assert.equal((await request('/api/tasks', { ...app, method: 'PUT', body: [task] })).status, 200);
  assert.deepEqual((await (await request('/api/tasks', app)).json()).tasks, [task]);
  assert.equal((await request('/api/tasks', { auth: false, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request('/api/pins', app)).status, 401);
});

test('removed study routes are gone', async () => {
  for (const path of ['/api/study', '/api/lists', '/api/layout', '/api/editions']) {
    assert.equal((await request(path)).status, 404);
  }
});
