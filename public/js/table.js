import { h } from './util.js';

const OPTION_VARS = { A: '--opt-a', B: '--opt-b', C: '--opt-c', D: '--opt-d' };
export const optionColor = id => `var(${OPTION_VARS[id] ?? '--ink-3'})`;

/** Points around the oval: advisors fill the right side top-to-bottom, then the left side bottom-to-top. */
function seatPositions(n) {
  const right = Math.ceil(n / 2);
  const left = n - right;
  const at = deg => {
    const r = (deg * Math.PI) / 180;
    return { x: 50 + 40 * Math.cos(r), y: 50 + 42 * Math.sin(r) };
  };
  const out = [];
  for (let i = 0; i < right; i++) out.push(at(-90 + (180 * (i + 1)) / (right + 1)));
  for (let i = 0; i < left; i++) out.push(at(90 + (180 * (i + 1)) / (left + 1)));
  return out;
}

const FOUNDER = { id: 'founder', name: 'You', short: 'You', initials: 'YOU', color: 'var(--brass)', title: 'The founder' };

/**
 * The overhead view of the boardroom table.
 * Interactive on the home screen (tap a seat to unseat an advisor), live during a meeting.
 */
export class TableView {
  constructor(container, { interactive = false, onToggle } = {}) {
    this.interactive = interactive;
    this.onToggle = onToggle;
    this.seats = new Map();
    this.key = '';
    this.centerMain = h('span', { class: 'table-center-main' });
    this.centerSub = h('span', { class: 'table-center-sub' });
    this.el = h(
      'div',
      { class: `table${interactive ? ' table--interactive' : ''}` },
      h('div', { class: 'table-oval' }, h('div', { class: 'table-center' }, this.centerMain, this.centerSub)),
      (this.seatsEl = h('div', { class: 'table-seats' })),
    );
    container.append(this.el);
  }

  setCast(chair, advisors) {
    const key = [chair.id, ...advisors.map(a => a.id)].join(',');
    if (key === this.key) return;
    this.key = key;
    this.seatsEl.replaceChildren();
    this.seats.clear();
    this.add(chair, { x: 50, y: 7 }, 'chair');
    seatPositions(advisors.length).forEach((pos, i) => this.add(advisors[i], pos, 'advisor'));
    this.add(FOUNDER, { x: 50, y: 93 }, 'founder');
  }

  add(p, pos, kind) {
    const lean = h('span', { class: 'seat-lean', hidden: true });
    const avatar = h('span', { class: 'seat-avatar' }, h('span', { class: 'seat-initials', text: p.initials }), lean);
    const label = kind === 'founder' ? null : h('span', { class: 'seat-name', text: kind === 'chair' ? 'Chair' : p.short });
    const attrs = {
      class: `seat seat--${kind}`,
      style: `left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%;--accent:${p.color}`,
      title: p.title ? `${p.name}, ${p.title}` : p.name,
      'data-id': p.id,
    };
    let seat;
    if (this.interactive && kind === 'advisor') {
      seat = h('button', { ...attrs, type: 'button', 'aria-pressed': 'true', 'aria-label': `${p.name}, ${p.title}. Seated.`, onclick: () => this.onToggle?.(p.id) }, avatar, label);
    } else {
      seat = h('div', attrs, avatar, label);
    }
    this.seatsEl.append(seat);
    this.seats.set(p.id, { el: seat, lean, profile: p });
  }

  /** state: { [id]: { speaking, lean, voted, off } } */
  setState(state) {
    for (const [id, seat] of this.seats) {
      const st = state[id] ?? {};
      seat.el.classList.toggle('is-speaking', Boolean(st.speaking));
      seat.el.classList.toggle('is-off', Boolean(st.off));
      seat.el.classList.toggle('has-voted', Boolean(st.voted));
      if (this.interactive && seat.profile && seat.el.tagName === 'BUTTON') {
        seat.el.setAttribute('aria-pressed', st.off ? 'false' : 'true');
        seat.el.setAttribute('aria-label', `${seat.profile.name}, ${seat.profile.title}. ${st.off ? 'Not seated' : 'Seated'}.`);
      }
      if (st.lean) {
        seat.lean.hidden = false;
        seat.lean.textContent = st.lean;
        seat.el.style.setProperty('--opt', optionColor(st.lean));
      } else {
        seat.lean.hidden = true;
      }
    }
  }

  setCenter(main, sub = '') {
    this.centerMain.textContent = main;
    this.centerSub.textContent = sub;
  }
}
