// Slovenian walking trainer — core loop.
// A session is a queue of pre-baked audio files (silences included), played through one
// <audio> element so it keeps going with the screen locked.

const $ = id => document.getElementById(id);
const player = $('player');
const STORE = 'swt.m1.v1', SESSION = 'swt.session.v1';
const state = load();
let manifest, queue = [], pos = 0, session = null, pendingSeek = null;
const blobs = new Map(); // file -> object URL, filled in the background so a signal drop doesn't stall a walk
const SECTIONS = ['Review', 'New', 'Recall', 'Questions', 'Shadow'];

function load() {
  const base = { done: [], flags: [], log: [], skipMeans: 'again' };
  try { return { ...base, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return base; }
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }
function saveSession() {
  try {
    if (!session) return localStorage.removeItem(SESSION);
    localStorage.setItem(SESSION, JSON.stringify({ ...session, pos, queue: queue.map(({ _shown, ...it }) => it) }));
  } catch {}
}
function savedSession() {
  try { const s = JSON.parse(localStorage.getItem(SESSION) || 'null'); return s && s.queue?.length && s.pos < s.queue.length - 1 ? s : null; }
  catch { return null; }
}
// Small on-device record of control presses, so flaky headphone buttons can be diagnosed.
function logEvent(source, action, note = '') {
  state.log.push(`${new Date().toISOString().slice(11, 23)} ${source}:${action} card ${pos + 1}/${queue.length} ${queue[pos]?.type || '-'} t=${player.currentTime.toFixed(1)} ${document.visibilityState}${note ? ' ' + note : ''}`);
  if (state.log.length > 80) state.log = state.log.slice(-80);
  save();
}

const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- session building ----------
function buildSession(di) {
  const d = manifest.dialogues[di], q = [];
  const cue = (c, block) => q.push({ type: 'cue', block, ...c });
  const recall = (sid, block) => q.push({ type: 'recall', block, sid, ...manifest.cards[sid].recall });
  const intro = sid => q.push({ type: 'intro', block: 'New', sid, ...manifest.cards[sid].intro });

  // Review: the two previous dialogues (M2 replaces this with real scheduling).
  const prev = manifest.dialogues.slice(Math.max(0, di - 2), di).flatMap(x => x.sentences);
  if (prev.length) { cue(manifest.cues.review, 'Review'); shuffle(prev).forEach(s => recall(s, 'Review')); }

  // New material: introduce in pairs, recall each pair straight away.
  cue(d.cue, 'New');
  for (let i = 0; i < d.sentences.length; i += 2) {
    const pair = d.sentences.slice(i, i + 2);
    pair.forEach(intro);
    pair.forEach(s => recall(s, 'New'));
  }
  cue(manifest.cues.recall, 'Recall'); d.sentences.forEach(s => recall(s, 'Recall'));
  cue(manifest.cues.again, 'Recall'); shuffle(d.sentences).forEach(s => recall(s, 'Recall'));
  if (d.questions?.length && manifest.cues.questions) {
    cue(manifest.cues.questions, 'Questions');
    d.questions.forEach(x => q.push({ type: 'question', block: 'Questions', ...x }));
  }
  cue(manifest.cues.shadow, 'Shadow');
  q.push({ type: 'shadow', block: 'Shadow', title: d.title, ...d.shadow });
  cue(manifest.cues.done, 'Done');
  return q;
}
const minutes = q => Math.round(q.reduce((t, x) => t + x.dur, 0) / 60);

// ---------- home ----------
function nextDialogue() {
  const i = manifest.dialogues.findIndex(d => !state.done.includes(d.id));
  return i < 0 ? manifest.dialogues.length - 1 : i;
}
function renderHome() {
  const pick = $('pick'); pick.innerHTML = '';
  manifest.dialogues.forEach((d, i) => {
    const o = document.createElement('option'); o.value = i;
    o.textContent = `${i + 1}. ${d.title}${state.done.includes(d.id) ? ' ✓' : ''}`; pick.appendChild(o);
  });
  const s = savedSession();
  pick.value = s ? s.di : nextDialogue();
  $('skipMeans').value = state.skipMeans;
  $('flagsBtn').hidden = !state.flags.length;
  $('flagsBtn').textContent = `Copy flagged sentences (${state.flags.length})`;
  $('engine').textContent = manifest.engine === 'macos-say-standin' ? 'Voice: temporary stand-in (robotic).' : '';
  $('start').disabled = false;
  updateInfo();
}
function updateInfo() {
  const di = +$('pick').value, d = manifest.dialogues[di], s = savedSession();
  const resume = s && s.di === di;
  $('start').textContent = resume ? 'Resume walk' : 'Start walk';
  $('restart').hidden = !resume;
  $('nextInfo').textContent = resume
    ? `${d.title} · paused at card ${s.pos + 1} of ${s.queue.length} (${s.queue[s.pos].block})`
    : `Next: ${d.title} · about ${minutes(buildSession(di))} min`;
}
$('pick').onchange = updateInfo;
$('skipMeans').onchange = () => { state.skipMeans = $('skipMeans').value; save(); };
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); alert(`${what} copied.`); } catch { prompt('Copy:', text); }
}
$('flagsBtn').onclick = () => copy(JSON.stringify(state.flags, null, 1), 'Flagged sentences');
$('logBtn').onclick = () => copy(`${navigator.userAgent}\n${state.log.join('\n')}`, 'Control log');

// ---------- playback ----------
const src = it => blobs.get(it.file) || `audio/${it.file}`;
async function prefetch(token) {
  for (let i = pos; i < queue.length; i++) {
    if (session !== token) return;
    const f = queue[i].file;
    if (blobs.has(f)) continue;
    try { const r = await fetch(`audio/${f}`); if (r.ok) blobs.set(f, URL.createObjectURL(await r.blob())); } catch {}
  }
}
function tryPlay(retries = 2) {
  player.play().catch(err => {
    if (err.name === 'AbortError') return;            // superseded by a newer load
    logEvent('audio', 'play-rejected', err.name);
    if (retries > 0 && session) setTimeout(() => tryPlay(retries - 1), 400);
  });
}
/** Load the card at `pos` and start it at `from` seconds (0 = the beginning). */
function play(from = 0) {
  const it = queue[pos];
  delete it._shown;
  pendingSeek = from > 0 ? from : null;
  player.src = src(it);
  tryPlay();
  render();
  saveSession();
}
player.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) { try { player.currentTime = pendingSeek; } catch {} pendingSeek = null; }
});
let errors = 0;
player.addEventListener('error', () => {
  if (!session) return;
  logEvent('audio', 'error', String(player.error?.code));
  const it = queue[pos];
  if (++errors <= 2) { blobs.delete(it.file); setTimeout(() => play(), 500); }   // retry from the network
  else { errors = 0; advance(); }
});
function advance() {
  if (pos + 1 < queue.length) { pos++; play(); } else finish(true);
}
player.addEventListener('ended', () => { if (session) { errors = 0; advance(); } });
player.addEventListener('timeupdate', () => {
  const it = queue[pos];
  if (it && it.reveal && !it._shown && player.currentTime >= it.reveal) render();
});
player.addEventListener('play', () => { $('pause').textContent = 'Pause'; setPlaybackState('playing'); });
player.addEventListener('pause', () => { if (!player.ended) { $('pause').textContent = 'Resume'; setPlaybackState('paused'); } });
function setPlaybackState(s) { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; }

let lastBlock = null;
function render() {
  const it = queue[pos], c = it.sid && manifest.cards[it.sid];
  const shown = !!it.reveal && (pendingSeek ?? player.currentTime) >= it.reveal - 0.3;
  it._shown = shown;
  let l1 = '', l2 = '';
  if (it.type === 'recall') { l1 = shown ? c.sl : c.en + (c.hint ? ` (${c.hint})` : ''); l2 = shown ? c.en : 'Say it in Slovenian'; }
  else if (it.type === 'question') { l1 = shown ? it.answer : it.sl; l2 = shown ? it.answer_en : `${it.en}\nAnswer aloud in Slovenian`; }
  else if (it.type === 'intro') { l1 = c.sl; l2 = c.en + (c.note ? `\n\n${c.note}` : ''); }
  else if (it.type === 'shadow') { l1 = it.title; l2 = 'Speak along'; }
  else { l1 = it.block === 'Done' ? 'Končano' : it.block; l2 = ''; }
  $('line1').textContent = l1; $('line2').textContent = l2;
  $('progress').textContent = `${pos + 1} / ${queue.length}`;
  $('flag').classList.toggle('on', !!(it.sid && state.flags.some(f => f.id === it.sid)));
  $('flag').disabled = !it.sid;
  if (it.block !== lastBlock) {
    lastBlock = it.block;
    for (const b of $('sections').children) b.classList.toggle('on', b.dataset.block === it.block);
    // Only touch the lock-screen metadata when the section changes: updating it on every card
    // makes iOS rebuild its controls and can drop a headphone press.
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: `${session.title} · ${it.block}`, artist: 'Slovenščina', album: 'Walking trainer' });
    }
  }
}
function renderSections() {
  const box = $('sections'); box.innerHTML = '';
  for (const name of SECTIONS) {
    if (!queue.some(x => x.block === name)) continue;
    const b = document.createElement('button'); b.textContent = name; b.dataset.block = name;
    b.onclick = () => { logEvent('screen', `section-${name}`); jumpToSection(name); };
    box.appendChild(b);
  }
  lastBlock = null;
}

// ---------- controls ----------
const answerable = it => it && (it.type === 'recall' || it.type === 'question');

/** "Again": hear the Slovenian answer once more straight away, and get the card again a little later. */
function again() {
  if (!session) return;
  // A press in the first moments of a card refers to the card that has just finished.
  if (pos > 0 && player.currentTime < 2 && !player.paused && (answerable(queue[pos - 1]) || queue[pos - 1].type === 'intro')) pos--;
  const it = queue[pos];
  if (answerable(it) && !it.requeued) {
    it.requeued = true;
    let at = pos + 1, steps = 0;                       // 3 cards later, but inside the same section
    while (at < queue.length && queue[at].type !== 'cue' && steps < 3) { at++; steps++; }
    const { _shown, ...copy } = it;
    queue.splice(at, 0, { ...copy, requeued: true });
  }
  play(answerable(it) ? Math.max(0, it.reveal - 0.25) : 0);
}
/** Back: restart this card; pressed again within 3 seconds, go to the previous card. */
function back() {
  if (!session) return;
  if (player.currentTime < 3 && pos > 0) pos--;
  play();
}
function skip() { if (session) advance(); }
function jumpToSection(name) {
  const i = queue.findIndex(x => x.block === name);
  if (i >= 0) { pos = i; play(); }
}
function togglePause() { if (player.paused) tryPlay(); else player.pause(); }
function flag() {
  const it = queue[pos]; if (!it?.sid) return;
  const i = state.flags.findIndex(f => f.id === it.sid);
  if (i >= 0) state.flags.splice(i, 1);
  else state.flags.push({ id: it.sid, sl: manifest.cards[it.sid].sl, en: manifest.cards[it.sid].en, at: new Date().toISOString() });
  save(); render();
}

// Headphone / lock-screen buttons. Registered once; a repeat of the same action within 350 ms is ignored.
let lastAction = ['', 0];
function remote(action, fn) {
  return () => {
    const now = Date.now();
    if (lastAction[0] === action && now - lastAction[1] < 350) return;
    lastAction = [action, now];
    logEvent('remote', action);
    fn();
  };
}
if ('mediaSession' in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  set('play', remote('play', () => { if (session) tryPlay(); }));
  set('pause', remote('pause', () => player.pause()));
  set('nexttrack', remote('nexttrack', () => (state.skipMeans === 'next' ? skip() : again())));
  set('previoustrack', remote('previoustrack', back));
}

// ---------- session lifecycle ----------
function begin(resume) {
  const di = +$('pick').value, d = manifest.dialogues[di], s = resume && savedSession();
  if (s && s.di === di) { queue = s.queue; pos = s.pos; } else { queue = buildSession(di); pos = 0; }
  session = { di, title: d.title };
  errors = 0;
  $('home').hidden = true; $('walk').hidden = false;
  renderSections();
  logEvent('screen', resume ? 'resume' : 'start');
  play(); // must run inside the tap so iOS allows audio
  prefetch(session);
}
function finish(completed) {
  if (completed && session) {
    const id = manifest.dialogues[session.di].id;
    if (!state.done.includes(id)) { state.done.push(id); save(); }
    session = null; saveSession();                    // a finished walk is not resumable
  } else { saveSession(); session = null; }           // an ended walk can be resumed later
  player.pause(); player.removeAttribute('src');
  $('walk').hidden = true; $('home').hidden = false; renderHome();
}

const tap = (id, name, fn) => { $(id).onclick = () => { logEvent('screen', name); fn(); }; };
$('start').onclick = () => begin(true);
$('restart').onclick = () => begin(false);
tap('again', 'again', again);
tap('back', 'back', back);
tap('skip', 'skip', skip);
tap('pause', 'pause', togglePause);
tap('flag', 'flag', flag);
$('end').onclick = () => { if (confirm('End this walk? You can resume it later.')) finish(false); };

fetch('audio/manifest.json', { cache: 'no-cache' })
  .then(r => r.json())
  .then(m => { manifest = m; renderHome(); })
  .catch(() => { $('nextInfo').textContent = 'Could not load audio manifest. Check your connection and reload.'; });
