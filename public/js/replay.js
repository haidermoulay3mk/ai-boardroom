import { h } from './util.js';

const CHARS_PER_SECOND = 120;
const SPEEDS = [1, 2, 4, 8];
const PHASE = { intake: 'intake', welcome: 'opening', opening: 'opening', moderate: 'debate', response: 'debate', founder: 'debate', ballot: 'ballot', verdict: 'verdict' };

const clone = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Plays a saved session back through the same view the live meeting uses. */
export class Replay {
  constructor(session, view) {
    this.src = session;
    this.view = view;
    this.speedIndex = 0;
    this.paused = false;
    this.finished = false;
    this.token = 0;
    view.setReplayBar(this.buildBar());
  }

  get speed() {
    return SPEEDS[this.speedIndex];
  }

  start() {
    this.finished = false;
    this.paused = false;
    this.playButton.textContent = 'Pause';
    this.view.reset();
    this.run(++this.token);
  }

  stop() {
    this.token++;
  }

  buildBar() {
    this.playButton = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.togglePlay() }, 'Pause');
    this.speedButton = h(
      'button',
      {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        title: 'Playback speed',
        onclick: () => {
          this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
          this.speedButton.textContent = `${this.speed}×`;
        },
      },
      '1×',
    );
    this.progress = h('span', { class: 'replay-fill' });
    return h(
      'div',
      { class: 'replay-bar' },
      h('span', { class: 'replay-label' }, h('span', { class: 'rec-dot' }), 'Replay'),
      this.playButton,
      this.speedButton,
      h('span', { class: 'replay-track', role: 'progressbar', 'aria-label': 'Replay progress' }, this.progress),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => this.finish() }, 'Skip to verdict'),
      h('a', { class: 'btn btn-sm btn-ghost', href: `#/s/${this.src.id}` }, 'Exit'),
    );
  }

  togglePlay() {
    if (this.finished) return this.start();
    this.paused = !this.paused;
    this.playButton.textContent = this.paused ? 'Play' : 'Pause';
  }

  setProgress(fraction) {
    this.progress.style.width = `${Math.round(fraction * 100)}%`;
  }

  /** Waits ms (scaled by nothing — callers divide by speed), honouring pause. False if the replay was stopped. */
  async wait(ms, token) {
    let left = ms;
    while (left > 0) {
      if (token !== this.token) return false;
      if (this.paused) {
        await sleep(120);
        continue;
      }
      const step = Math.min(left, 40);
      await sleep(step);
      left -= step;
    }
    return token === this.token;
  }

  async run(token) {
    const src = this.src;
    const s = { ...clone(src), status: 'running', phase: 'intake', intake: null, turns: [], rounds: [], ballots: [], verdict: null, pending: null, queue: [], live: [], stats: { calls: 0 } };
    this.view.update(s);
    const turns = src.turns;
    for (let i = 0; i < turns.length; i++) {
      if (token !== this.token) return;
      const t = turns[i];
      this.setProgress(i / turns.length);
      s.phase = PHASE[t.kind] ?? s.phase;
      s.stats.calls = Math.round((src.stats.calls * i) / turns.length);

      if (t.kind === 'founder') {
        s.turns.push(t);
        this.view.update(s);
        if (!(await this.wait(900 / this.speed, token))) return;
        continue;
      }
      if (t.kind === 'ballot') {
        s.live = [{ id: t.id, speaker: t.speaker, kind: 'ballot', text: '', startedAt: t.startedAt }];
        this.view.update(s);
        if (!(await this.wait(380 / this.speed, token))) return;
        s.live = [];
        s.turns.push(t);
        const ballot = src.ballots.find(b => b.turnId === t.id);
        if (ballot) s.ballots.push(ballot);
        this.view.update(s);
        continue;
      }

      const live = { id: t.id, speaker: t.speaker, kind: t.kind, round: t.round, text: '', startedAt: t.startedAt };
      s.live = [live];
      this.view.update(s);
      if (!(await this.wait(380 / this.speed, token))) return;
      for (let c = 0; c < t.text.length; ) {
        const n = Math.max(2, Math.round(3 * this.speed));
        const chunk = t.text.slice(c, c + n);
        c += n;
        live.text += chunk;
        this.view.delta(t.id, chunk);
        if (!(await this.wait((chunk.length / (CHARS_PER_SECOND * this.speed)) * 1000, token))) return;
      }
      s.live = [];
      s.turns.push(t);
      if (t.kind === 'intake') s.intake = clone(src.intake);
      if (t.kind === 'moderate') {
        const round = src.rounds.find(r => r.moderatorTurnId === t.id);
        if (round) s.rounds.push(round);
      }
      if (t.kind === 'verdict') s.verdict = src.verdict;
      this.view.update(s);
      if (!(await this.wait((t.kind === 'intake' ? 1800 : 520) / this.speed, token))) return;
    }
    this.finish();
  }

  finish() {
    this.token++;
    this.finished = true;
    this.playButton.textContent = 'Replay again';
    const s = clone(this.src);
    s.live = [];
    this.view.update(s);
    this.setProgress(1);
    setTimeout(() => this.view.scrollToVerdict(), 80);
  }
}
