// Commons DJ — UI
import { Mixer, peakDb, STEMS, AI_STEM_NAMES } from './engine.js';
import { mixToMono, computeWaveform, overview, detectTempo, detectKey, keyName, camelot, transposeKey } from './analysis.js';

const api = window.cdj;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const mixer = new Mixer();
const DECKS = ['A', 'B'];
// Canvas colours, read from the current theme's CSS variables (see setTheme).
const ACCENT = { A: [255, 159, 67], B: [60, 200, 245] };
const INK = { ink: '255,255,255', shade: '11,12,14', hi: [170, 182, 196] };
const HOTCUE_COLORS = ['#ff5c6c', '#42d392', '#8b7bff', '#ffd24d'];

const state = {
  tracks: [],
  filter: '',
  waves: { A: null, B: null },
  overviewImg: { A: null, B: null },
  zoom: 110, // waveform pixels per second
  played: new Map(), // trackId -> track (web tracks played this session, for credits)
  ccResults: [],
  jobs: new Map(), // jobId -> { el, url }
  stemJobs: new Map(), // trackId -> { done, total } while AI stems are being made
};

// ------------------------------------------------------------------ helpers

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(sec, tenths = false) {
  if (sec == null || !isFinite(sec)) return tenths ? '0:00.0' : '—';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '−' : ''}${m}:${ss}`;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

// No-gate build: tracks aren't license-checked, so anything that isn't
// clearly CC shows as UNCHECKED rather than defaulting to "CC".
function shortLicense(lic) {
  if (!lic) return 'UNCHECKED';
  if (/public\s*domain|cc0/i.test(lic)) return 'PUBLIC DOMAIN';
  if (/attribution/i.test(lic) || /cc[\s-]?by/i.test(lic)) {
    const m = lic.match(/cc[\s-]?by(?:[\s-](?:sa|nd|nc))*(?:[\s-]\d\.\d)?/i);
    return m ? m[0].toUpperCase().replace(/\s/g, '-') : 'CC BY';
  }
  if (/creative\s*commons/i.test(lic)) return 'CC';
  return 'UNCHECKED';
}

/** "8A Am" for a stored key (0–23); '' when unknown. */
function keyLabel(key) {
  return key == null || key < 0 ? '' : `${camelot(key)} ${keyName(key)}`;
}

function cleanErr(err) {
  let msg = String(err?.message || err || 'Something went wrong');
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  if (/unable to (download|connect)|getaddrinfo|timed out|network is unreachable|proxy/i.test(msg)) {
    return 'Couldn’t reach YouTube — check your internet connection and try again.';
  }
  return msg.replace(/;?\s*please report this issue.*$/i, '').slice(0, 300);
}

function jobId() {
  return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------------ knobs

class Knob {
  constructor(el, { min, max, value, reset = value, bipolar = false, onChange }) {
    Object.assign(this, { el, min, max, value, reset, bipolar, onChange });
    el.innerHTML = `
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path class="k-track" d="${arc(-135, 135)}" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <path class="k-value" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <circle class="k-cap" cx="20" cy="20" r="11" stroke-width="1"/>
        <line class="k-ptr" x1="20" y1="20" x2="20" y2="11" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="k-label">${escapeHtml(el.dataset.label || '')}</span>`;
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', `${el.closest('[data-deck]')?.dataset.deck || ''} ${el.dataset.label || ''}`);
    this.valuePath = $('.k-value', el);
    this.ptr = $('.k-ptr', el);
    this.render();

    let startY = 0;
    let startT = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startT = this.toT(this.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(this.fromT(startT + ((startY - e.clientY) / 160) * fine));
    });
    el.addEventListener('dblclick', () => this.set(this.reset));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.set(this.fromT(this.toT(this.value) - Math.sign(e.deltaY) * 0.025));
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const nudge = (dir) => {
        this.set(this.fromT(this.toT(this.value) + dir * 0.025));
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-1);
    });
  }

  // Bipolar knobs put their reset value at 12 o'clock, even when the range is lopsided.
  toT(v) {
    if (!this.bipolar) return (v - this.min) / (this.max - this.min);
    return v <= this.reset ? 0.5 * ((v - this.min) / (this.reset - this.min)) : 0.5 + 0.5 * ((v - this.reset) / (this.max - this.reset));
  }

  fromT(t) {
    t = Math.min(1, Math.max(0, t));
    if (!this.bipolar) return this.min + t * (this.max - this.min);
    return t <= 0.5 ? this.min + (t / 0.5) * (this.reset - this.min) : this.reset + ((t - 0.5) / 0.5) * (this.max - this.reset);
  }

  set(v) {
    v = Math.min(this.max, Math.max(this.min, v));
    // Gentle detent at the reset point.
    if (Math.abs(this.toT(v) - this.toT(this.reset)) < 0.02) v = this.reset;
    this.value = v;
    this.render();
    this.onChange?.(v);
  }

  render() {
    const ang = -135 + this.toT(this.value) * 270;
    const from = this.bipolar ? 0 : -135;
    const [a0, a1] = ang < from ? [ang, from] : [from, ang];
    this.valuePath.setAttribute('d', a1 - a0 < 0.5 ? '' : arc(a0, a1));
    this.ptr.setAttribute('transform', `rotate(${ang} 20 20)`);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
    this.el.classList.toggle('kill', this.value <= this.min + 0.001 && this.min < -20);
  }
}

function arc(a0, a1, r = 16) {
  const p = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(20 + r * Math.cos(rad)).toFixed(2)} ${(20 + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

// ------------------------------------------------------------------ decks UI

const ui = {};

function buildDeck(name) {
  const root = $(`#deck${name}`);
  root.append($('#deckTemplate').content.cloneNode(true));
  $('.deck-badge', root).textContent = name;
  const deck = mixer.decks[name];
  const d = {
    root,
    title: $('.t-title', root),
    artist: $('.t-artist', root),
    lic: $('.lic', root),
    elapsed: $('.elapsed', root),
    remain: $('.remain', root),
    bpmEff: $('.bpm-eff', root),
    bpmTrack: $('.bpm-track', root),
    rate: $('.rate', root),
    overview: $('.overview', root),
    play: $('.play', root),
    cue: $('.cue', root),
    sync: $('.sync', root),
    tempo: $('.tempo-slider', root),
    range: $('.tempo-range', root),
    hotcues: $$('.hc', root),
    loops: $$('.lp', root),
    tap: $('.tap', root),
    keyRead: $('.key-read', root),
    keyLock: $('.key-lock', root),
    keyMatch: $('.key-match', root),
    stems: $$('.stem', root),
    stemLabel: $('.stemrow .label', root),
  };
  ui[name] = d;

  d.play.addEventListener('click', () => {
    deck.toggle();
    markPlayed(name);
  });
  d.cue.addEventListener('click', () => deck.cue());
  d.sync.addEventListener('click', () => doSync(name));

  const applyTempo = () => {
    const pct = (Number(d.tempo.value) / 1000) * Number(d.range.value);
    deck.setRate(1 + pct / 100);
  };
  d.tempo.addEventListener('input', applyTempo);
  d.tempo.addEventListener('dblclick', () => {
    d.tempo.value = 0;
    applyTempo();
  });
  d.range.addEventListener('change', () => {
    // Keep the current tempo when switching range, if it fits.
    const pct = (deck.rate - 1) * 100;
    const range = Number(d.range.value);
    d.tempo.value = Math.round(Math.max(-1, Math.min(1, pct / range)) * 1000);
    applyTempo();
  });

  // Nudge buttons (hold).
  const holdBend = (btn, amt) => {
    btn.addEventListener('pointerdown', () => deck.bend(amt));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => deck.endBend());
  };
  holdBend($('.nudge-back', root), -0.04);
  holdBend($('.nudge-fwd', root), 0.04);

  d.hotcues.forEach((btn) => {
    const i = Number(btn.dataset.i);
    btn.addEventListener('click', () => hotcue(name, i));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHotcue(name, i);
    });
  });

  d.loops.forEach((btn) => btn.addEventListener('click', () => deck.setLoop(Number(btn.dataset.beats))));

  $('.half', root).addEventListener('click', () => scaleBpm(name, 0.5));
  $('.double', root).addEventListener('click', () => scaleBpm(name, 2));
  $('.beat-here', root).addEventListener('click', () => beatHere(name));
  setupTap(name);

  // Key: shift in semitones without touching tempo, key lock, match the other deck.
  $('.key-down', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) - 1));
  $('.key-up', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) + 1));
  d.keyRead.addEventListener('click', () => deck.setKeyShift(0));
  d.keyLock.addEventListener('click', () => deck.setKeyLock(!deck.keyLock));
  d.keyMatch.addEventListener('click', () => matchKey(name));

  // Stems: click toggles, Shift-click solos, right-click turns everything back on.
  d.stems.forEach((btn) => {
    const stem = btn.dataset.stem;
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        const solo = STEMS.every((s) => (s === stem ? deck.stems[s] > 0 : deck.stems[s] === 0));
        STEMS.forEach((s) => deck.setStem(s, solo || s === stem ? 1 : 0));
      } else {
        deck.setStem(stem, deck.stems[stem] > 0 ? 0 : 1);
      }
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      deck.resetStems();
    });
  });

  d.overview.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    const seekTo = (ev) => {
      const r = d.overview.getBoundingClientRect();
      deck.seek(((ev.clientX - r.left) / r.width) * deck.duration);
    };
    seekTo(e);
    d.overview.setPointerCapture(e.pointerId);
    const move = (ev) => seekTo(ev);
    d.overview.addEventListener('pointermove', move);
    d.overview.addEventListener('pointerup', () => d.overview.removeEventListener('pointermove', move), { once: true });
  });

  deck.on((type) => {
    if (type === 'state' || type === 'load') renderDeckState(name);
    if (type === 'loop' || type === 'load') d.loops.forEach((b) => b.classList.toggle('on', deck.loop?.beats === Number(b.dataset.beats)));
    if (type === 'rate' || type === 'load' || type === 'sync') renderTempo(name);
    if (type === 'sync') syncTempoSlider(name);
    if (type === 'key' || type === 'rate' || type === 'load' || type === 'sync' || type === 'fx') renderKey(name);
    if (type === 'stems' || type === 'load' || type === 'fx') renderStems(name);
  });

  setupDeckDrop(root, name);
  setupDeckDrop($(`.wave-row[data-deck="${name}"]`), name);
}

function renderDeckState(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  d.play.classList.toggle('on', deck.playing);
  d.play.textContent = deck.playing ? '❚❚' : '▶';
  const t = deck.track;
  if (t) {
    d.title.textContent = t.title || 'Untitled';
    d.artist.textContent = t.artist || (t.source?.uploader ?? '');
    if (t.source?.kind === 'web') {
      d.lic.hidden = false;
      d.lic.className = 'lic';
      d.lic.textContent = shortLicense(t.source.license);
      d.lic.title = t.source.license || '';
    } else {
      d.lic.hidden = false;
      d.lic.className = 'lic local';
      d.lic.textContent = 'LOCAL';
      d.lic.title = t.file;
    }
  }
  renderHotcues(name);
  renderLibrary();
}

function renderTempo(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  d.rate.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  if (deck.bpm) {
    d.bpmEff.textContent = deck.effectiveBpm.toFixed(1);
    d.bpmTrack.textContent = `${Number(deck.bpm).toFixed(1)} track`;
  } else {
    d.bpmEff.textContent = '—.—';
    d.bpmTrack.textContent = deck.track ? 'no grid' : '';
  }
}

function syncTempoSlider(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  let range = Number(d.range.value);
  if (Math.abs(pct) > range) {
    range = [8, 16, 50].find((r) => r >= Math.abs(pct)) || 50;
    d.range.value = String(range);
  }
  d.tempo.value = Math.round((pct / range) * 1000);
}

function doSync(name) {
  const deck = mixer.decks[name];
  const other = mixer.decks[name === 'A' ? 'B' : 'A'];
  if (!deck.track || !other.track) return toast('Load tracks on both decks to sync.');
  if (!deck.bpm || !other.bpm) return toast('Both tracks need a BPM — try TAP to set one.');
  if (!deck.syncTo(other)) return toast('Tempos are too far apart to sync.', 'error');
  ui[name].sync.classList.add('on');
  setTimeout(() => ui[name].sync.classList.remove('on'), 500);
}

const fmtSemis = (s) => {
  const r = Math.round(s * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r) % 1 ? Math.abs(r).toFixed(1) : Math.abs(r)}`;
};

function renderKey(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const key = deck.track?.key;
  const offset = deck.keyOffset;
  const shifted = Math.abs(offset) >= 0.05;
  d.keyLock.classList.toggle('on', deck.keyLock);
  d.keyRead.classList.toggle('shifted', shifted);
  d.keyRead.classList.toggle('unknown', key == null || key < 0);
  const noFx = !deck.fx;
  if (key == null || key < 0) {
    d.keyRead.textContent = deck.track ? (shifted ? `? ${fmtSemis(offset)}` : 'no key') : '—';
    d.keyRead.title = deck.track ? 'No clear key found in this track.' : '';
  } else if (!shifted) {
    d.keyRead.innerHTML = `${escapeHtml(camelot(key))} <span class="dim">${escapeHtml(keyName(key))}</span>`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}).`;
  } else {
    // The key you hear: rounded to the nearest semitone, with the exact shift alongside.
    const heard = transposeKey(key, offset);
    const off = Math.abs(offset - Math.round(offset)) >= 0.25 ? '~' : '';
    d.keyRead.textContent = `${off}${camelot(heard)} ${keyName(heard)} ${fmtSemis(offset)}`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}), playing ${fmtSemis(offset)} semitones → ${keyName(heard)} (${camelot(heard)}).` +
      (deck.keyLock ? '' : ' Includes the pitch change from the tempo slider (key lock is off).') + ' Click to reset the key shift.';
  }
  if (noFx) d.keyRead.title = 'Key shift is still loading…';
}

function renderStems(name) {
  const deck = mixer.decks[name];
  ui[name].stems.forEach((btn) => {
    btn.classList.toggle('off', deck.stems[btn.dataset.stem] === 0);
    btn.disabled = !deck.fx;
  });
  const label = ui[name].stemLabel;
  const job = state.stemJobs.get(deck.track?.id);
  label.classList.toggle('ai', !!deck.aiStems);
  if (deck.aiStems) {
    label.textContent = 'Stems · AI';
    label.title = 'Using AI-separated stems for this track (HT-Demucs).';
  } else if (job) {
    label.textContent = job.total ? `AI ${Math.round((100 * job.done) / job.total)}%` : 'AI …';
    label.title = 'Separating this track with AI in the background — the quick DSP stems work meanwhile.';
  } else {
    label.textContent = 'Stems';
    label.title = 'Real-time DSP stems.';
  }
}

// ------------------------------------------------------------------ AI stems (prototype)

async function loadAiStems(name, trackId) {
  const deck = mixer.decks[name];
  const buffers = {};
  for (const n of AI_STEM_NAMES) {
    const data = await api.stems.read(trackId, n);
    buffers[n] = await mixer.ctx.decodeAudioData(data);
  }
  if (deck.track?.id === trackId) deck.setAiStems(buffers);
}

/** Resample to 44.1 kHz stereo for the model. */
async function toModelPcm(buffer) {
  const len = Math.ceil(buffer.duration * 44100);
  const off = new OfflineAudioContext(2, len, 44100);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return [r.getChannelData(0), r.getChannelData(1)];
}

/** After a track loads: use cached AI stems, or separate it once in the background. */
async function prepareAiStems(name, track, buffer) {
  try {
    const st = await api.stems.status(track.id);
    if (!st.available) return; // not installed: DSP stems only
    if (st.ready) return await loadAiStems(name, track.id);
    if (state.stemJobs.has(track.id)) return;
    state.stemJobs.set(track.id, { done: 0, total: 0 });
    DECKS.forEach(renderStems);
    const [left, right] = await toModelPcm(buffer);
    await api.stems.separate(track.id, left, right);
    state.stemJobs.delete(track.id);
    for (const n of DECKS) if (mixer.decks[n].track?.id === track.id) await loadAiStems(n, track.id);
    toast(`AI stems ready for “${track.title}”.`);
  } catch (err) {
    state.stemJobs.delete(track.id);
    console.error(err);
    toast(`AI stems failed: ${cleanErr(err)} — using DSP stems.`, 'error');
  } finally {
    DECKS.forEach(renderStems);
  }
}

function matchKey(name) {
  const deck = mixer.decks[name];
  const other = mixer.decks[name === 'A' ? 'B' : 'A'];
  if (!deck.track || !other.track) return toast('Load tracks on both decks to match keys.');
  if (deck.track.key == null || deck.track.key < 0 || other.track.key == null || other.track.key < 0) {
    return toast('Both tracks need a detected key to match.');
  }
  const s = deck.matchKeyTo(other);
  const heard = transposeKey(other.track.key, other.keyOffset);
  toast(`Deck ${name} ${Math.abs(s) < 0.05 ? 'is already' : `shifted ${fmtSemis(s)} semitones —`} in key with deck ${other.name} (${camelot(heard)}). Key lock is on.`);
  ui[name].keyMatch.classList.add('on');
  setTimeout(() => ui[name].keyMatch.classList.remove('on'), 500);
}

function markPlayed(name) {
  const t = mixer.decks[name].track;
  if (t?.source?.kind === 'web' && mixer.decks[name].playing) {
    state.played.set(t.id, t);
    $('#creditsCount').textContent = state.played.size;
  }
}

// ------------------------------------------------------------------ hot cues & grid

async function saveTrack(track, patch) {
  Object.assign(track, patch);
  const updated = await api.library.update(track.id, patch);
  if (updated) {
    const i = state.tracks.findIndex((t) => t.id === track.id);
    if (i !== -1) state.tracks[i] = Object.assign(state.tracks[i], patch);
  }
}

function renderHotcues(name) {
  const t = mixer.decks[name].track;
  ui[name].hotcues.forEach((btn, i) => {
    const set = t?.cues?.[i] != null;
    btn.classList.toggle('set', set);
    btn.title = set ? `Hot cue ${i + 1} at ${fmtTime(t.cues[i], true)} (right-click to clear)` : `Set hot cue ${i + 1}`;
  });
}

function hotcue(name, i) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t) return;
  const cues = Array.isArray(t.cues) ? [...t.cues] : [null, null, null, null];
  if (cues[i] == null) {
    cues[i] = deck.snapToBeat(deck.position);
    saveTrack(t, { cues });
    renderHotcues(name);
  } else {
    deck.seek(cues[i]);
    if (!deck.playing) deck.cuePoint = cues[i];
  }
}

function clearHotcue(name, i) {
  const t = mixer.decks[name].track;
  if (!t?.cues?.[i] && t?.cues?.[i] !== 0) return;
  const cues = [...t.cues];
  cues[i] = null;
  saveTrack(t, { cues });
  renderHotcues(name);
}

function scaleBpm(name, k) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm) return;
  const bpm = Math.round(t.bpm * k * 100) / 100;
  if (bpm < 40 || bpm > 300) return;
  saveTrack(t, { bpm });
  renderTempo(name);
  renderLibrary();
}

function beatHere(name) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm) return toast('Set a BPM first (TAP along with the beat).');
  const period = 60 / t.bpm;
  const offset = ((deck.position % period) + period) % period;
  saveTrack(t, { beatOffset: offset });
  toast(`Beat grid moved on deck ${name}.`);
}

function setupTap(name) {
  const btn = ui[name].tap;
  let taps = [];
  let timer = null;
  const tap = () => {
    const deck = mixer.decks[name];
    if (!deck.track) return;
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    btn.classList.add('tapping');
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('tapping');
      taps = [];
    }, 2200);
    if (taps.length >= 4) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.slice(-8).reduce((a, b) => a + b, 0) / Math.min(8, intervals.length);
      const tapped = 60000 / avg; // tempo as heard (includes current pitch)
      const bpm = Math.round((tapped / deck.rate) * 10) / 10;
      const period = 60 / bpm;
      const offset = ((deck.position % period) + period) % period;
      saveTrack(deck.track, { bpm, beatOffset: offset });
      renderTempo(name);
      renderLibrary();
    }
  };
  btn.addEventListener('pointerdown', tap);
  ui[name].tapFn = tap;
}

// ------------------------------------------------------------------ loading tracks

async function loadToDeck(name, trackId) {
  const deck = mixer.decks[name];
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (track.missing) return toast('That file is missing — it may have been moved or deleted.', 'error');
  if (deck.playing) return toast(`Deck ${name} is playing — pause it before loading a new track.`, 'error');

  const d = ui[name];
  d.root.classList.add('loading');
  d.title.textContent = track.title;
  d.artist.textContent = 'Loading…';
  try {
    await mixer.resume();
    const data = await api.library.readAudio(track.id);
    const buffer = await mixer.ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const mono = mixToMono(channels);
    const wave = computeWaveform(mono, buffer.sampleRate, 150);

    const patch = {};
    if (!track.duration) patch.duration = buffer.duration;
    if (track.bpm == null) {
      d.artist.textContent = 'Analyzing tempo…';
      await new Promise((r) => setTimeout(r, 0));
      const tempo = detectTempo(mono, buffer.sampleRate);
      if (tempo) {
        patch.bpm = tempo.bpm;
        patch.beatOffset = tempo.offset;
      } else {
        patch.bpm = 0; // analysed, no clear beat
      }
    }
    if (track.key == null) {
      d.artist.textContent = 'Analyzing key…';
      await new Promise((r) => setTimeout(r, 0));
      const k = detectKey(mono, buffer.sampleRate);
      patch.key = k ? k.key : -1; // -1: analysed, no clear key
    }
    if (Object.keys(patch).length) await saveTrack(track, patch);
    if (track.bpm === 0) track.bpm = null;

    state.waves[name] = wave;
    state.overviewImg[name] = null;
    deck.load(buffer, track);
    // A fresh load starts at normal speed; keep the slider in step.
    d.tempo.value = 0;
    deck.setRate(1);
    prepareAiStems(name, track, buffer); // background; DSP stems work meanwhile
  } catch (err) {
    console.error(err);
    toast(`Couldn't load “${track.title}”: ${cleanErr(err)}`, 'error');
    d.title.textContent = deck.track?.title || 'No track loaded';
    d.artist.textContent = deck.track?.artist || '';
  } finally {
    d.root.classList.remove('loading');
    renderDeckState(name);
  }
}

function setupDeckDrop(el, name) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/x-cdj-track') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/x-cdj-track');
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      loadToDeck(name, id);
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();
      const added = await importFiles(e.dataTransfer.files);
      if (added[0]) loadToDeck(name, added[0].id);
    }
  });
}

// ------------------------------------------------------------------ mixer UI

function buildMixer() {
  for (const name of DECKS) {
    const deck = mixer.decks[name];
    const strip = $(`.strip[data-deck="${name}"]`);
    for (const el of $$('.knob', strip)) {
      const p = el.dataset.param;
      if (p === 'trim') new Knob(el, { min: -12, max: 12, value: 0, bipolar: true, onChange: (v) => deck.setTrim(v) });
      else if (p === 'filter') new Knob(el, { min: -1, max: 1, value: 0, bipolar: true, onChange: (v) => deck.setFilter(v) });
      else new Knob(el, { min: -26, max: 6, value: 0, bipolar: true, onChange: (v) => deck.setEq(p, v) });
    }
    const fader = $('.channel-fader', strip);
    fader.addEventListener('input', () => deck.setFader(Number(fader.value)));
  }
  const xf = $('#crossfader');
  xf.addEventListener('input', () => mixer.setCrossfader(Number(xf.value)));
  xf.addEventListener('dblclick', () => {
    xf.value = 0.5;
    mixer.setCrossfader(0.5);
  });
  const mv = $('#masterVol');
  mv.addEventListener('input', () => mixer.setMasterVolume(Number(mv.value)));
  mixer.setMasterVolume(Number(mv.value));

  $$('#curveSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#curveSeg button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      mixer.setCurve(b.dataset.curve);
    }),
  );
}

// ------------------------------------------------------------------ drawing

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

function waveColor(name, bass, alpha = 1) {
  const [r, g, b] = ACCENT[name];
  // Highs lean toward the theme's high colour, bass toward the deck colour.
  const [hr, hg, hb] = INK.hi;
  const k = Math.min(1, bass * 1.4);
  const rr = Math.round(hr + (r - hr) * k);
  const gg = Math.round(hg + (g - hg) * k);
  const bb = Math.round(hb + (b - hb) * k);
  return `rgba(${rr},${gg},${bb},${alpha})`;
}

const BUCKETS = 6;

function drawScrolling(name) {
  const canvas = $(`#wave${name}`);
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const deck = mixer.decks[name];
  const wave = state.waves[name];
  const mid = H / 2;
  const cx = Math.round(W / 2);

  if (wave && deck.buffer) {
    const pos = deck.position;
    const pps = (state.zoom * dpr) / deck.rate; // device pixels per track-second (real time is constant)
    const t0 = pos - cx / pps;

    // Loop region
    if (deck.loop) {
      const x0 = cx + (deck.loop.start - pos) * pps;
      const x1 = cx + (deck.loop.end - pos) * pps;
      ctx.fillStyle = 'rgba(66,211,146,0.12)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    }

    // Bars grouped by colour bucket to keep draw calls low.
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    for (let x = 0; x < W; x++) {
      const c0 = Math.floor((t0 + x / pps) * wave.rate);
      const c1 = Math.max(c0 + 1, Math.floor((t0 + (x + 1) / pps) * wave.rate));
      if (c1 <= 0 || c0 >= wave.peak.length) continue;
      let pk = 0;
      let bs = 0;
      let n = 0;
      for (let c = Math.max(0, c0); c < Math.min(c1, wave.peak.length); c++) {
        if (wave.peak[c] > pk) pk = wave.peak[c];
        bs += wave.bass[c];
        n++;
      }
      if (!n) continue;
      const h = Math.max(1, pk * (H / 2 - 3 * dpr));
      const bucket = Math.min(BUCKETS - 1, Math.floor((bs / n) * BUCKETS));
      paths[bucket].rect(x, mid - h, 1, h * 2);
    }
    for (let b = 0; b < BUCKETS; b++) {
      ctx.fillStyle = waveColor(name, (b + 0.5) / BUCKETS, 0.95);
      ctx.fill(paths[b]);
    }

    // Beat grid
    const t = deck.track;
    if (t?.bpm && t.beatOffset != null) {
      const period = 60 / t.bpm;
      const tEnd = t0 + W / pps;
      let n = Math.ceil((t0 - t.beatOffset) / period);
      for (; t.beatOffset + n * period < tEnd; n++) {
        const bt = t.beatOffset + n * period;
        if (bt < 0) continue;
        const x = Math.round(cx + (bt - pos) * pps) + 0.5;
        const bar = n % 4 === 0;
        ctx.fillStyle = `rgba(${INK.ink},${bar ? 0.55 : 0.22})`;
        const len = (bar ? 9 : 5) * dpr;
        ctx.fillRect(x, 0, dpr, len);
        ctx.fillRect(x, H - len, dpr, len);
      }
    }

    // Cue + hot cues
    const marker = (time, color) => {
      const x = Math.round(cx + (time - pos) * pps);
      if (x < -10 || x > W + 10) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.moveTo(x - 5 * dpr, 0);
      ctx.lineTo(x + 7 * dpr, 0);
      ctx.lineTo(x + dpr, 7 * dpr);
      ctx.fill();
    };
    (t?.cues || []).forEach((c, i) => c != null && marker(c, HOTCUE_COLORS[i]));
    marker(deck.cuePoint, `rgb(${INK.ink})`);

    // Shade the past.
    ctx.fillStyle = `rgba(${INK.shade},0.45)`;
    ctx.fillRect(0, 0, cx, H);
  } else {
    ctx.fillStyle = `rgba(${INK.ink},0.2)`;
    ctx.fillRect(0, mid, W, 1);
  }

  // Playhead
  ctx.fillStyle = `rgb(${INK.ink})`;
  ctx.fillRect(cx - dpr, 0, 2 * dpr, H);
}

function buildOverviewImage(name) {
  const canvas = ui[name].overview;
  const wave = state.waves[name];
  if (!wave) return null;
  const W = canvas.width;
  const H = canvas.height;
  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ctx = img.getContext('2d');
  const ov = overview(wave, W);
  const mid = H / 2;
  for (let x = 0; x < W; x++) {
    const h = Math.max(1, ov.peak[x] * (H / 2 - 2));
    ctx.fillStyle = waveColor(name, ov.bass[x], 0.9);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
  return img;
}

function drawOverview(name) {
  const canvas = ui[name].overview;
  const resized = fitCanvas(canvas);
  const deck = mixer.decks[name];
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!deck.buffer || !state.waves[name]) return;
  if (resized || !state.overviewImg[name]) state.overviewImg[name] = buildOverviewImage(name);
  ctx.drawImage(state.overviewImg[name], 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const px = (t) => (t / deck.duration) * W;
  const x = px(deck.position);
  ctx.fillStyle = `rgba(${INK.shade},0.55)`;
  ctx.fillRect(0, 0, x, H);
  if (deck.loop) {
    ctx.fillStyle = 'rgba(66,211,146,0.25)';
    ctx.fillRect(px(deck.loop.start), 0, Math.max(2, px(deck.loop.end) - px(deck.loop.start)), H);
  }
  (deck.track?.cues || []).forEach((c, i) => {
    if (c == null) return;
    ctx.fillStyle = HOTCUE_COLORS[i];
    ctx.fillRect(px(c), 0, 2 * dpr, H);
  });
  ctx.fillStyle = `rgb(${INK.ink})`;
  ctx.fillRect(px(deck.cuePoint), 0, dpr, 6 * dpr);
  ctx.fillRect(x - dpr / 2, 0, 2 * dpr, H);
}

const meterScratch = new Float32Array(1024);
const meterPeaks = { A: -60, B: -60, M: -60 };

function setMeter(el, db, key) {
  const pct = Math.max(0, Math.min(1, (db + 48) / 48));
  meterPeaks[key] = Math.max(db, meterPeaks[key] - 0.6);
  const peakPct = Math.max(0, Math.min(1, (meterPeaks[key] + 48) / 48));
  const fill = $('.meter-fill', el);
  const peak = $('.meter-peak', el);
  if (el.classList.contains('meter-h')) {
    fill.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
    peak.style.left = `calc(${peakPct * 100}% - 2px)`;
  } else {
    fill.style.clipPath = `inset(${(1 - pct) * 100}% 0 0 0)`;
    peak.style.bottom = `calc(${peakPct * 100}% - 2px)`;
  }
}

function frame() {
  for (const name of DECKS) {
    const deck = mixer.decks[name];
    const d = ui[name];
    drawScrolling(name);
    drawOverview(name);
    if (deck.buffer) {
      const pos = deck.position;
      const remain = (deck.duration - pos) / deck.rate;
      d.elapsed.textContent = fmtTime(pos, true);
      d.remain.textContent = fmtTime(-remain, true);
      d.remain.classList.toggle('ending', deck.playing && remain < 30);
    } else {
      d.elapsed.textContent = '0:00.0';
      d.remain.textContent = '−0:00.0';
      d.remain.classList.remove('ending');
    }
    d.cue.classList.toggle('on', !deck.playing && deck.buffer && Math.abs(deck.position - deck.cuePoint) < 0.02);
    setMeter($(`.strip[data-deck="${name}"] .meter`), peakDb(deck.analyser, meterScratch), name);
  }
  setMeter($('#masterMeter'), peakDb(mixer.masterAnalyser, meterScratch), 'M');
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ library

async function refreshLibrary() {
  state.tracks = await api.library.list();
  renderLibrary();
}

function renderLibrary() {
  const q = state.filter.trim().toLowerCase();
  const rows = q
    ? state.tracks.filter((t) => `${t.title} ${t.artist} ${t.source?.uploader || ''} ${keyLabel(t.key)}`.toLowerCase().includes(q))
    : state.tracks;
  const onA = mixer.decks.A.track?.id;
  const onB = mixer.decks.B.track?.id;
  $('#libCount').textContent = state.tracks.length;
  $('#libEmpty').hidden = state.tracks.length > 0;
  $('#libBody').innerHTML = rows
    .map((t) => {
      const web = t.source?.kind === 'web';
      const src = web
        ? `<span class="src cc" title="${escapeHtml(t.source.license || '')}">${escapeHtml(shortLicense(t.source.license))} · ${escapeHtml(t.source.extractor || 'web')}</span>`
        : '<span class="src local">Local file</span>';
      const cls = [t.missing ? 'missing' : '', t.id === onA ? 'on-a' : '', t.id === onB ? 'on-b' : ''].join(' ');
      return `<tr draggable="true" data-id="${t.id}" class="${cls}">
        <td><button class="load-btn a" data-load="A" title="Load to deck A">A</button><button class="load-btn b" data-load="B" title="Load to deck B">B</button></td>
        <td title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</td>
        <td title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</td>
        <td class="num">${t.bpm ? Number(t.bpm).toFixed(1) : ''}</td>
        <td class="c-key" title="${escapeHtml(keyName(t.key))}">${escapeHtml(camelot(t.key))} <span class="dim">${escapeHtml(keyName(t.key))}</span></td>
        <td class="num">${fmtTime(t.duration)}</td>
        <td>${src}</td>
        <td>${web ? '<button class="row-act" data-act="credit" title="Copy attribution">credit</button>' : ''}<button class="row-act" data-act="remove" title="Remove from library">✕</button></td>
      </tr>`;
    })
    .join('');
}

async function removeTrack(id) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  if (mixer.decks.A.track?.id === id || mixer.decks.B.track?.id === id) {
    return toast('That track is loaded on a deck.', 'error');
  }
  const web = t.source?.kind === 'web';
  const ok = confirm(web ? `Remove “${t.title}” and delete its downloaded audio?` : `Remove “${t.title}” from the library? (The file itself stays where it is.)`);
  if (!ok) return;
  await api.library.remove(id, { deleteFile: web });
  state.tracks = state.tracks.filter((x) => x.id !== id);
  renderLibrary();
}

function attribution(t) {
  const s = t.source || {};
  const by = s.uploader || t.artist || 'unknown creator';
  return `“${t.title}” by ${by} — ${s.url || ''} — ${s.license || 'license not checked'}`;
}

function setupLibrary() {
  const body = $('#libBody');
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const load = e.target.closest('[data-load]');
    if (load) return loadToDeck(load.dataset.load, id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') return removeTrack(id);
    if (act === 'credit') {
      const t = state.tracks.find((x) => x.id === id);
      navigator.clipboard.writeText(attribution(t)).then(() => toast('Attribution copied.'));
    }
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target.closest('button')) return;
    // Double-click loads onto whichever deck is stopped (A first).
    const target = !mixer.decks.A.playing ? 'A' : !mixer.decks.B.playing ? 'B' : null;
    if (target) loadToDeck(target, tr.dataset.id);
    else toast('Both decks are playing.', 'error');
  });
  body.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.dataTransfer.setData('text/x-cdj-track', tr.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  const filter = $('#libFilter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderLibrary();
  });

  $('#addFiles').addEventListener('click', async () => {
    const added = await api.library.importDialog();
    if (added.length) {
      await refreshLibrary();
      toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
    }
  });
  $('#openFolder').addEventListener('click', () => api.library.openFolder());
}

async function importFiles(files) {
  const added = await api.library.importFiles(files);
  if (added.length) {
    await refreshLibrary();
    toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
  } else if (files.length) {
    toast('Nothing new to add (unsupported or already in library).');
  }
  return added;
}

// Window-wide file drop.
let dragDepth = 0;
function hideDropOverlay() {
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
}
function setupWindowDrop() {
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('#dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    hideDropOverlay();
    importFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------ Creative Commons search

function setCcStatus(text, error = false) {
  const el = $('#ccStatus');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

// Over this, a result is probably a mix rather than a single track.
const LONG_RESULT_SECONDS = 20 * 60;

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// What exactly was searched, and what came back — so a missing video can be
// traced to the query, the result limit, or the app dropping it.
function renderCcInfo(s) {
  const el = $('#ccInfo');
  if (!s) {
    el.hidden = true;
    return;
  }
  const long = s.results.filter((r) => r.duration > LONG_RESULT_SECONDS).length;
  const live = s.results.filter((r) => !r.duration).length;
  el.innerHTML = `
    <div class="row">
      <span>“<b>${escapeHtml(s.query)}</b>” on YouTube</span>
      <span>showing <b>${s.results.length}</b> of <b>${s.received}</b> returned (limit ${s.limit})</span>
      ${long ? `<span class="warn">${long} over 20 min</span>` : ''}
      ${live ? `<span class="warn">${live} live / no length</span>` : ''}
      ${s.dropped.length ? `<span class="warn">${s.dropped.length} hidden</span>` : ''}
      <span>${(s.ms / 1000).toFixed(1)}s</span>
      <a class="open" data-url="${escapeHtml(s.url)}">Open on YouTube to compare</a>
    </div>
    <details>
      <summary>Details</summary>
      <div class="row">Filter: <b>${escapeHtml(s.filter)}</b></div>
      <div class="row"><code>${escapeHtml(s.url)}</code></div>
      ${s.dropped.map((d) => `<div class="row warn">Hidden: ${escapeHtml(d.title || d.id)} — ${escapeHtml(d.reason)}</div>`).join('')}
    </details>`;
  el.hidden = false;
}

function renderCcResults() {
  $('#ccResults').innerHTML = state.ccResults
    .map((r) => `
      <div class="cc-item" data-vid="${escapeHtml(r.id)}">
        <div class="thumb-wrap">
          ${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="thumb"></div>'}
          ${r.rank ? `<span class="rank">#${r.rank}</span>` : ''}
          ${r.duration ? `<span class="dur ${r.duration > LONG_RESULT_SECONDS ? 'long' : ''}">${fmtDuration(r.duration)}</span>` : ''}
        </div>
        <div class="meta">
          <div class="ttl" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
          <div class="sub">${escapeHtml(r.channel)} · <a class="open" data-url="${escapeHtml(r.url)}">open</a></div>
          <div class="vid">${escapeHtml(r.id)}</div>
          <div class="msg"></div>
        </div>
        <button class="btn ${r.inLibrary ? '' : 'primary'}" data-get="${escapeHtml(r.url)}" ${r.inLibrary ? 'disabled' : ''}>${r.inLibrary ? 'In library' : 'Add'}</button>
        <div class="bar"></div>
      </div>`)
    .join('');
}

async function startDownload(url, itemEl) {
  const id = jobId();
  const btn = itemEl ? $('[data-get]', itemEl) : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
  }
  state.jobs.set(id, { el: itemEl, url });
  try {
    await api.cc.download(url, id);
  } catch {
    // progress handler already reported the error
  } finally {
    state.jobs.delete(id);
  }
}

function onDownloadProgress(p) {
  const job = state.jobs.get(p.jobId);
  const el = job?.el;
  if (el) {
    const btn = $('[data-get]', el);
    const msg = $('.msg', el);
    const bar = $('.bar', el);
    if (p.stage === 'downloading') {
      btn.textContent = p.percent != null ? `${Math.round(p.percent)}%` : '…';
      bar.style.width = `${p.percent || 0}%`;
    } else if (p.stage === 'done') {
      btn.textContent = 'In library';
      btn.classList.remove('primary');
      bar.style.width = '100%';
      msg.textContent = '';
    } else if (p.stage === 'error') {
      btn.disabled = false;
      btn.textContent = 'Retry';
      bar.style.width = '0';
      msg.textContent = p.message;
      msg.classList.add('error');
    } else {
      btn.textContent = p.stage === 'setup' ? 'Setting up…' : 'Fetching…';
      msg.textContent = p.message || '';
      msg.classList.remove('error');
    }
  } else {
    // A pasted link (no result card): use the status line.
    if (p.stage === 'downloading') setCcStatus(`Downloading… ${p.percent != null ? Math.round(p.percent) + '%' : ''}`);
    else if (p.stage === 'error') setCcStatus(p.message, true);
    else if (p.stage === 'done') setCcStatus(`${p.message}: “${p.track?.title}”`);
    else setCcStatus(p.message || 'Working…');
  }
  if (p.stage === 'done' && p.track) {
    const isNew = !state.tracks.some((t) => t.id === p.track.id);
    if (isNew) state.tracks.unshift(p.track);
    renderLibrary();
    toast(isNew ? `Added “${p.track.title}”.` : `“${p.track.title}” is already in your library.`);
  } else if (p.stage === 'error' && !el) {
    toast(p.message, 'error');
  }
}

function setupCc() {
  api.cc.onProgress(onDownloadProgress);

  $('#ccSearchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#ccQuery').value.trim();
    if (!q) return;
    setCcStatus(`Searching YouTube for “${q}”…`);
    $('#ccResults').innerHTML = '';
    renderCcInfo(null);
    try {
      const search = await api.cc.search(q);
      state.ccResults = search.results;
      setCcStatus(state.ccResults.length ? '' : 'No results. Try broader words.');
      renderCcInfo(search);
      renderCcResults();
    } catch (err) {
      setCcStatus(`Search failed: ${cleanErr(err)}`, true);
    }
    refreshYtdlpChip?.();
  });

  $('#ccLinkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#ccLink').value.trim();
    if (!url) return;
    $('#ccLink').value = '';
    setCcStatus('Fetching video info…');
    startDownload(url, null);
  });

  $('#ccResults').addEventListener('click', (e) => {
    const get = e.target.closest('[data-get]');
    if (get && !get.disabled) return startDownload(get.dataset.get, get.closest('.cc-item'));
    const open = e.target.closest('a.open');
    if (open) api.openExternal(open.dataset.url);
  });

  $('#ccInfo').addEventListener('click', (e) => {
    const open = e.target.closest('a.open');
    if (open) api.openExternal(open.dataset.url);
  });
}

// ------------------------------------------------------------------ top bar & dialogs

let refreshYtdlpChip = null;

async function setupYtdlpChip() {
  const chip = $('#ytdlpChip');
  const refresh = (refreshYtdlpChip = async () => {
    chip.textContent = 'yt-dlp …';
    chip.className = 'chip';
    const s = await api.ytdlp.status();
    if (s.installed) {
      chip.textContent = `yt-dlp ${s.version}`;
      chip.className = 'chip ok';
      chip.title = 'Click to check for a yt-dlp update';
    } else {
      chip.textContent = 'yt-dlp not set up';
      chip.className = 'chip warn';
      chip.title = s.error || 'It will be downloaded the first time you search.';
    }
  });
  chip.addEventListener('click', async () => {
    chip.textContent = 'Updating…';
    try {
      const msg = await api.ytdlp.update();
      toast(msg || 'yt-dlp is up to date.');
    } catch (err) {
      toast(`yt-dlp update failed: ${cleanErr(err)}`, 'error');
    }
    refresh();
  });
  refresh();
}

function setupDialogs() {
  const help = $('#helpDialog');
  $('#helpBtn').addEventListener('click', () => help.showModal());
  const credits = $('#creditsDialog');
  $('#creditsBtn').addEventListener('click', () => {
    const lines = [...state.played.values()].map(attribution);
    $('#creditsText').value = lines.length ? `Music credits\n\n${lines.join('\n')}` : 'Play a Creative Commons track and it will show up here.';
    credits.showModal();
  });
  $('#copyCredits').addEventListener('click', () =>
    navigator.clipboard.writeText($('#creditsText').value).then(() => toast('Credits copied.')),
  );
}

function setupTabs() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => {
        t.classList.toggle('on', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab.dataset.tab));
      $('.tab-tools[data-for="library"]').hidden = tab.dataset.tab !== 'library';
      if (tab.dataset.tab === 'cc') $('#ccQuery').focus();
    }),
  );

  // Expand: the library / search panel covers the decks. Esc goes back.
  const max = $('#browseMax');
  const setMax = (on) => {
    document.body.classList.toggle('browse-max', on);
    max.textContent = on ? 'Collapse ⤡' : 'Expand ⤢';
  };
  max.addEventListener('click', () => setMax(!document.body.classList.contains('browse-max')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('browse-max') && !e.target.closest?.('input, textarea, select, dialog')) setMax(false);
  });
}

function setupZoom() {
  $('#zoomIn').addEventListener('click', () => (state.zoom = Math.min(400, state.zoom * 1.4)));
  $('#zoomOut').addEventListener('click', () => (state.zoom = Math.max(25, state.zoom / 1.4)));
}

// ------------------------------------------------------------------ keyboard

function setupKeyboard() {
  const held = new Set();
  const typing = (e) => e.target.closest('input[type="search"], input[type="url"], input[type="text"], textarea, select');
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape' && typing(e)) e.target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    const A = mixer.decks.A;
    const B = mixer.decks.B;
    const xf = $('#crossfader');
    const setXf = (v) => {
      xf.value = v;
      mixer.setCrossfader(v);
    };
    const hotA = { '1': 0, '2': 1, '3': 2, '4': 3 };
    const hotB = { '7': 0, '8': 1, '9': 2, '0': 3 };
    let handled = true;
    if (k === 'x') { A.toggle(); markPlayed('A'); }
    else if (k === 'z') A.cue();
    else if (k === 'c') doSync('A');
    else if (k === ',') { B.toggle(); markPlayed('B'); }
    else if (k === 'm') B.cue();
    else if (k === '.') doSync('B');
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotA && !e.shiftKey) hotcue('A', hotA[e.code.slice(5)]);
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotA && e.shiftKey) clearHotcue('A', hotA[e.code.slice(5)]);
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotB) (e.shiftKey ? clearHotcue : hotcue)('B', hotB[e.code.slice(5)]);
    else if (['q', 'w', 'o', 'p'].includes(k)) {
      if (!held.has(k)) {
        held.add(k);
        const deck = k === 'q' || k === 'w' ? A : B;
        deck.bend(k === 'q' || k === 'o' ? -0.04 : 0.04);
      }
    } else if (e.key === 'ArrowLeft') setXf(e.shiftKey ? 0 : Math.max(0, Number(xf.value) - 0.05));
    else if (e.key === 'ArrowRight') setXf(e.shiftKey ? 1 : Math.min(1, Number(xf.value) + 0.05));
    else if (e.key === '/') { $$('.tab')[0].click(); $('#libFilter').focus(); }
    else if (e.key === '?') $('#helpDialog').showModal();
    else handled = false;
    if (handled) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (held.has(k)) {
      held.delete(k);
      (k === 'q' || k === 'w' ? mixer.decks.A : mixer.decks.B).endBend();
    }
  });
}

// ------------------------------------------------------------------ boot

function setTheme(name) {
  document.body.dataset.theme = name;
  const css = getComputedStyle(document.body);
  const rgb = (v) => css.getPropertyValue(v).trim();
  INK.ink = rgb('--ink-rgb');
  INK.shade = rgb('--shade-rgb');
  INK.hi = rgb('--wave-hi-rgb').split(',').map(Number);
  ACCENT.A = rgb('--a-rgb').split(',').map(Number);
  ACCENT.B = rgb('--b-rgb').split(',').map(Number);
  DECKS.forEach((n) => (state.overviewImg[n] = null)); // redraw overviews in the new colours
  try {
    localStorage.setItem('theme', name);
  } catch {}
}
{
  let saved = 'light';
  try {
    saved = localStorage.getItem('theme') || 'light';
  } catch {}
  $('#themeSel').value = saved;
  setTheme(saved);
  $('#themeSel').addEventListener('change', (e) => setTheme(e.target.value));

  // Optional background picture of the user's choosing.
  // shortcut: stored as a data URL in localStorage (~5 MB cap), move to the app data folder if bigger images are needed.
  const applyBg = (url) => document.body.style.setProperty('--user-bg', url ? `url("${url}")` : 'none');
  try {
    applyBg(localStorage.getItem('bg'));
  } catch {}
  $('#bgBtn').addEventListener('click', () => $('#bgFile').click());
  $('#bgBtn').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    applyBg(null);
    try {
      localStorage.removeItem('bg');
    } catch {}
  });
  $('#bgFile').addEventListener('change', () => {
    const file = $('#bgFile').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      applyBg(reader.result);
      try {
        localStorage.setItem('bg', reader.result);
      } catch {
        toast('Picture is too big to remember after restart — it shows for now.', 'error');
      }
    };
    reader.readAsDataURL(file);
  });
}

DECKS.forEach(buildDeck);
buildMixer();
setupLibrary();
setupWindowDrop();
setupCc();
setupDialogs();
setupTabs();
setupZoom();
setupKeyboard();
setupYtdlpChip();
DECKS.forEach((n) => {
  renderTempo(n);
  renderHotcues(n);
  renderKey(n);
  renderStems(n);
});
api.stems.onProgress(({ trackId, done, total }) => {
  if (!state.stemJobs.has(trackId)) return;
  state.stemJobs.set(trackId, { done, total });
  DECKS.forEach(renderStems);
});
mixer.fxReady.then((ok) => {
  if (!ok) toast('Key shift and stems couldn’t start on this computer — decks still play normally.', 'error');
});
refreshLibrary();
requestAnimationFrame(frame);

// Browsers start audio suspended until a user gesture.
window.addEventListener('pointerdown', () => mixer.resume(), { once: true });
window.addEventListener('keydown', () => mixer.resume(), { once: true });
