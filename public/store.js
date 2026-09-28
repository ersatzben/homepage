// Task storage: a local copy in localStorage (instant, works offline) kept in
// sync with /api/tasks, which the Mac app shares. Last write wins.
//
// Task shape: { id: string, text: string, done: boolean, today: boolean }

const KEY = 'desk:tasks';
const DIRTY = 'desk:dirty'; // local changes not yet on the server
const SEEN = 'desk:updatedAt'; // server version the local copy matches
const SYNCED = 'desk:synced'; // set after the first merge with the server

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadTasks() {
  try {
    const tasks = JSON.parse(read(KEY));
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

const listeners = new Set();
let syncStatusListener = () => {};

function replaceLocal(tasks) {
  write(KEY, JSON.stringify(tasks));
  for (const listener of listeners) listener(tasks);
}

// Calls back with the new list when another tab or the server changes it.
export function onTasksChanged(callback) {
  listeners.add(callback);
}

// Calls back with 'ok', 'offline' (save failed, will retry) or 'signed-out'.
export function onSyncStatus(callback) {
  syncStatusListener = callback;
}

addEventListener('storage', (event) => {
  if (event.key === KEY) for (const listener of listeners) listener(loadTasks());
});

let pushTimer;
let edits = 0;

export function saveTasks(tasks) {
  edits++;
  const saved = write(KEY, JSON.stringify(tasks)) && write(DIRTY, '1');
  clearTimeout(pushTimer);
  if (lastStatus !== 'signed-out') pushTimer = setTimeout(push, 400);
  return saved;
}

async function request(method, body) {
  const response = await fetch('/api/tasks', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  }).catch(() => null);
  if (response?.status === 401) return 'signed-out';
  if (!response?.ok) return 'offline';
  return response.json();
}

let pushing = null;

async function push() {
  if (pushing) return pushing;
  pushing = (async () => {
    const editsAtStart = edits;
    const result = await request('PUT', loadTasks());
    if (typeof result === 'string') return report(result);
    write(SEEN, String(result.updatedAt));
    if (edits === editsAtStart) write(DIRTY, null);
    report('ok');
  })();
  try {
    await pushing;
  } finally {
    pushing = null;
  }
  if (read(DIRTY) && lastStatus === 'ok') push(); // edited while the save was in flight
}

let lastStatus = null;
function report(status) {
  if (status !== lastStatus) syncStatusListener(status);
  lastStatus = status;
  if (status === 'ok') startPolling();
  return status;
}

// Brings the local copy and the server together. The first time, both lists
// are merged so nothing added before syncing existed is lost.
export async function syncTasks() {
  await pushing;
  const result = await request('GET');
  if (typeof result === 'string') return report(result);
  const { tasks: server, updatedAt } = result;

  if (!read(SYNCED)) {
    const local = loadTasks();
    const known = new Set(local.map((task) => task.id));
    replaceLocal([...local, ...server.filter((task) => !known.has(task.id))]);
    write(SYNCED, '1');
    write(DIRTY, '1');
  }
  if (read(DIRTY)) return push();
  if (String(updatedAt) !== read(SEEN)) {
    write(SEEN, String(updatedAt));
    replaceLocal(server);
  }
  return report('ok');
}

// Once signed in, pick up changes from the Mac app or other devices.
let polling = false;
function startPolling() {
  if (polling) return;
  polling = true;
  setInterval(syncTasks, 60_000);
  addEventListener('focus', syncTasks);
  addEventListener('online', syncTasks);
}
