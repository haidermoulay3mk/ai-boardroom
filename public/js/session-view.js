import { api } from './api.js';
import { optionColor, TableView } from './table.js';
import { fmtDate, h, latestLeaning, optionLabel, profile, reducedMotion, rich, toast, visibleSpeech } from './util.js';

const STEPS = ['Brief', 'Questions', 'Openings', 'Debate', 'Vote', 'Verdict'];
const SPECIAL = new Set(['intake', 'ballot', 'verdict']);
const FALLBACK_ROUNDS = { quick: 1, standard: 2, deep: 3 };
const STATUS_LABEL = {
  running: 'In session',
  awaiting_user: 'Waiting for you',
  done: 'Verdict reached',
  error: 'Stopped',
  cancelled: 'Adjourned',
  interrupted: 'Interrupted',
};

function stepIndex(s) {
  if (s.status === 'done') return STEPS.length;
  switch (s.phase) {
    case 'intake':
      return s.intake ? 1 : 0;
    case 'opening':
      return 2;
    case 'debate':
      return 3;
    case 'ballot':
      return 4;
    case 'verdict':
      return 5;
    default:
      return STEPS.length;
  }
}

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
const scrollToBottom = smooth => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
const divider = text => h('div', { class: 'divider', role: 'separator' }, h('span', { text }));

function setRich(el, text) {
  el.innerHTML = text ? rich(text) : '';
}

/** Keyed DOM reconciliation: create, patch in place, reorder, remove. */
function reconcile(parent, items, desired) {
  const keep = new Set(desired.map(d => d.key));
  for (const [key, item] of items) {
    if (!keep.has(key)) {
      item.el.remove();
      items.delete(key);
    }
  }
  let prev = null;
  for (const d of desired) {
    let item = items.get(d.key);
    if (!item) {
      item = { el: d.render(null), sig: d.sig };
      items.set(d.key, item);
    } else if (item.sig !== d.sig) {
      const el = d.render(item.el);
      if (el !== item.el) {
        item.el.replaceWith(el);
        item.el = el;
      }
      item.sig = d.sig;
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (want !== item.el) parent.insertBefore(item.el, want);
    prev = item.el;
  }
}

/**
 * Renders a session: live from the server's event stream, or driven by the replay engine.
 * update(session) can be called any number of times; it patches the DOM in place.
 */
export class SessionView {
  constructor(root, opts = {}) {
    this.root = root;
    this.mode = opts.mode ?? 'live';
    this.actions = opts.actions ?? {};
    this.health = opts.health ?? null;
    this.items = new Map();
    this.raw = new Map();
    this.liveTargets = new Map();
    this.statusTargets = new Map();
    this.revealed = new Set();
    this.follow = true;
    this.lastY = window.scrollY;
    this.s = null;
    this.build();
    this.onScroll = () => {
      const y = window.scrollY;
      if (nearBottom()) this.follow = true;
      else if (y < this.lastY - 2) this.follow = false;
      this.lastY = y;
      this.jump.hidden = this.follow || !this.isActive();
    };
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  destroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  isActive() {
    return Boolean(this.s) && (this.mode === 'replay' || this.s.status === 'running' || this.s.status === 'awaiting_user');
  }

  reset() {
    this.items.clear();
    this.raw.clear();
    this.liveTargets.clear();
    this.statusTargets.clear();
    this.revealed.clear();
    this.feed.replaceChildren();
    this.follow = true;
  }

  // ------------------------------------------------------------------ skeleton

  build() {
    this.kicker = h('div', { class: 'session-kicker' });
    this.title = h('h1', { class: 'session-title' });
    this.decision = h('p', { class: 'session-decision' });
    this.stepper = h(
      'ol',
      { class: 'stepper', 'aria-label': 'Meeting progress' },
      STEPS.map(label => h('li', {}, h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'step-label', text: label }))),
    );
    this.toolbar = h('div', { class: 'session-toolbar' });
    this.ribbon = h('button', { class: 'verdict-ribbon', type: 'button', hidden: true, onclick: () => this.scrollToVerdict() });
    this.banner = h('div', { class: 'banner', hidden: true, role: 'status' });
    this.feed = h('div', { class: 'feed' });
    this.composer = this.buildComposer();
    this.panel = h('aside', { class: 'table-panel', 'aria-label': 'The table' });
    this.table = new TableView(this.panel);
    this.legend = h('div', { class: 'legend' });
    this.panelStats = h('p', { class: 'panel-stats' });
    this.panel.append(this.legend, this.panelStats);
    this.jump = h('button', { class: 'jump', type: 'button', hidden: true, onclick: () => { this.follow = true; scrollToBottom(true); } }, 'Back to live ↓');

    const head = h('header', { class: 'session-head' }, this.kicker, this.title, this.decision, this.stepper, h('div', { class: 'head-row' }, this.toolbar, this.ribbon));
    const minutes = h('div', { class: 'minutes' }, this.banner, this.feed, this.composer);
    this.root.replaceChildren(h('section', { class: `session session--${this.mode}` }, head, h('div', { class: 'session-body' }, minutes, this.panel)), this.jump);
  }

  buildComposer() {
    const input = h('input', { class: 'composer-input', type: 'text', maxlength: 1500, placeholder: 'Raise your hand: say something to the board…', 'aria-label': 'Say something to the board' });
    const send = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Speak' });
    this.composerHint = h('p', { class: 'composer-hint' });
    const form = h('form', { class: 'composer', hidden: true }, h('div', { class: 'composer-row' }, input, send), this.composerHint);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await this.actions.interject?.(text);
        input.value = '';
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        send.disabled = false;
      }
    });
    return form;
  }

  setReplayBar(el) {
    this.toolbar.replaceChildren(el);
  }

  connection(ok) {
    this.root.querySelector('.session')?.classList.toggle('is-offline', !ok);
  }

  // ------------------------------------------------------------------ updates

  update(s) {
    const first = !this.s;
    this.s = s;
    for (const l of s.live) this.raw.set(l.id, l.text);
    this.renderHead();
    this.renderPanel();
    this.renderFeed();
    this.renderComposer();
    this.renderBanner();
    if (first && this.mode === 'live' && !this.isActive()) this.follow = false;
    if (this.follow && this.isActive()) scrollToBottom(false);
  }

  delta(id, text) {
    const raw = (this.raw.get(id) ?? '') + text;
    this.raw.set(id, raw);
    this.liveTargets.get(id)?.(raw);
    const status = this.statusTargets.get(id);
    if (status && status.textContent) status.textContent = '';
    if (this.follow && this.isActive()) scrollToBottom(false);
  }

  status(id, message) {
    const el = this.statusTargets.get(id);
    if (el) el.textContent = message;
  }

  scrollToVerdict() {
    this.root.querySelector('#verdict')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------------ header

  renderHead() {
    const s = this.s;
    const label = this.mode === 'replay' ? 'Replay' : STATUS_LABEL[s.status] ?? s.status;
    this.kicker.replaceChildren(
      h('span', { class: `pill pill--${this.mode === 'replay' ? 'replay' : s.status}` }, h('span', { class: 'pill-dot' }), label),
      h('span', { text: fmtDate(s.createdAt, true) }),
      h('span', { text: s.input.provider === 'demo' ? 'Demo engine' : `Claude ${s.input.model}` }),
      h('span', { class: 'offline-note', text: 'Reconnecting…' }),
    );
    this.title.textContent = s.title;
    this.decision.textContent = s.input.decision;
    document.title = `${s.title} · Boardroom`;
    const step = stepIndex(s);
    [...this.stepper.children].forEach((li, i) => {
      li.className = i < step ? 'is-done' : i === step && s.status !== 'done' ? 'is-active' : '';
    });

    if (this.mode === 'live') {
      const id = s.id;
      const active = s.status === 'running' || s.status === 'awaiting_user';
      const buttons = [];
      if (active) buttons.push(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => this.actions.cancel?.() }, 'Adjourn'));
      if (s.status === 'done') {
        buttons.push(
          h('a', { class: 'btn btn-sm', href: `#/s/${id}/replay` }, '▶  Replay'),
          h('a', { class: 'btn btn-sm', href: api.pdfUrl(id), download: '' }, 'PDF report'),
          h('a', { class: 'btn btn-ghost btn-sm', href: api.mdUrl(id), download: '' }, 'Markdown'),
        );
      }
      if (!active) {
        buttons.push(
          h('button', {
            class: 'btn btn-ghost btn-sm btn-danger',
            type: 'button',
            onclick: () => {
              if (confirm('Delete this session and its saved file? This cannot be undone.')) this.actions.remove?.();
            },
          }, 'Delete'),
        );
      }
      this.toolbar.replaceChildren(...buttons);
    }

    const v = s.verdict;
    this.ribbon.hidden = !v || this.mode === 'replay';
    if (v) {
      this.ribbon.replaceChildren(
        h('span', { class: 'ribbon-kicker', text: 'Verdict' }),
        h('span', { class: 'ribbon-label', text: v.label }),
        h('span', { class: 'ribbon-score', text: `${v.score}/100` }),
        h('span', { class: 'ribbon-go', 'aria-hidden': 'true', text: '↓' }),
      );
    }
  }

  // ------------------------------------------------------------------ table panel

  renderPanel() {
    const s = this.s;
    const chair = s.cast.find(a => a.id === 'chair') ?? profile(s, 'chair');
    const advisors = s.input.advisors.map(id => profile(s, id));
    this.table.setCast(chair, advisors);
    const speaking = new Set(s.live.map(l => l.speaker));
    const state = { chair: { speaking: speaking.has('chair') }, founder: { speaking: s.status === 'awaiting_user' } };
    const counts = {};
    for (const a of advisors) {
      const ballot = s.ballots.find(b => b.advisorId === a.id);
      const lean = ballot?.vote ?? latestLeaning(s, a.id)?.leaning ?? null;
      if (lean) counts[lean] = (counts[lean] ?? 0) + 1;
      state[a.id] = { speaking: speaking.has(a.id), lean, voted: Boolean(ballot) };
    }
    this.table.setState(state);

    const rounds = this.health?.depths?.[s.input.depth]?.rounds ?? FALLBACK_ROUNDS[s.input.depth] ?? 2;
    const n = s.input.advisors.length;
    if (s.verdict) this.table.setCenter(String(s.verdict.score), 'out of 100');
    else if (s.phase === 'intake') this.table.setCenter(s.intake ? 'Questions' : 'Intake', s.status === 'awaiting_user' ? 'over to you' : 'the chair is reading');
    else if (s.phase === 'opening') this.table.setCenter('Openings', `${s.turns.filter(t => t.kind === 'opening').length} of ${n}`);
    else if (s.phase === 'debate') this.table.setCenter(`Round ${Math.max(1, Math.min(rounds, s.rounds.length))}`, `of ${rounds}`);
    else if (s.phase === 'ballot') this.table.setCenter('Voting', `${s.ballots.length} of ${n}`);
    else if (s.phase === 'verdict') this.table.setCenter('Verdict', 'the chair decides');
    else this.table.setCenter('', '');

    const options = s.intake?.options ?? [];
    const voting = s.ballots.length > 0;
    this.legend.replaceChildren(
      ...(options.length
        ? [
            h('div', { class: 'legend-head' }, h('span', { class: 'kicker', text: voting ? 'Votes' : 'Leaning' }), h('span', { class: 'legend-total', text: `${Object.values(counts).reduce((a, b) => a + b, 0)} of ${n}` })),
            ...options.map(o =>
              h(
                'div',
                { class: `legend-row${s.verdict?.recommendation === o.id ? ' is-rec' : ''}`, style: `--opt:${optionColor(o.id)}` },
                h('span', { class: 'opt-badge', text: o.id }),
                h('span', { class: 'legend-label', text: o.label }),
                h('span', { class: 'legend-count', text: String(counts[o.id] ?? 0) }),
                h('span', { class: 'legend-bar' }, h('span', { style: `width:${n ? ((counts[o.id] ?? 0) / n) * 100 : 0}%` })),
              ),
            ),
          ]
        : [h('p', { class: 'legend-empty', text: 'The chair frames the options after reading your decision.' })]),
    );
    this.panelStats.textContent = `${s.stats.calls} model call${s.stats.calls === 1 ? '' : 's'} · ${s.input.provider === 'demo' ? 'demo engine' : s.input.model}`;
  }

  // ------------------------------------------------------------------ feed

  renderFeed() {
    const s = this.s;
    const desired = [];
    const push = (key, sig, render) => desired.push({ key, sig, render });

    const intakeTurn = s.turns.find(t => t.kind === 'intake');
    const intakeLive = s.live.find(l => l.kind === 'intake');
    if (intakeTurn || intakeLive) {
      push('intake', [intakeTurn?.id, Boolean(s.intake), s.pending?.type, JSON.stringify(s.intake?.answers ?? null), s.status, this.mode].join('|'), el =>
        this.renderIntake(intakeTurn ?? intakeLive, !intakeTurn, el),
      );
    }

    let opened = false;
    const pushTurn = (t, live) => {
      if (t.kind === 'welcome' && !opened) {
        opened = true;
        push('div-open', 'x', () => divider('The meeting opens'));
      }
      if (t.kind === 'moderate') push(`div-r${t.round}`, 'x', () => divider(`Round ${t.round + 1}`));
      push(t.id, live ? 'live' : `done|${t.text.length}|${JSON.stringify(t.meta ?? null)}`, el => this.renderTurn(t, live, el));
      if (t.kind === 'moderate' && !live) {
        const r = s.rounds.find(x => x.moderatorTurnId === t.id);
        if (r?.askFounder) push(`ask-${r.index}`, [r.answered, s.pending?.type, s.status, this.mode].join('|'), () => this.renderAsk(r));
      }
    };
    for (const t of s.turns) if (!SPECIAL.has(t.kind)) pushTurn(t, false);
    for (const l of s.live) if (!SPECIAL.has(l.kind)) pushTurn(l, true);
    s.queue.forEach((text, i) => push(`queue-${i}-${text.length}`, 'q', () => this.renderQueued(text)));

    if (s.ballots.length || ['ballot', 'verdict', 'done'].includes(s.phase)) {
      const sig = JSON.stringify([s.ballots.map(b => b.advisorId), s.live.filter(l => l.kind === 'ballot').map(l => l.speaker), s.status]);
      push('ballots', sig, el => this.renderBallots(el));
    }
    const verdictLive = s.live.find(l => l.kind === 'verdict');
    if (s.verdict || verdictLive) {
      push('verdict', s.verdict ? `final|${s.verdict.score}|${s.verdict.label}|${this.mode}` : `live|${verdictLive.id}`, () => this.renderVerdict(verdictLive));
    }
    reconcile(this.feed, this.items, desired);
  }

  renderTurn(t, live, el) {
    const s = this.s;
    const who = t.speaker === 'chair' ? profile(s, 'chair') : profile(s, t.speaker);
    const role = t.speaker === 'founder' ? 'founder' : t.speaker === 'chair' ? 'chair' : 'advisor';
    if (!el) {
      el = h(
        'article',
        { class: `turn turn--${role}`, style: `--accent:${who.color}` },
        h('div', { class: 'turn-avatar', 'aria-hidden': 'true', text: who.initials }),
        h('div', { class: 'turn-body' }, h('header', { class: 'turn-head' }), h('div', { class: 'turn-text' }), h('p', { class: 'turn-status', 'aria-live': 'polite' })),
      );
    }
    const head = el.querySelector('.turn-head');
    const parts = [h('span', { class: 'turn-name', text: role === 'chair' ? 'The Chair' : who.name })];
    if (role === 'advisor' && who.title) parts.push(h('span', { class: 'turn-title', text: who.title }));
    if (!live && role === 'advisor' && typeof t.meta?.leaning === 'string') {
      const index = s.turns.findIndex(x => x.id === t.id);
      const before = latestLeaning(s, t.speaker, index);
      parts.push(
        h(
          'span',
          { class: 'lean', style: `--opt:${optionColor(t.meta.leaning)}`, title: 'Current leaning' },
          h('b', { text: t.meta.leaning }),
          optionLabel(s, t.meta.leaning),
          t.meta.conviction ? h('span', { class: 'lean-conv', text: `${t.meta.conviction}/10` }) : null,
        ),
      );
      if (before && before.leaning !== t.meta.leaning) parts.push(h('span', { class: 'shift', text: `moved from ${before.leaning}` }));
    }
    if (live) parts.push(h('span', { class: 'speaking-tag', text: 'speaking' }));
    head.replaceChildren(...parts);
    el.classList.toggle('is-live', live);

    const textEl = el.querySelector('.turn-text');
    const status = el.querySelector('.turn-status');
    if (live) {
      this.liveTargets.set(t.id, raw => setRich(textEl, visibleSpeech(raw)));
      this.statusTargets.set(t.id, status);
      setRich(textEl, visibleSpeech(this.raw.get(t.id) ?? t.text));
    } else {
      this.liveTargets.delete(t.id);
      this.statusTargets.delete(t.id);
      setRich(textEl, t.text);
      status.textContent = '';
    }
    return el;
  }

  renderQueued(text) {
    const el = this.renderTurn({ id: `q-${Math.random()}`, speaker: 'founder', kind: 'founder', text }, false, null);
    el.classList.add('is-queued');
    el.querySelector('.turn-status').textContent = 'Hand raised. You get the floor when the current speaker finishes.';
    return el;
  }

  renderIntake(turn, live, el) {
    const s = this.s;
    el = el ?? h('section', { class: 'intake' });
    el.replaceChildren(this.renderTurn(turn, live, null));
    if (!s.intake) return el;

    el.append(
      h(
        'div',
        { class: 'framing card' },
        h('span', { class: 'card-kicker', text: 'On the table' }),
        h('p', { class: 'framing-text', text: s.intake.framing }),
        h(
          'ul',
          { class: 'options' },
          s.intake.options.map(o =>
            h('li', { class: 'option', style: `--opt:${optionColor(o.id)}` }, h('span', { class: 'opt-badge', text: o.id }), h('span', {}, h('strong', { text: o.label }), o.description ? h('span', { class: 'option-desc', text: o.description }) : null)),
          ),
        ),
      ),
    );

    const questions = s.intake.questions;
    if (!questions.length) return el;
    const canAnswer = this.mode === 'live' && s.status === 'awaiting_user' && s.pending?.type === 'intake';
    if (canAnswer) el.append(this.questionForm(questions));
    else {
      el.append(
        h(
          'dl',
          { class: 'qa card' },
          h('span', { class: 'card-kicker', text: 'Your answers' }),
          questions.map(q => [h('dt', { text: q.text }), h('dd', { class: s.intake.answers?.[q.id] ? '' : 'is-skipped', text: s.intake.answers?.[q.id] || 'Skipped' })]),
        ),
      );
    }
    return el;
  }

  questionForm(questions) {
    const fields = questions.map((q, i) =>
      h(
        'label',
        { class: 'q' },
        h('span', { class: 'q-num', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'q-main' }, h('span', { class: 'q-text', text: q.text }), q.why ? h('span', { class: 'q-why', text: q.why }) : null, h('textarea', { name: q.id, rows: 2, maxlength: 2000, placeholder: 'Your answer' })),
      ),
    );
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Answer and begin', h('span', { class: 'btn-arrow', 'aria-hidden': 'true', text: '→' }));
    const skip = h('button', { class: 'btn btn-ghost', type: 'button', text: 'Skip the questions' });
    const form = h('form', { class: 'questions card' }, h('span', { class: 'card-kicker', text: 'Before the board weighs in' }), fields, h('div', { class: 'form-actions' }, submit, skip, h('span', { class: 'form-hint', text: 'Ctrl + Enter to send' })));
    const send = async blank => {
      const answers = {};
      for (const q of questions) answers[q.id] = blank ? '' : form.querySelector(`[name="${q.id}"]`)?.value ?? '';
      submit.disabled = skip.disabled = true;
      try {
        await this.actions.answer?.(answers);
      } catch (err) {
        toast(err.message, 'error');
        submit.disabled = skip.disabled = false;
      }
    };
    form.addEventListener('submit', e => {
      e.preventDefault();
      send(false);
    });
    form.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send(false);
      }
    });
    skip.addEventListener('click', () => send(true));
    setTimeout(() => form.querySelector('textarea')?.focus({ preventScroll: true }), 60);
    return form;
  }

  renderAsk(r) {
    const s = this.s;
    const el = h('div', { class: 'ask card' }, h('span', { class: 'card-kicker', text: 'The chair asks you' }), h('p', { class: 'ask-q', text: r.askFounder }));
    const open = this.mode === 'live' && !r.answered && s.status === 'awaiting_user' && s.pending?.type === 'chair';
    if (open) {
      const input = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Your answer', 'aria-label': 'Your answer' });
      const submit = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Answer' });
      const skip = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Skip' });
      const form = h('form', { class: 'ask-form' }, input, h('div', { class: 'form-actions' }, submit, skip));
      const send = async text => {
        submit.disabled = skip.disabled = true;
        try {
          await this.actions.answer?.({ answer: text });
        } catch (err) {
          toast(err.message, 'error');
          submit.disabled = skip.disabled = false;
        }
      };
      form.addEventListener('submit', e => {
        e.preventDefault();
        send(input.value);
      });
      skip.addEventListener('click', () => send(''));
      el.append(form);
      setTimeout(() => input.focus({ preventScroll: true }), 60);
    } else if (r.answered && !r.founderAnswer) {
      el.append(h('p', { class: 'ask-note', text: 'You skipped this one.' }));
    }
    return el;
  }

  renderBallots(el) {
    const s = this.s;
    if (!el) {
      el = h(
        'section',
        { class: 'ballots' },
        h('header', { class: 'section-head' }, h('span', { class: 'kicker', text: 'Sealed ballots' }), h('h2', { text: 'The vote' })),
        h('div', { class: 'ballot-grid' }),
      );
    }
    const grid = el.querySelector('.ballot-grid');
    const deliberating = new Set(s.live.filter(l => l.kind === 'ballot').map(l => l.speaker));
    grid.replaceChildren(
      ...s.input.advisors.map((id, i) => {
        const who = profile(s, id);
        const b = s.ballots.find(x => x.advisorId === id);
        const fresh = b && !this.revealed.has(id);
        if (b) this.revealed.add(id);
        const state = b ? 'is-revealed' : deliberating.has(id) ? 'is-deliberating' : 'is-waiting';
        return h(
          'div',
          { class: `ballot ${state}${fresh ? ' is-new' : ''}`, style: `--accent:${who.color};--opt:${b ? optionColor(b.vote) : 'var(--ink-3)'};--i:${i}` },
          h('div', { class: 'ballot-who' }, h('span', { class: 'ballot-avatar', text: who.initials }), h('span', { class: 'ballot-name', text: who.name })),
          b
            ? [
                h('div', { class: 'ballot-vote' }, h('span', { class: 'opt-badge', text: b.vote }), h('span', { text: optionLabel(s, b.vote) })),
                h('div', { class: 'pips', 'aria-label': `Conviction ${b.conviction} of 10` }, Array.from({ length: 10 }, (_, k) => h('span', { class: `pip${k < b.conviction ? ' on' : ''}` }))),
                h('p', { class: 'ballot-reason', text: b.reason }),
              ]
            : h('div', { class: 'ballot-sealed', text: deliberating.has(id) ? 'Deliberating…' : 'Waiting to vote' }),
        );
      }),
    );
    return el;
  }

  renderVerdict(liveTurn) {
    const s = this.s;
    const v = s.verdict;
    const el = h('section', { class: 'verdict', id: 'verdict' });
    if (!v) {
      const text = h('div', { class: 'verdict-pending-text' });
      setRich(text, visibleSpeech(this.raw.get(liveTurn.id) ?? ''));
      this.liveTargets.set(liveTurn.id, raw => setRich(text, visibleSpeech(raw)));
      el.append(h('div', { class: 'verdict-pending card' }, h('span', { class: 'card-kicker', text: 'The chair is weighing the arguments' }), text));
      return el;
    }
    this.liveTargets.clear();
    const options = s.intake?.options ?? [];

    // Headline card
    const scoreNum = h('span', { class: 'score-num', text: reducedMotion() ? String(v.score) : '0' });
    const circumference = 2 * Math.PI * 52;
    const ring = h('span', { class: 'score-ring' });
    ring.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" class="ring-track"/><circle cx="60" cy="60" r="52" class="ring-fill" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${circumference.toFixed(1)}"/></svg>`;
    ring.append(h('span', { class: 'score-inner' }, scoreNum, h('span', { class: 'score-of', text: '/100' })));
    const tally = h(
      'div',
      { class: 'tally' },
      h('div', { class: 'tally-bar' }, options.map(o => h('span', { class: 'tally-seg', style: `--opt:${optionColor(o.id)};flex:${v.tally[o.id] ?? 0}`, title: `${o.label}: ${v.tally[o.id] ?? 0}` }))),
      h('div', { class: 'tally-legend' }, options.map(o => h('span', { style: `--opt:${optionColor(o.id)}` }, h('i', {}), `${o.label} `, h('b', { text: String(v.tally[o.id] ?? 0) })))),
    );
    el.append(
      h(
        'div',
        { class: 'verdict-card' },
        h(
          'div',
          { class: 'verdict-main' },
          h('span', { class: 'card-kicker', text: 'The board recommends' }),
          h('h2', { class: 'verdict-label', text: v.label }),
          v.headline ? h('p', { class: 'verdict-headline', text: v.headline }) : null,
          tally,
        ),
        h('div', { class: 'verdict-score' }, ring, h('span', { class: `confidence confidence--${v.confidence}`, text: `${v.confidence} confidence` })),
      ),
    );

    // Scorecard
    const criteria = this.health?.criteria ?? v.scores[0]?.criteria.map(c => ({ id: c.id, label: c.id, weight: '' })) ?? [];
    const sc = h('div', { class: 'scorecard', style: `--cols:${options.length}` });
    sc.append(h('div', { class: 'sc-row sc-head' }, h('span', { class: 'sc-crit', text: 'Criterion' }), options.map(o => h('span', { class: `sc-opt${o.id === v.recommendation ? ' is-rec' : ''}`, style: `--opt:${optionColor(o.id)}`, title: o.label }, h('span', { class: 'opt-badge', text: o.id }), h('span', { class: 'sc-opt-label', text: o.label })))));
    for (const c of criteria) {
      sc.append(
        h(
          'div',
          { class: 'sc-row' },
          h('span', { class: 'sc-crit' }, c.label, c.weight ? h('span', { class: 'sc-weight', text: `${c.weight}%` }) : null),
          options.map(o => {
            const cell = v.scores.find(x => x.optionId === o.id)?.criteria.find(x => x.id === c.id);
            const score = cell?.score ?? 0;
            return h(
              'span',
              { class: `sc-cell${o.id === v.recommendation ? ' is-rec' : ''}`, title: cell?.why || '' },
              h('span', { class: 'sc-bar' }, h('span', { class: 'sc-fill', style: `--w:${score * 10}%` })),
              h('span', { class: 'sc-num', text: String(score) }),
            );
          }),
        ),
      );
    }
    sc.append(
      h(
        'div',
        { class: 'sc-row sc-total' },
        h('span', { class: 'sc-crit', text: 'Weighted total' }),
        options.map(o => h('span', { class: `sc-cell${o.id === v.recommendation ? ' is-rec' : ''}` }, h('b', { text: String(v.scores.find(x => x.optionId === o.id)?.total ?? '–') }))),
      ),
    );
    el.append(h('div', { class: 'card scorecard-card' }, h('span', { class: 'card-kicker', text: 'Scorecard' }), h('p', { class: 'sc-note', text: 'Each option scored 1 to 10 per criterion. Hover a score for the reasoning.' }), sc));

    // Chair's speech
    const speech = h('div', { class: 'verdict-speech-text' });
    setRich(speech, v.speech);
    el.append(h('div', { class: 'verdict-speech' }, h('span', { class: 'card-kicker', text: 'The chair’s verdict' }), speech));

    // Detail blocks
    const name = id => (id ? profile(s, id).name : '');
    const block = (title, body, wide = false) => (body ? h('div', { class: `vblock${wide ? ' vblock--wide' : ''}` }, h('h3', { text: title }), body) : null);
    const list = (items, ordered = false) => (items.length ? h(ordered ? 'ol' : 'ul', {}, items.map(x => h('li', {}, x))) : null);
    const attributed = items => list(items.map(x => [x.text, x.by ? h('span', { class: 'by', text: ` ${name(x.by)}` }) : null]));
    el.append(
      h(
        'div',
        { class: 'verdict-grid' },
        block('Next 14 days', list(v.nextSteps, true), true),
        block('Strongest case for', attributed(v.strongestFor)),
        block('Strongest case against', attributed(v.strongestAgainst)),
        block('Conditions', list(v.conditions)),
        block('Key risks', list(v.risks.map(r => [h('strong', { text: r.risk }), r.mitigation ? h('span', { class: 'mitigation', text: ` → ${r.mitigation}` }) : null]))),
        block('What would change the verdict', list(v.wouldChange)),
        block('Dissent', v.dissent ? h('p', { text: v.dissent }) : null),
      ),
    );

    if (this.mode === 'live') {
      el.append(
        h(
          'div',
          { class: 'verdict-actions' },
          h('a', { class: 'btn btn-primary', href: api.pdfUrl(s.id), download: '' }, 'Download PDF report'),
          h('a', { class: 'btn', href: `#/s/${s.id}/replay` }, '▶  Replay the meeting'),
          h('a', { class: 'btn btn-ghost', href: api.mdUrl(s.id), download: '' }, 'Export Markdown'),
          h('a', { class: 'btn btn-ghost', href: '#/' }, 'New decision'),
        ),
      );
    }

    // Count the score up and draw the ring once the card is in the DOM.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.querySelector('.ring-fill')?.setAttribute('stroke-dashoffset', (circumference * (1 - v.score / 100)).toFixed(1));
        el.querySelectorAll('.sc-fill').forEach(f => f.classList.add('is-drawn'));
        if (reducedMotion()) return;
        const start = performance.now();
        const tick = now => {
          const p = Math.min(1, (now - start) / 1100);
          scoreNum.textContent = String(Math.round(v.score * (1 - Math.pow(1 - p, 3))));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    );
    return el;
  }

  // ------------------------------------------------------------------ composer + banner

  renderComposer() {
    const s = this.s;
    const show = this.mode === 'live' && s.status === 'running' && (s.phase === 'opening' || s.phase === 'debate');
    this.composer.hidden = !show;
    if (!show) return;
    const speaker = s.live[0] ? profile(s, s.live[0].speaker) : null;
    this.composerHint.textContent = speaker
      ? `You get the floor when ${speaker.id === 'chair' ? 'the chair' : speaker.short} finishes.`
      : 'The board will hear you next.';
  }

  renderBanner() {
    const s = this.s;
    if (this.mode !== 'live') {
      this.banner.hidden = true;
      return;
    }
    const resume = label => h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => this.actions.resume?.() }, label);
    let content = null;
    let kind = 'info';
    if (s.status === 'error') {
      kind = 'error';
      content = [h('div', {}, h('strong', { text: 'The meeting stopped.' }), h('p', { text: s.error ?? 'Something went wrong.' })), resume('Retry')];
    } else if (s.status === 'cancelled') {
      content = [h('div', {}, h('strong', { text: 'You adjourned the meeting.' }), h('p', { text: 'Everything said so far is saved. Pick up where it stopped whenever you like.' })), resume('Resume')];
    } else if (s.status === 'interrupted') {
      content = [h('div', {}, h('strong', { text: 'The meeting was interrupted.' }), h('p', { text: 'Boardroom stopped while this session was running. Everything said so far is saved.' })), resume('Resume')];
    }
    this.banner.hidden = !content;
    this.banner.className = `banner banner--${kind}`;
    if (content) this.banner.replaceChildren(...content);
  }
}
