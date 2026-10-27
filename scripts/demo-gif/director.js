// Stop-motion director for the README GIF. Runs inside http://localhost:3737/ (home screen loaded).
// It drives the app's real SessionView through the saved Claude session one frame at a time:
//   window.__go(i)   -> render frame i, wait for it to settle, return its GIF delay (ms)
//   window.__seek(k) -> fast-forward through frames 0..k-1 (to resume after a headless crash)
(async () => {
  const ID = window.__DEMO_SESSION__;
  const [{ SessionView }, health, full] = await Promise.all([
    import('/js/session-view.js'),
    fetch('/api/health').then(r => r.json()),
    fetch('/api/sessions/' + ID).then(r => r.json()),
  ]);
  const clone = o => JSON.parse(JSON.stringify(o));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frames = [];
  const add = (run, delay, settle = 520) => frames.push({ run, delay, settle });
  const turn = (speaker, kind) => full.turns.find(t => t.speaker === speaker && t.kind === kind);

  let v = null;
  let s = null;

  // Live-typing helpers: start a live turn, reveal it in chunks, then commit the finished turn.
  const startLive = t => add(() => {
    s.live = [{ id: t.id, speaker: t.speaker, kind: t.kind, round: t.round, text: '', startedAt: t.startedAt }];
    v.update(s);
  }, 160, 380);
  const type = (t, fractions) => {
    let shown = 0;
    for (const f of fractions) {
      add(() => {
        const upto = Math.round(t.text.length * f);
        const chunk = t.text.slice(shown, upto);
        shown = upto;
        s.live[0].text += chunk;
        v.delta(t.id, chunk);
      }, 120, 160);
    }
  };
  const finish = (t, extra, delay = 260) => add(() => {
    s.live = [];
    s.turns.push(t);
    s.stats.calls += 1;
    extra?.();
    v.update(s);
  }, delay);
  const speak = (t, fractions, extra, delay) => {
    startLive(t);
    type(t, fractions);
    finish(t, extra, delay);
  };

  // 1. Home: type the decision, press Convene.
  const input = () => document.querySelector('.decision-input');
  const text = full.input.decision;
  add(() => { input().value = ''; input().focus(); }, 900);
  for (const f of [0.1, 0.22, 0.36, 0.5, 0.64, 0.78, 0.9, 1]) {
    add(() => { input().value = text.slice(0, Math.round(text.length * f)); }, f === 1 ? 1200 : 90, 120);
  }
  add(() => {
    const b = document.querySelector('.btn-lg');
    b.disabled = true;
    b.firstChild.textContent = 'Convening…';
  }, 450, 200);

  // 2. Session opens; the chair reads the brief and asks questions.
  const intake = turn('chair', 'intake');
  add(() => {
    s = clone(full);
    Object.assign(s, { status: 'running', phase: 'intake', intake: null, turns: [], rounds: [], ballots: [], verdict: null, pending: null, queue: [], live: [], stats: { calls: 0 } });
    document.querySelectorAll('.hist-item').forEach(a => a.classList.toggle('is-current', a.dataset.id === ID));
    v = new SessionView(document.getElementById('view'), { mode: 'live', health, actions: {} });
    window.scrollTo(0, 0);
    s.live = [{ id: intake.id, speaker: 'chair', kind: 'intake', text: '', startedAt: intake.startedAt }];
    v.update(s);
  }, 300, 450);
  type(intake, [0.35, 0.7]);
  finish(intake, () => {
    s.intake = { ...clone(full.intake), answers: null };
    s.status = 'awaiting_user';
    s.pending = { type: 'intake', questions: s.intake.questions };
  }, 1500);

  // 3. The founder answers.
  full.intake.questions.forEach((q, i) => {
    add(() => {
      const box = document.querySelector(`.questions textarea[name="${q.id}"]`);
      if (box) {
        box.value = full.intake.answers[q.id] ?? '';
        box.scrollIntoView({ block: 'center' });
      }
    }, i === full.intake.questions.length - 1 ? 900 : 380, 200);
  });
  add(() => {
    s.intake.answers = clone(full.intake.answers);
    s.status = 'running';
    s.pending = null;
    s.phase = 'opening';
    v.update(s);
  }, 200, 300);

  // 4. The meeting opens: welcome, two openings typed live, the rest arrive quickly.
  speak(turn('chair', 'welcome'), [0.4, 0.75], undefined, 300);
  speak(turn('buffett', 'opening'), [0.25, 0.5, 0.75], undefined, 400);
  speak(turn('cardone', 'opening'), [0.3, 0.6], undefined, 400);
  for (const id of ['graham', 'hormozi', 'bezos', 'vaynerchuk', 'wickman', 'martell']) {
    finish(turn(id, 'opening'), undefined, 300);
  }

  // 5. Round 1: the chair goes at the disagreement; Grant concedes, Dan builds on it.
  const mod = turn('chair', 'moderate');
  startLive(mod);
  const startMod = frames[frames.length - 1].run;
  frames[frames.length - 1].run = () => {
    s.phase = 'debate';
    startMod();
  };
  type(mod, [0.45, 0.85]);
  finish(mod, () => s.rounds.push(clone(full.rounds[0])), 500);
  speak(turn('cardone', 'response'), [0.35, 0.7], undefined, 700);
  speak(turn('martell', 'response'), [0.35, 0.7], undefined, 500);

  // 6. Sealed ballots, revealed in pairs.
  const order = full.input.advisors;
  add(() => {
    s.phase = 'ballot';
    s.live = order.slice(0, 4).map(id => ({ id: 'live-' + id, speaker: id, kind: 'ballot', text: '', startedAt: '' }));
    v.update(s);
    document.querySelector('.ballots')?.scrollIntoView({ block: 'center' });
  }, 500, 450);
  for (let i = 0; i < order.length; i += 2) {
    add(() => {
      for (const id of order.slice(i, i + 2)) {
        const b = full.ballots.find(x => x.advisorId === id);
        const t = full.turns.find(x => x.id === b.turnId);
        s.turns.push(t);
        s.ballots.push(b);
        s.stats.calls += 1;
      }
      s.live = order.slice(i + 2, i + 6).filter(id => !s.ballots.some(b => b.advisorId === id)).map(id => ({ id: 'live-' + id, speaker: id, kind: 'ballot', text: '', startedAt: '' }));
      v.update(s);
      document.querySelector('.ballots')?.scrollIntoView({ block: 'center' });
    }, 420, 650);
  }

  // 7. The verdict: score counts up, ring fills, then a look at the scorecard.
  const verdictTurn = turn('chair', 'verdict');
  add(() => {
    s.phase = 'verdict';
    s.live = [{ id: verdictTurn.id, speaker: 'chair', kind: 'verdict', text: '', startedAt: '' }];
    v.update(s);
  }, 160, 350);
  type(verdictTurn, [0.18, 0.36]);
  add(() => {
    s.live = [];
    s.turns.push(verdictTurn);
    s.verdict = clone(full.verdict);
    s.stats.calls = full.stats.calls;
    s.status = 'done';
    s.phase = 'done';
    v.update(s);
    document.querySelector('#verdict')?.scrollIntoView();
    window.scrollBy(0, -24);
  }, 110, 90);
  add(() => {}, 110, 160);
  add(() => {}, 110, 200);
  add(() => {}, 2600, 900);
  add(() => window.scrollBy({ top: 330, behavior: 'instant' }), 2400, 500);

  window.__frames = frames;
  window.__go = async i => {
    if (i >= frames.length) return -1;
    await frames[i].run();
    await sleep(frames[i].settle);
    return frames[i].delay;
  };
  window.__seek = async k => {
    for (let i = 0; i < k; i++) await frames[i].run();
    await sleep(700);
    return k;
  };
  return JSON.stringify(frames.map(f => f.delay));
})();
