import { api } from './api.js';
import { renderHome } from './home.js';
import { Replay } from './replay.js';
import { SessionView } from './session-view.js';
import { fmtDate, h, store, toast } from './util.js';

const main = document.getElementById('view');
const historyEl = document.getElementById('history');
const ctx = { health: null, cast: null };
let cleanup = null;
let currentId = null;
let historyKey = '';
let historyTimer = null;

// ------------------------------------------------------------------ theme

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function initTheme() {
  applyTheme(store.get('theme'));
  document.getElementById('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    applyTheme(next);
  });
}

// ------------------------------------------------------------------ history rail

const STATUS_NOTE = { running: 'In session', awaiting_user: 'Waiting for you', error: 'Stopped', cancelled: 'Adjourned', interrupted: 'Interrupted' };

async function refreshHistory() {
  let list;
  try {
    list = await api.sessions();
  } catch {
    return;
  }
  historyEl.replaceChildren(
    ...(list.length
      ? list.map(item =>
          h(
            'a',
            { class: `hist-item${item.id === currentId ? ' is-current' : ''}`, href: `#/s/${item.id}`, 'data-id': item.id },
            h('span', { class: 'hist-title', text: item.title }),
            h(
              'span',
              { class: 'hist-meta' },
              h('span', { text: fmtDate(item.createdAt) }),
              item.verdictLabel
                ? [h('b', { class: 'hist-score', text: String(item.score) }), h('span', { class: 'hist-label', text: item.verdictLabel })]
                : h('span', { class: `hist-status hist-status--${item.status}`, text: STATUS_NOTE[item.status] ?? '' }),
            ),
          ),
        )
      : [h('p', { class: 'hist-empty', text: 'Your past meetings will be filed here.' })]),
  );
}

/** Refresh the rail when something it shows (title, status, verdict) changes. */
function noteSession(s) {
  const key = `${s.id}|${s.title}|${s.status}|${s.verdict?.score ?? ''}`;
  if (key === historyKey) return;
  historyKey = key;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(refreshHistory, 250);
}

function markCurrent() {
  for (const el of historyEl.querySelectorAll('.hist-item')) el.classList.toggle('is-current', el.dataset.id === currentId);
}

// ------------------------------------------------------------------ views

function showHome() {
  currentId = null;
  document.title = 'Boardroom';
  return renderHome(main, {
    ...ctx,
    onCreated: id => {
      refreshHistory();
      location.hash = `#/s/${id}`;
    },
  });
}

function notFound(message) {
  main.replaceChildren(h('section', { class: 'empty' }, h('p', { class: 'kicker', text: 'Nothing here' }), h('h1', { text: message }), h('a', { class: 'btn btn-primary', href: '#/' }, 'New decision')));
}

function showSession(id) {
  currentId = id;
  let es = null;
  let closed = false;
  const view = new SessionView(main, {
    mode: 'live',
    health: ctx.health,
    actions: {
      answer: answers => api.answer(id, answers),
      interject: text => api.interject(id, text),
      cancel: () => api.cancel(id).catch(err => toast(err.message, 'error')),
      resume: () => api.resume(id).catch(err => toast(err.message, 'error')),
      remove: async () => {
        try {
          await api.remove(id);
          await refreshHistory();
          location.hash = '#/';
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
  });
  api
    .session(id)
    .then(s => {
      if (closed) return;
      view.update(s);
      noteSession(s);
      es = api.events(id);
      es.addEventListener('session', e => {
        const next = JSON.parse(e.data);
        view.update(next);
        noteSession(next);
      });
      es.addEventListener('delta', e => {
        const d = JSON.parse(e.data);
        view.delta(d.id, d.text);
      });
      es.addEventListener('status', e => {
        const d = JSON.parse(e.data);
        view.status(d.id, d.message);
      });
      es.addEventListener('open', () => view.connection(true));
      es.addEventListener('error', () => view.connection(false));
    })
    .catch(() => {
      if (!closed) notFound('That session doesn’t exist any more.');
    });
  return () => {
    closed = true;
    es?.close();
    view.destroy();
  };
}

function showReplay(id) {
  currentId = id;
  let replay = null;
  let closed = false;
  const view = new SessionView(main, { mode: 'replay', health: ctx.health });
  api
    .session(id)
    .then(s => {
      if (closed) return;
      if (!s.turns.length) return notFound('This session has nothing to replay yet.');
      replay = new Replay(s, view);
      replay.start();
    })
    .catch(() => {
      if (!closed) notFound('That session doesn’t exist any more.');
    });
  return () => {
    closed = true;
    replay?.stop();
    view.destroy();
  };
}

function route() {
  cleanup?.();
  cleanup = null;
  document.getElementById('rail').classList.remove('is-open');
  const hash = location.hash || '#/';
  let m;
  if ((m = /^#\/s\/([a-z0-9-]+)\/replay$/.exec(hash))) cleanup = showReplay(m[1]);
  else if ((m = /^#\/s\/([a-z0-9-]+)$/.exec(hash))) cleanup = showSession(m[1]);
  else cleanup = showHome();
  markCurrent();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ boot

async function boot() {
  initTheme();
  const toggle = document.getElementById('railToggle');
  toggle.addEventListener('click', () => {
    const rail = document.getElementById('rail');
    const open = !rail.classList.contains('is-open');
    rail.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  try {
    [ctx.health, ctx.cast] = await Promise.all([api.health(), api.advisors()]);
  } catch (err) {
    main.replaceChildren(h('section', { class: 'empty' }, h('p', { class: 'kicker', text: 'Connection problem' }), h('h1', { text: 'Boardroom’s server isn’t answering.' }), h('p', { text: `Is \`npm start\` still running? (${err.message})` })));
    return;
  }
  const claude = ctx.health.providers['claude-code'];
  document.getElementById('engineBadge').replaceChildren(
    h('span', { class: `dot ${claude.ready && !ctx.health.demoOnly ? 'dot--ok' : 'dot--warn'}` }),
    claude.ready && !ctx.health.demoOnly ? 'Claude Code' : 'Demo only',
  );
  window.addEventListener('hashchange', route);
  route();
  refreshHistory();
}

boot();
