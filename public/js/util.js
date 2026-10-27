/** Tiny DOM helper: h('div', { class: 'x', onclick }, child, 'text') */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value; // only ever given output of rich(), which escapes first
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** Escape, then allow paragraphs, line breaks, **bold** and *italic*. */
export function rich(text) {
  const blocks = esc(text).trim().split(/\n{2,}/).filter(Boolean);
  return blocks
    .map(block => {
      const inline = block
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>')
        .replace(/\n/g, '<br>');
      return `<p>${inline}</p>`;
    })
    .join('');
}

/** What the audience should see of a turn that is still streaming: drop the <meta> block, even half-written. */
export function visibleSpeech(raw) {
  let text = String(raw ?? '');
  const tag = text.search(/<meta\b/i);
  if (tag >= 0) text = text.slice(0, tag);
  const fence = text.search(/```(?:json)?\s*\{/i);
  if (fence >= 0) text = text.slice(0, fence);
  text = text.replace(/<(?:m(?:e(?:t(?:a)?)?)?)?$/i, '').replace(/`{1,3}(?:j(?:s(?:on?)?)?)?$/i, '');
  return text.replace(/^\s*(?:\*\*)?(?:The Chair|Chair)\s*:\s*(?:\*\*)?\s*/i, '');
}

export function profile(s, id) {
  if (id === 'founder') return { id, role: 'founder', name: 'You', short: 'You', initials: 'YOU', color: 'var(--brass)', title: '' };
  const p = s.cast.find(a => a.id === id);
  return p ?? { id, role: 'advisor', name: id, short: id, initials: id.slice(0, 2).toUpperCase(), color: '#5b6472', title: '' };
}

export function optionLabel(s, id) {
  return s.intake?.options.find(o => o.id === id)?.label ?? id ?? '';
}

/** The most recent position an advisor has stated (opening or debate turn). */
export function latestLeaning(s, id, beforeIndex = s.turns.length) {
  for (let i = Math.min(beforeIndex, s.turns.length) - 1; i >= 0; i--) {
    const t = s.turns[i];
    if (t.speaker === id && t.meta && typeof t.meta.leaning === 'string') return { leaning: t.meta.leaning, conviction: t.meta.conviction ?? null };
  }
  return null;
}

export function fmtDate(iso, withTime = false) {
  const d = new Date(iso);
  const opts = withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function toast(message, kind = 'info') {
  const host = document.querySelector('.toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
  host.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 320);
  }, kind === 'error' ? 6500 : 3800);
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(`boardroom:${key}`) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`boardroom:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable; drafts just won't persist
    }
  },
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
