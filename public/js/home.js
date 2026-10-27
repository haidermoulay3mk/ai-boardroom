import { api } from './api.js';
import { TableView } from './table.js';
import { h, store, toast } from './util.js';

const EXAMPLES = [
  { label: 'Quit my job for my startup?', text: 'Should I quit my job to work full-time on my startup? I have 3 paying customers and 6 months of savings.' },
  { label: 'Raise prices 40%?', text: 'Should I raise my prices by 40% for new customers, even if some existing ones leave?' },
  { label: 'Take $50k for 20%?', text: 'An angel offered $50k for 20% of my company. Should I take it?' },
  { label: 'Hire my first employee?', text: 'Should I hire my first employee now, or keep doing everything myself for six more months?' },
];

/** The "new decision" screen. Returns a cleanup function. */
export function renderHome(root, { health, cast, onCreated }) {
  const claude = health.providers['claude-code'];
  const claudeReady = !health.demoOnly && claude.ready;
  const draft = store.get('draft') ?? {};
  const allIds = cast.advisors.map(a => a.id);
  let seated = new Set((draft.seated ?? allIds).filter(id => allIds.includes(id)));
  if (seated.size < 2) seated = new Set(allIds);
  let provider = claudeReady ? (draft.provider === 'demo' ? 'demo' : 'claude-code') : 'demo';
  let warmed = '';

  const decision = h('textarea', {
    class: 'decision-input',
    name: 'decision',
    rows: 4,
    maxlength: 5000,
    required: true,
    placeholder: 'Should I quit my job to go full-time on my booking app? I have 3 paying salons and 6 months of savings.',
    'aria-label': 'The decision',
  });
  decision.value = draft.decision ?? '';
  const context = h('textarea', {
    class: 'context-input',
    name: 'context',
    rows: 4,
    maxlength: 6000,
    placeholder: 'Numbers, constraints, what you have tried, what worries you. The chair will ask about anything important you leave out.',
    'aria-label': 'Context',
  });
  context.value = draft.context ?? '';

  const depthSel = segmented(
    'depth',
    Object.entries(health.depths).map(([id, d]) => ({ id, label: d.label, title: d.note })),
    draft.depth && health.depths[draft.depth] ? draft.depth : 'standard',
  );
  const model = h('select', { name: 'model', 'aria-label': 'Model' }, ...health.models.map(m => h('option', { value: m.id, title: m.note, text: m.label })));
  model.value = health.models.some(m => m.id === draft.model) ? draft.model : health.models[0]?.id ?? 'sonnet';
  const engineSel = segmented(
    'engine',
    [
      { id: 'claude-code', label: 'Claude Code', disabled: !claudeReady, title: claudeReady ? 'Real advisors, powered by your Claude Code plan' : claude.detail },
      { id: 'demo', label: 'Demo', title: 'Scripted advisors, no AI calls. Good for a first look.' },
    ],
    provider,
    value => {
      provider = value;
      model.disabled = provider === 'demo';
      save();
      warm();
    },
  );
  model.disabled = provider === 'demo';

  const seatCount = h('span', { class: 'seat-count' });
  const tableHost = h('div', { class: 'home-table' });
  const table = new TableView(tableHost, {
    interactive: true,
    onToggle: id => {
      if (seated.has(id)) {
        if (seated.size <= 2) return toast('Keep at least two advisors at the table.');
        seated.delete(id);
      } else seated.add(id);
      paintTable();
      save();
    },
  });
  table.setCast(cast.chair, cast.advisors);
  function paintTable() {
    const state = {};
    for (const id of allIds) state[id] = { off: !seated.has(id) };
    table.setState(state);
    table.setCenter(String(seated.size), seated.size === 1 ? 'advisor seated' : 'advisors seated');
    seatCount.textContent = `${seated.size} of ${allIds.length} seated`;
  }
  paintTable();

  const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Convene the board', h('span', { class: 'btn-arrow', 'aria-hidden': 'true', text: '→' }));

  const engineLine = claudeReady
    ? h('p', { class: 'engine-line' }, h('span', { class: 'dot dot--ok' }), `Claude Code ${claude.version ?? ''}${claude.plan ? ` · signed in (${claude.plan})` : ''}`)
    : h('p', { class: 'engine-line' }, h('span', { class: 'dot dot--warn' }), health.demoOnly ? 'Demo mode' : 'Claude Code not connected');

  const setup = claudeReady || health.demoOnly
    ? null
    : h(
        'div',
        { class: 'notice' },
        h('strong', { text: 'Connect Claude Code to get real advisors.' }),
        h('p', { text: claude.detail }),
        h('ol', {},
          h('li', {}, 'Install it: ', h('code', { text: 'npm install -g @anthropic-ai/claude-code' })),
          h('li', {}, 'Run ', h('code', { text: 'claude' }), ' once in a terminal and sign in.'),
          h('li', {}, 'Restart Boardroom. Until then, Demo mode shows how a meeting flows.'),
        ),
      );

  const form = h(
    'form',
    { class: 'brief', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'The decision' }), decision),
    h(
      'div',
      { class: 'examples', role: 'group', 'aria-label': 'Example decisions' },
      h('span', { class: 'examples-label', text: 'Try' }),
      ...EXAMPLES.map(ex =>
        h('button', { class: 'example', type: 'button', title: ex.text, onclick: () => { decision.value = ex.text; decision.focus(); save(); } }, ex.label),
      ),
    ),
    h(
      'details',
      { class: 'context', open: Boolean(draft.context) },
      h('summary', {}, 'Add context', h('span', { class: 'summary-note', text: 'optional' })),
      context,
    ),
    h(
      'div',
      { class: 'settings' },
      setting('Depth', depthSel.el),
      setting('Model', h('div', { class: 'select' }, model)),
      setting('Engine', engineSel.el),
    ),
    setup,
    h('div', { class: 'submit-row' }, submit, engineLine),
  );

  const section = h(
    'section',
    { class: 'home' },
    h(
      'div',
      { class: 'home-grid' },
      h(
        'div',
        { class: 'home-main' },
        h('p', { class: 'kicker', text: 'A board meeting for one' }),
        h('h1', { class: 'home-title' }, 'What’s the ', h('em', { text: 'hard call' }), '?'),
        h('p', {
          class: 'lede',
          text: 'Bring the decision you keep going back and forth on. Eight advisors argue it out, the chair keeps them honest, and you leave with a scored verdict.',
        }),
        form,
      ),
      h(
        'aside',
        { class: 'home-aside', 'aria-label': 'Who is at the table' },
        h('div', { class: 'aside-head' }, h('span', { class: 'kicker', text: 'Who’s at the table' }), seatCount),
        tableHost,
        h('p', { class: 'seat-hint', text: 'Tap an advisor to unseat them for this meeting.' }),
      ),
    ),
    h(
      'p',
      { class: 'disclaimer' },
      'Advisors are AI simulations inspired by the publicly known ideas of the people named. They are not affiliated with or endorsed by them. Not financial, legal or professional advice.',
    ),
  );
  root.replaceChildren(section);

  function save() {
    store.set('draft', { decision: decision.value, context: context.value, seated: [...seated], provider, depth: depthSel.value(), model: model.value });
  }
  function warm() {
    // Boot a Claude Code process while you type, so the chair answers instantly.
    if (provider !== 'claude-code' || warmed === model.value) return;
    warmed = model.value;
    api.warm(model.value).catch(() => {});
  }

  let saveTimer;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  };
  decision.addEventListener('input', queueSave);
  context.addEventListener('input', queueSave);
  decision.addEventListener('focus', warm);
  model.addEventListener('change', () => {
    save();
    warm();
  });
  form.addEventListener('change', save);
  decision.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = decision.value.trim();
    if (text.length < 12) {
      decision.focus();
      return toast('Describe the decision in at least one full sentence.');
    }
    submit.disabled = true;
    submit.firstChild.textContent = 'Convening…';
    try {
      const { id } = await api.create({
        decision: text,
        context: context.value.trim(),
        advisors: [...seated],
        depth: depthSel.value(),
        model: model.value,
        provider,
      });
      store.set('draft', { ...store.get('draft'), decision: '', context: '' });
      onCreated(id);
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
      submit.firstChild.textContent = 'Convene the board';
    }
  });

  if (!decision.value) setTimeout(() => decision.focus({ preventScroll: true }), 50);
  return () => {
    clearTimeout(saveTimer);
    save();
  };
}

function setting(label, control) {
  return h('div', { class: 'setting' }, h('span', { class: 'setting-label', text: label }), control);
}

/** Radio-group "pills". Returns { el, value() }. */
function segmented(name, options, selected, onChange) {
  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
  for (const o of options) {
    const input = h('input', { type: 'radio', name, value: o.id, checked: o.id === selected, disabled: o.disabled });
    input.addEventListener('change', () => input.checked && onChange?.(o.id));
    el.append(h('label', { class: `seg${o.disabled ? ' is-disabled' : ''}`, title: o.title ?? '' }, input, h('span', { text: o.label })));
  }
  return { el, value: () => el.querySelector('input:checked')?.value ?? selected };
}
