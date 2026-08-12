const HANDLE = 'ersatzben';
const GH_API = 'https://api.github.com';
const SESSION_COOKIE = 'desk_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const REPO_CACHE_SECONDS = 300;
const README_FETCH_CAP = 45; // README + Pages fetches share this budget, under the 50-subrequest free-plan limit

const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return b64url(new Uint8Array(signature));
}

// Constant-time string comparison: compare fixed-length digests so length
// differences leak nothing.
async function safeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function makeSessionCookie(env) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const signature = await hmac(env.SESSION_SECRET, String(expires));
  const value = `${expires}.${signature}`;
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function isAuthenticated(request, env) {
  if (!env.SESSION_SECRET) return false;
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature) return false;
  if (Number(expires) < Date.now() / 1000) return false;
  const expected = await hmac(env.SESSION_SECRET, expires);
  return safeEqual(signature, expected);
}

function githubHeaders(env) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'desk-worker',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

// First few meaningful lines of a README: badges and images skipped,
// markdown markers stripped.
function readmeLines(text, max = 5) {
  const lines = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\[?!\[/.test(line)) continue;
    line = line
      .replace(/^#+\s*/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*_`]/g, '')
      .trim();
    if (line) lines.push(line);
    if (lines.length >= max) break;
  }
  return lines;
}

async function fetchReadmePreview(repoName, env) {
  const response = await fetch(`${GH_API}/repos/${HANDLE}/${repoName}/readme`, {
    headers: { ...githubHeaders(env), Accept: 'application/vnd.github.raw+json' },
  });
  if (!response.ok) return [];
  return readmeLines(await response.text());
}

// The Pages config carries the custom domain (e.g. science.works) when one is
// set. Requires the token to have Pages: read — returns null without it.
async function fetchPagesUrl(repoName, env) {
  const response = await fetch(`${GH_API}/repos/${HANDLE}/${repoName}/pages`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.html_url || null;
}

async function fetchRepos(env) {
  const endpoint = env.GITHUB_TOKEN
    ? `${GH_API}/user/repos?per_page=100&type=all&sort=pushed`
    : `${GH_API}/users/${HANDLE}/repos?per_page=100&sort=pushed`;

  const response = await fetch(endpoint, { headers: githubHeaders(env) });
  if (!response.ok) {
    throw new Error(`GitHub responded ${response.status}`);
  }

  const repos = (await response.json())
    .filter((repo) => repo.owner.login === HANDLE)
    .map((repo) => ({
      name: repo.name,
      html_url: repo.html_url,
      homepage: repo.homepage,
      has_pages: repo.has_pages,
      description: repo.description,
      language: repo.language,
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      pushed_at: repo.pushed_at,
      created_at: repo.created_at,
      size: repo.size,
      private: repo.private,
      fork: repo.fork,
      archived: repo.archived,
    }));

  // Attach README previews and Pages URLs in one batch, within the
  // ~50-subrequest free-plan limit. Repos missing a GitHub description use the
  // README's first line as one.
  const pagesRepos = repos.filter((repo) => repo.has_pages);
  const readmeCap = Math.max(0, README_FETCH_CAP - pagesRepos.length);
  await Promise.all([
    ...repos.slice(0, readmeCap).map(async (repo) => {
      try {
        let lines = await fetchReadmePreview(repo.name, env);
        if (!repo.description && lines.length > 0) {
          repo.description = lines[0];
        }
        if (lines[0] === repo.description) lines = lines.slice(1);
        repo.readme = lines.slice(0, 3);
      } catch (error) {
        repo.readme = [];
      }
    }),
    ...pagesRepos.map(async (repo) => {
      try {
        repo.pages_url = await fetchPagesUrl(repo.name, env);
      } catch (error) {
        repo.pages_url = null;
      }
    }),
  ]);

  return repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
}

async function handleRepos(url, env) {
  const tokenPresent = Boolean(env.GITHUB_TOKEN);
  const fresh = url.searchParams.get('fresh') === '1';
  const cached = await env.DESK_STORE.get('repos-cache', 'json');
  // A cache written without a token holds public repos only; ignore it once
  // a token exists.
  const cacheUsable = cached && Boolean(cached.tokenPresent) === tokenPresent;
  if (!fresh && cacheUsable && Date.now() - cached.fetchedAt < REPO_CACHE_SECONDS * 1000) {
    return json({ repos: cached.repos, cachedAt: cached.fetchedAt, tokenPresent });
  }
  try {
    const repos = await fetchRepos(env);
    const fetchedAt = Date.now();
    await env.DESK_STORE.put('repos-cache', JSON.stringify({ fetchedAt, repos, tokenPresent }));
    return json({ repos, cachedAt: fetchedAt, tokenPresent });
  } catch (error) {
    // GitHub is down or rate-limited: serve the stale cache rather than nothing.
    if (cacheUsable) {
      return json({ repos: cached.repos, cachedAt: cached.fetchedAt, tokenPresent, stale: true });
    }
    throw error;
  }
}

function validTodos(body) {
  return (
    Array.isArray(body) &&
    body.length <= 500 &&
    body.every(
      (item) =>
        item &&
        typeof item.text === 'string' &&
        item.text.length <= 1000 &&
        typeof item.done === 'boolean'
    )
  );
}

function validPins(body) {
  return (
    Array.isArray(body) &&
    body.length <= 500 &&
    body.every((item) => typeof item === 'string' && item.length <= 200)
  );
}

async function handleLogin(request, env) {
  if (!env.PASSPHRASE || !env.SESSION_SECRET) {
    return json({ error: 'Login is not configured yet.' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return json({ error: 'Bad request.' }, 400);
  }
  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
  const ok = await safeEqual(passphrase, env.PASSPHRASE);
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: 'Wrong passphrase.' }, 403);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(env) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    if (path === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
    }

    if (!(await isAuthenticated(request, env))) {
      return json({ error: 'Not signed in.' }, 401);
    }

    try {
      if (path === '/api/repos' && method === 'GET') {
        return await handleRepos(url, env);
      }

      if (path === '/api/todos' && method === 'GET') {
        const todos = (await env.DESK_STORE.get('todos', 'json')) || [];
        return json(todos);
      }

      if (path === '/api/todos' && method === 'PUT') {
        const body = await request.json();
        if (!validTodos(body)) return json({ error: 'Invalid to-do list.' }, 400);
        await env.DESK_STORE.put('todos', JSON.stringify(body));
        return json({ ok: true });
      }

      if (path === '/api/pins' && method === 'GET') {
        const pins = (await env.DESK_STORE.get('pins', 'json')) || [];
        return json(pins);
      }

      if (path === '/api/pins' && method === 'PUT') {
        const body = await request.json();
        if (!validPins(body)) return json({ error: 'Invalid pin list.' }, 400);
        await env.DESK_STORE.put('pins', JSON.stringify(body));
        return json({ ok: true });
      }
    } catch (error) {
      return json({ error: error.message || 'Something went wrong.' }, 502);
    }

    return json({ error: 'Not found.' }, 404);
  },
};
