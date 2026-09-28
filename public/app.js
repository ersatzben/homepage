import { loadTasks, saveTasks, onTasksChanged, onSyncStatus, syncTasks } from './store.js';

const $ = (selector) => document.querySelector(selector);
const TZ = 'Europe/London';

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}
const STAR = '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>';

function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

let toastTimer;
function toast(message, undo) {
  const box = $('#toast');
  box.replaceChildren(message);
  if (undo) {
    box.append(el('button', { textContent: 'Undo', onclick: () => { undo(); box.hidden = true; } }));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

// ---- Clock ---------------------------------------------------------------

function tick() {
  const now = new Date();
  $('#date').textContent = now.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  $('#time').textContent = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
tick();
setInterval(tick, 15_000);

// ---- Tasks ---------------------------------------------------------------

let tasks = loadTasks();

function commit(next) {
  tasks = next;
  if (!saveTasks(tasks)) toast('Could not save — browser storage is unavailable.');
  renderTasks();
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function taskItem(task) {
  const text = el('span', { className: 'text', textContent: task.text, title: 'Click to edit' });
  text.onclick = () => editTask(task, text);
  return el('li', { draggable: true, className: task.done ? 'done' : '', dataset: { id: task.id } },
    el('input', {
      type: 'checkbox', checked: task.done, ariaLabel: `Done: ${task.text}`,
      onchange: () => commit(tasks.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t))),
    }),
    text,
    el('button', {
      className: 'row-action', title: task.today ? 'Move to Later' : 'Move to Today',
      ariaLabel: `${task.today ? 'Move to Later' : 'Move to Today'}: ${task.text}`,
      onclick: () => commit([...tasks.filter((t) => t.id !== task.id), { ...task, today: !task.today }]),
    }, icon(task.today ? '<path d="M8 3v10M4 9l4 4 4-4"/>' : '<path d="M8 13V3M4 7l4-4 4 4"/>')),
    el('button', {
      className: 'row-action', title: 'Delete', ariaLabel: `Delete: ${task.text}`,
      onclick: () => removeTasks([task.id]),
    }, icon('<path d="M4 4l8 8M12 4l-8 8"/>')),
  );
}

function editTask(task, span) {
  const input = el('input', { value: task.text, maxLength: 1000, className: 'edit', ariaLabel: 'Edit task' });
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (!save || value === task.text) return renderTasks();
    if (!value) return removeTasks([task.id]);
    commit(tasks.map((t) => (t.id === task.id ? { ...t, text: value } : t)));
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  span.replaceWith(input);
  input.focus();
}

function removeTasks(ids) {
  const before = tasks;
  commit(tasks.filter((t) => !ids.includes(t.id)));
  toast(ids.length === 1 ? 'Deleted.' : `Cleared ${ids.length} tasks.`, () => commit(before));
}

function renderTasks() {
  for (const list of ['today', 'later']) {
    const items = tasks.filter((t) => t.today === (list === 'today'));
    $(`#${list}`).replaceChildren(...items.map(taskItem));
    const open = items.filter((t) => !t.done).length;
    $(`#${list}-count`).textContent = open ? `${open} open` : '';
    $(`[data-clear=${list}]`).hidden = !items.some((t) => t.done);
  }
}

for (const form of document.querySelectorAll('form[data-add]')) {
  form.onsubmit = (event) => {
    event.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    commit([...tasks, { id: newId(), text, done: false, today: form.dataset.add === 'today' }]);
    form.reset();
  };
}

for (const button of document.querySelectorAll('[data-clear]')) {
  const today = button.dataset.clear === 'today';
  button.onclick = () => removeTasks(tasks.filter((t) => t.done && t.today === today).map((t) => t.id));
}

// Drag within or between lists. The drop position is "before the item under
// the pointer", or the end of the list.
let dragId = null;
for (const ul of document.querySelectorAll('ul[data-list]')) {
  ul.addEventListener('dragstart', (event) => {
    dragId = event.target.closest('li')?.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
  });
  ul.addEventListener('dragend', () => { dragId = null; });
  ul.addEventListener('dragover', (event) => { if (dragId) event.preventDefault(); });
  ul.addEventListener('drop', (event) => {
    event.preventDefault();
    const dragged = tasks.find((t) => t.id === dragId);
    if (!dragged) return;
    const target = event.target.closest('li');
    let beforeId = null;
    if (target && target.dataset.id !== dragId) {
      const { top, height } = target.getBoundingClientRect();
      beforeId = event.clientY < top + height / 2 ? target.dataset.id : target.nextElementSibling?.dataset.id ?? null;
    }
    const rest = tasks.filter((t) => t.id !== dragId);
    const moved = { ...dragged, today: ul.dataset.list === 'today' };
    let index = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
    if (index < 0) {
      // End of this list: after its last item, or at the end of everything.
      const last = rest.findLastIndex((t) => t.today === moved.today);
      index = last + 1 || rest.length;
    }
    rest.splice(index, 0, moved);
    commit(rest);
  });
}

onTasksChanged((next) => { tasks = next; renderTasks(); });
renderTasks();

onSyncStatus((status) => {
  if (status === 'offline') toast('Saved on this device. Sync will retry when the server is reachable.');
});

// ---- Rain ----------------------------------------------------------------

const RAIN_STEPS = 48; // 15-minute steps: the next 12 hours

function londonNow() {
  // "YYYY-MM-DDTHH:MM", comparable with Open-Meteo's local timestamps.
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T').slice(0, 16);
}

async function loadRain() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=51.5072&longitude=-0.1276'
      + '&current=temperature_2m,weather_code&minutely_15=precipitation&forecast_minutely_15=' + (RAIN_STEPS + 4)
      + '&hourly=precipitation_probability&forecast_hours=12&timezone=Europe%2FLondon';
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);
    const data = await response.json();

    const now = londonNow();
    const quarters = data.minutely_15.time
      .map((time, i) => ({ time, mm: data.minutely_15.precipitation[i] ?? 0 }))
      .filter((q, i, all) => (all[i + 1]?.time ?? '9') > now) // current quarter onwards
      .slice(0, RAIN_STEPS);
    const chance = Math.max(0, ...data.hourly.precipitation_probability.filter(Number.isFinite));

    $('#temp').textContent = `${Math.round(data.current.temperature_2m)}°C`;
    $('#weather-icon').innerHTML = WEATHER_ICONS[weatherKind(data.current.weather_code)];
    $('#rain-summary').textContent = summarise(quarters);
    $('#rain-chance').textContent = `${chance}% chance of rain`;
    $('#forecast').hidden = false;

    const peak = Math.max(0.5, ...quarters.map((q) => q.mm));
    $('#rain-bars').ariaLabel = $('#rain-summary').textContent;
    $('#rain-bars').replaceChildren(...quarters.map((q) => el('i', {
      title: `${q.time.slice(11)}: ${q.mm} mm`,
      style: `height:${q.mm > 0 ? Math.max(8, (q.mm / peak) * 100) : 2}%`,
      className: q.mm > 0 ? 'wet' : '',
    })));
    $('#rain-axis').replaceChildren(...quarters
      .map((q, i) => i % 12 === 0 && el('span', { textContent: q.time.slice(11), style: `left:${(i / quarters.length) * 100}%` }))
      .filter(Boolean));
  } catch (error) {
    $('#rain-summary').textContent = 'Forecast unavailable. It will retry in 30 minutes.';
    $('#rain-chance').textContent = '';
    if (!$('#rain-bars').childElementCount) $('#forecast').hidden = true;
  }
}

// WMO weather codes, reduced to the three icons we draw.
function weatherKind(code) {
  if (code >= 51) return 'rain';
  if (code >= 2) return 'cloud';
  return 'sun';
}
const CLOUD = '<path d="M4.5 12.5h7a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.8-.6A2.8 2.8 0 0 0 4.5 12.5z"/>';
const WEATHER_ICONS = {
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  cloud: CLOUD,
  rain: '<path d="M4.5 10h7a2.5 2.5 0 0 0 .3-5 3.5 3.5 0 0 0-6.8-.6A2.8 2.8 0 0 0 4.5 10z"/><path d="M5.5 12l-.5 2M8.5 12l-.5 2M11.5 12l-.5 2"/>',
};

function summarise(quarters) {
  const first = quarters.findIndex((q) => q.mm > 0);
  const total = quarters.reduce((sum, q) => sum + q.mm, 0);
  if (first < 0) return 'Dry for the next 12 hours';
  if (first === 0) {
    const dry = quarters.findIndex((q) => q.mm === 0);
    return dry < 0 ? `Raining for the next 12 hours, ${total.toFixed(1)} mm in total` : `Raining now, easing around ${quarters[dry].time.slice(11)}`;
  }
  return `Rain from ${quarters[first].time.slice(11)}, ${total.toFixed(1)} mm in total`;
}

loadRain();
setInterval(loadRain, 30 * 60_000);

// ---- Repos ---------------------------------------------------------------

let repos = [];
let pins = [];

const ago = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function relative(iso) {
  const days = Math.round((new Date(iso) - Date.now()) / 86_400_000);
  if (days > -1) return 'today';
  if (days > -30) return ago.format(days, 'day');
  if (days > -365) return ago.format(Math.round(days / 30), 'month');
  return ago.format(Math.round(days / 365), 'year');
}

function repoItem(repo) {
  const pinned = pins.includes(repo.name);
  const site = repo.pages_url || repo.homepage;
  return el('li', { className: repo.archived ? 'archived' : '' },
    el('button', {
      className: `pin${pinned ? ' on' : ''}`, ariaPressed: String(pinned),
      ariaLabel: `Star ${repo.name}`, title: pinned ? 'Unstar' : 'Star',
      onclick: () => togglePin(repo.name),
    }, icon(STAR)),
    el('span', { className: 'repo-name' },
      el('a', { href: repo.html_url, textContent: repo.name, title: repo.description ?? '' }),
      repo.private && el('span', { className: 'tag', textContent: 'private' }),
      site && el('a', { href: site, className: 'site', textContent: 'site', ariaLabel: `${repo.name} website` }),
    ),
    el('span', { className: 'meta' }, ...[repo.language, relative(repo.pushed_at), repo.archived && 'archived'].filter(Boolean).map((text) => el('span', { textContent: text }))),
  );
}

function renderRepos() {
  const query = $('#repo-search').value.trim().toLowerCase();
  const matches = repos.filter((r) => !query || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(query));
  const rank = (r) => (pins.includes(r.name) ? 0 : r.archived ? 2 : 1);
  matches.sort((a, b) => rank(a) - rank(b)); // stable: keeps pushed order within groups
  $('#repo-list').replaceChildren(...matches.map(repoItem));
  $('#repo-status').textContent = matches.length ? '' : query ? `No repositories match “${query}”.` : 'No repositories yet.';
}

async function togglePin(name) {
  const before = pins;
  pins = pins.includes(name) ? pins.filter((p) => p !== name) : [...pins, name];
  renderRepos();
  const response = await fetch('/api/pins', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pins),
  }).catch(() => null);
  if (!response?.ok) {
    pins = before;
    renderRepos();
    toast('Could not save the star.');
  }
}

async function loadRepos(fresh = false) {
  $('#repo-status').textContent = 'Loading…';
  $('#refresh').disabled = true;
  try {
    const repoResponse = await fetch(`/api/repos${fresh ? '?fresh=1' : ''}`);
    if (repoResponse.status === 401) return showLogin();
    if (!repoResponse.ok) throw new Error();
    const pinResponse = await fetch('/api/pins');
    repos = (await repoResponse.json()).repos;
    pins = pinResponse.ok ? await pinResponse.json() : [];
    $('#login').hidden = true;
    $('#repo-search').hidden = $('#refresh').hidden = $('#logout').hidden = false;
    renderRepos();
  } catch {
    $('#repo-status').textContent = 'GitHub is unavailable right now. Try Refresh in a minute.';
  } finally {
    $('#refresh').disabled = false;
  }
}

function showLogin() {
  repos = [];
  $('#repo-list').replaceChildren();
  $('#repo-status').textContent = '';
  $('#login').hidden = false;
  $('#repo-search').hidden = $('#refresh').hidden = $('#logout').hidden = true;
}

$('#login').onsubmit = async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const response = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: $('#passphrase').value }),
  }).catch(() => null);
  if (!response?.ok) {
    $('#login-error').textContent = response?.status === 403 ? 'Wrong passphrase.' : 'Could not sign in.';
    return;
  }
  $('#login').reset();
  syncTasks();
  loadRepos();
syncTasks();
};

$('#logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => null);
  showLogin();
};

$('#refresh').onclick = () => loadRepos(true);
$('#repo-search').oninput = renderRepos;

loadRepos();
syncTasks();
