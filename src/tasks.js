// The shared to-do list: one KV value, written whole by the page or the Mac
// app. Last write wins; `updatedAt` (KV metadata) lets clients spot changes.
const KEY = 'study:tasks';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export async function readTasks(store) {
  const { value, metadata } = await store.getWithMetadata(KEY, 'json');
  if (value !== null) return { tasks: value, updatedAt: metadata?.updatedAt ?? 0 };
  return { tasks: await readLegacyTasks(store), updatedAt: 0 };
}

export async function writeTasks(store, tasks) {
  const updatedAt = Date.now();
  await store.put(KEY, JSON.stringify(tasks), { metadata: { updatedAt } });
  return updatedAt;
}

// Tasks from the older list keys, read-only, until the first write. Distinct
// tasks with identical text or colliding IDs are kept apart.
async function readLegacyTasks(store) {
  const [todo, today, legacy] = await Promise.all([
    store.get('list:todo', 'json'), store.get('list:today', 'json'), store.get('todos', 'json'),
  ]);
  const used = new Set();
  return [[todo ?? legacy ?? [], false], [today ?? [], true]].flatMap(([items, selected]) => items.map((item, index) => {
    let id = validId(item.id) ? item.id : `legacy-${selected ? 'today' : 'todo'}-${index}`;
    const base = id.slice(0, 65);
    let suffix = 0;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id);
    return { id, text: item.text, done: Boolean(item.done), today: selected };
  }));
}

export function validTasks(tasks) {
  return Array.isArray(tasks) && tasks.length <= 1000 && tasks.every(task =>
    task && validId(task.id) && typeof task.text === 'string' && task.text.length <= 1000 &&
    typeof task.done === 'boolean' && typeof task.today === 'boolean'
  ) && new Set(tasks.map(task => task.id)).size === tasks.length;
}
