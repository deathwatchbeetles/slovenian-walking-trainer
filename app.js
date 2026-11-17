// Slovenian walking trainer — M1 core loop.
// A session is a queue of pre-baked audio files (silences included), played through one
// <audio> element so it keeps going with the screen locked. Headphone "next track" = Again.

const $ = id => document.getElementById(id);
const player = $('player');
const STORE = 'swt.m1.v1';
const state = load();
let manifest, queue = [], pos = 0, session = null;
const blobs = new Map(); // file -> object URL, filled in the background so a signal drop doesn't stall a walk

function load() {
  try { return { done: [], flags: [], ...JSON.parse(localStorage.getItem(STORE) || '{}') }; }
  catch { return { done: [], flags: [] }; }
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

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
  pick.value = nextDialogue(); updateInfo();
  $('flagsBtn').hidden = !state.flags.length;
  $('flagsBtn').textContent = `Copy flagged sentences (${state.flags.length})`;
  $('engine').textContent = manifest.engine === 'macos-say-standin' ? 'Voice: temporary stand-in (robotic). Neural voice comes next.' : '';
  $('start').disabled = false;
}
function updateInfo() {
  const di = +$('pick').value, d = manifest.dialogues[di];
  $('nextInfo').textContent = `Next: ${d.title} · about ${minutes(buildSession(di))} min`;
}
$('pick').onchange = updateInfo;
$('flagsBtn').onclick = async () => {
  const text = JSON.stringify(state.flags, null, 1);
  try { await navigator.clipboard.writeText(text); alert('Flagged sentences copied.'); } catch { prompt('Copy:', text); }
};

// ---------- playback ----------
const src = it => blobs.get(it.file) || `audio/${it.file}`;
async function prefetch(q, token) {
  for (const it of q) {
    if (session !== token) return;
    if (blobs.has(it.file)) continue;
    try { const r = await fetch(`audio/${it.file}`); if (r.ok) blobs.set(it.file, URL.createObjectURL(await r.blob())); } catch {}
  }
}
function play() {
  const it = queue[pos];
  player.src = src(it);
  player.play().catch(() => {});
  render();
}
function render(revealed) {
  const it = queue[pos], c = it.sid && manifest.cards[it.sid];
  $('block').textContent = it.block; $('progress').textContent = `${pos + 1} / ${queue.length}`;
  let l1 = '', l2 = '';
  if (it.type === 'recall') {
    const show = revealed ?? (player.currentTime >= it.reveal);
    l1 = show ? c.sl : c.en + (c.hint ? ` (${c.hint})` : ''); l2 = show ? c.en : 'Say it in Slovenian';
    it._shown = show;
  } else if (it.type === 'intro') { l1 = c.sl; l2 = c.en + (c.note ? `\n\n${c.note}` : ''); }
  else if (it.type === 'shadow') { l1 = it.title; l2 = 'Speak along'; }
  else { l1 = it.block === 'Done' ? 'Končano' : it.block; l2 = ''; }
  $('line1').textContent = l1; $('line2').textContent = l2; $('line2').style.whiteSpace = 'pre-line';
  $('flag').classList.toggle('on', !!(it.sid && state.flags.some(f => f.id === it.sid)));
  $('flag').disabled = !it.sid;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: `${it.block} · ${pos + 1}/${queue.length}`, artist: session?.title || '', album: 'Slovenščina' });
  }
}
player.addEventListener('timeupdate', () => {
  const it = queue[pos];
  if (it && it.type === 'recall' && !it._shown && player.currentTime >= it.reveal) render(true);
});
player.addEventListener('ended', () => {
  if (!session) return;
  if (pos + 1 < queue.length) { pos++; play(); } else finish(true);
});
player.addEventListener('play', () => { $('pause').textContent = 'Pause'; setPlaybackState('playing'); });
player.addEventListener('pause', () => { if (!player.ended) { $('pause').textContent = 'Resume'; setPlaybackState('paused'); } });
function setPlaybackState(s) { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; }

function again() {
  if (!session) return;
  // A press in the first moments of a card almost always refers to the card that just ended.
  if (pos > 0 && player.currentTime < 1.2 && queue[pos - 1].sid) pos--;
  const it = queue[pos];
  if (it.sid && !it.requeued) {
    it.requeued = true;
    // Bring the sentence back a few cards later, but before the shadowing block.
    const limit = queue.findIndex((x, i) => i > pos && x.type === 'cue' && (x.block === 'Shadow' || x.block === 'Done'));
    const at = Math.min(pos + 4, limit < 0 ? queue.length : limit);
    queue.splice(at, 0, { type: 'recall', block: it.block, sid: it.sid, requeued: true, ...manifest.cards[it.sid].recall });
  }
  delete it._shown;
  play();
}
function back() { if (!session) return; if (player.currentTime < 2 && pos > 0) pos--; delete queue[pos]._shown; play(); }
function togglePause() { if (player.paused) player.play().catch(() => {}); else player.pause(); }
function flag() {
  const it = queue[pos]; if (!it?.sid) return;
  const i = state.flags.findIndex(f => f.id === it.sid);
  if (i >= 0) state.flags.splice(i, 1);
  else state.flags.push({ id: it.sid, sl: manifest.cards[it.sid].sl, en: manifest.cards[it.sid].en, at: new Date().toISOString() });
  save(); render();
}

function start() {
  const di = +$('pick').value, d = manifest.dialogues[di];
  queue = buildSession(di); pos = 0; session = { di, title: d.title };
  $('home').hidden = true; $('walk').hidden = false;
  if ('mediaSession' in navigator) {
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
    set('play', () => player.play().catch(() => {}));
    set('pause', () => player.pause());
    set('nexttrack', again);
    set('previoustrack', back);
  }
  play(); // must run inside the tap so iOS allows audio
  prefetch(queue, session);
}
function finish(completed) {
  if (completed && session) {
    const id = manifest.dialogues[session.di].id;
    if (!state.done.includes(id)) { state.done.push(id); save(); }
  }
  session = null; player.pause(); player.removeAttribute('src');
  $('walk').hidden = true; $('home').hidden = false; renderHome();
}

$('start').onclick = start;
$('again').onclick = again;
$('pause').onclick = togglePause;
$('flag').onclick = flag;
$('end').onclick = () => { if (confirm('End this walk?')) finish(false); };

fetch('audio/manifest.json', { cache: 'no-cache' })
  .then(r => r.json())
  .then(m => { manifest = m; renderHome(); })
  .catch(() => { $('nextInfo').textContent = 'Could not load audio manifest. Check your connection and reload.'; });
