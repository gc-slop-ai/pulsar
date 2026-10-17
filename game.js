'use strict';
// ПУЛЬСАР — неоновый аренный шутер. Canvas 2D + самодельный bloom + пружинная сетка + WebAudio-синтез.
(() => {
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  const ARENA_W = 2600, ARENA_H = 1600;
  const VIEW_H = 950;

  // палитра
  const COLS = [
    [255, 255, 255], [60, 230, 255], [255, 60, 220], [80, 255, 120], [255, 150, 40],
    [255, 235, 70], [255, 50, 60], [70, 110, 255], [170, 90, 255], [255, 120, 190],
  ];
  const WHITE = 0, CYAN = 1, MAGENTA = 2, GREEN = 3, ORANGE = 4, YELLOW = 5, RED = 6, BLUE = 7, PURPLE = 8, PINK = 9;
  const C = COLS.map((c) => `rgb(${c})`);
  const CA = (i, a) => `rgba(${COLS[i]},${a})`;

  // ───────────────────────── холсты ─────────────────────────
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scene = document.createElement('canvas');
  const sctx = scene.getContext('2d');
  const bA = document.createElement('canvas'), bActx = bA.getContext('2d');
  const bB = document.createElement('canvas'), bBctx = bB.getContext('2d');
  const bC = document.createElement('canvas'), bCctx = bC.getContext('2d');
  const HAS_FILTER = typeof sctx.filter === 'string';
  let W = 0, H = 0, DPR = 1, zoom = 1;
  let scanPattern = null;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = scene.width = Math.round(W * DPR);
    canvas.height = scene.height = Math.round(H * DPR);
    bA.width = bB.width = Math.max(1, Math.round(canvas.width / 4));
    bA.height = bB.height = Math.max(1, Math.round(canvas.height / 4));
    bC.width = Math.max(1, Math.round(canvas.width / 10));
    bC.height = Math.max(1, Math.round(canvas.height / 10));
    zoom = H / VIEW_H;
    if (W / zoom > 1900) zoom = W / 1900;
    if (W / zoom < 760) zoom = W / 760;
    const sc = document.createElement('canvas');
    sc.width = 1; sc.height = 3;
    const sc2 = sc.getContext('2d');
    sc2.fillStyle = 'rgba(0,0,0,0.22)'; sc2.fillRect(0, 0, 1, 1);
    scanPattern = ctx.createPattern(sc, 'repeat');
  }
  window.addEventListener('resize', resize);
  resize();

  // туманность — заранее отрендеренный слой
  const nebula = document.createElement('canvas');
  (function buildNebula() {
    nebula.width = 1024; nebula.height = 640;
    const n = nebula.getContext('2d');
    n.fillStyle = '#04040c'; n.fillRect(0, 0, 1024, 640);
    n.globalCompositeOperation = 'lighter';
    const tints = [[90, 20, 160], [20, 60, 170], [150, 20, 110], [10, 110, 140], [60, 10, 90]];
    for (let i = 0; i < 46; i++) {
      const x = rand(0, 1024), y = rand(0, 640), r = rand(60, 260);
      const t = pick(tints);
      const g = n.createRadialGradient(x, y, 0, x, y, r);
      const a = rand(0.04, 0.13);
      g.addColorStop(0, `rgba(${t},${a})`);
      g.addColorStop(1, `rgba(${t},0)`);
      n.fillStyle = g; n.fillRect(x - r, y - r, r * 2, r * 2);
    }
  })();

  const stars = [];
  for (let i = 0; i < 340; i++) {
    stars.push({ x: rand(0, 4000), y: rand(0, 4000), z: rand(0.05, 0.45), tw: rand(0, TAU), s: rand(0.6, 1.8) });
  }

  // ───────────────────────── звук ─────────────────────────
  const Sound = (() => {
    let ac = null, master, sfx, mus, noiseBuf, muted = false, musicOn = false;
    let nextNote = 0, step = 0, intensity = 0;
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    function init() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; return; }
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.7;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      master.connect(comp); comp.connect(ac.destination);
      sfx = ac.createGain(); sfx.gain.value = 0.55; sfx.connect(master);
      mus = ac.createGain(); mus.gain.value = 0.32; mus.connect(master);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      setInterval(schedule, 25);
    }
    const ok = () => ac && !muted && ac.state === 'running';
    function env(g, t, a, peak, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    function tone(type, f0, f1, dur, vol, dest = sfx, t = ac.currentTime) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      env(g, t, 0.003, vol, dur);
      o.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function noise(dur, vol, fType, f0, f1, dest = sfx, t = ac.currentTime, q = 1) {
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const f = ac.createBiquadFilter(); f.type = fType; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain(); env(g, t, 0.004, vol, dur);
      s.connect(f); f.connect(g); g.connect(dest);
      s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    }
    let lastShoot = 0, boomWindow = 0, boomCount = 0;
    return {
      init,
      get muted() { return muted; },
      toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.7; },
      shoot() {
        if (!ok()) return; const t = ac.currentTime;
        if (t - lastShoot < 0.06) return; lastShoot = t;
        tone('square', rand(880, 1020), 200, 0.06, 0.035);
      },
      boom(size = 1) {
        if (!ok()) return; const t = ac.currentTime;
        if (t - boomWindow > 0.08) { boomWindow = t; boomCount = 0; }
        if (++boomCount > 3) return;
        noise(0.25 + 0.35 * size, Math.min(0.35, 0.12 * size + 0.08), 'lowpass', 2600 + 1000 * size, 90);
        tone('sine', 160, 38, 0.2 + 0.2 * size, Math.min(0.5, 0.18 * size + 0.1));
      },
      hit() { if (!ok()) return; tone('triangle', 1600, 900, 0.04, 0.03); },
      pickup(m) { if (!ok()) return; const f = 620 * Math.pow(2, (m % 24) / 24); tone('sine', f, f * 1.5, 0.09, 0.06); },
      power() {
        if (!ok()) return; const t = ac.currentTime;
        [0, 4, 7, 12, 16].forEach((n, i) => tone('square', mtof(72 + n), mtof(72 + n), 0.1, 0.05, sfx, t + i * 0.05));
      },
      oneUp() {
        if (!ok()) return; const t = ac.currentTime;
        [0, 7, 12, 19, 24].forEach((n, i) => tone('triangle', mtof(76 + n), mtof(76 + n), 0.15, 0.08, sfx, t + i * 0.07));
      },
      dash() { if (!ok()) return; noise(0.18, 0.12, 'bandpass', 600, 3500, sfx, ac.currentTime, 3); },
      bomb() {
        if (!ok()) return;
        noise(1.4, 0.45, 'lowpass', 5000, 60);
        tone('sawtooth', 90, 25, 1.2, 0.25);
        tone('sine', 1200, 60, 0.9, 0.12);
      },
      death() {
        if (!ok()) return;
        noise(1.6, 0.5, 'lowpass', 4000, 40);
        tone('sawtooth', 440, 30, 1.4, 0.18);
        tone('sine', 220, 20, 1.5, 0.35);
      },
      spawnHole() { if (!ok()) return; tone('sine', 60, 220, 0.6, 0.15); },
      bossRoar() {
        if (!ok()) return;
        tone('sawtooth', 55, 110, 1.5, 0.22); tone('sawtooth', 82, 41, 1.8, 0.18);
        noise(1.5, 0.2, 'bandpass', 200, 1200, sfx, ac.currentTime, 4);
      },
      enemyShot() { if (!ok()) return; tone('sine', 520, 260, 0.08, 0.025); },
      startMusic() { if (!ac) return; if (!musicOn) { musicOn = true; nextNote = ac.currentTime + 0.05; } },
      stopMusic() { musicOn = false; },
      setIntensity(i) { intensity = i; },
    };
    function schedule() {
      if (!musicOn || !ac || ac.state !== 'running') return;
      const s16 = 60 / 128 / 4;
      if (nextNote < ac.currentTime) nextNote = ac.currentTime + 0.02;
      while (nextNote < ac.currentTime + 0.12) { playStep(step, nextNote); nextNote += s16; step = (step + 1) % 64; }
    }
    function playStep(st, t) {
      if (muted) return;
      const bar = (st >> 4) & 3, s = st & 15;
      const root = [45, 41, 48, 43][bar];
      if (s % 4 === 0) { // бочка
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
        env(g, t, 0.002, 0.7, 0.22); o.connect(g); g.connect(mus); o.start(t); o.stop(t + 0.3);
      }
      if (s % 4 === 2) noise(0.05, 0.12, 'highpass', 8000, 6000, mus, t);
      else if (intensity >= 2 && s % 2 === 1) noise(0.03, 0.05, 'highpass', 9000, 7000, mus, t);
      if (intensity >= 1 && (s === 4 || s === 12)) noise(0.16, 0.22, 'bandpass', 1800, 900, mus, t, 1.5);
      if (s % 2 === 0) { // бас
        const note = root + ((s === 6 || s === 14) ? 12 : 0) - 12;
        const o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
        o.type = 'sawtooth'; o.frequency.value = mtof(note);
        f.type = 'lowpass'; f.Q.value = 8;
        f.frequency.setValueAtTime(300 + intensity * 250, t); f.frequency.exponentialRampToValueAtTime(90, t + 0.18);
        env(g, t, 0.004, 0.28, 0.17);
        o.connect(f); f.connect(g); g.connect(mus); o.start(t); o.stop(t + 0.25);
      }
      if (intensity >= 2) { // арпеджио
        const chord = bar === 0 ? [0, 3, 7, 12] : bar === 1 ? [0, 4, 7, 12] : bar === 2 ? [0, 4, 7, 11] : [0, 4, 7, 10];
        const n = root + 24 + chord[(s + (s >> 2)) % 4];
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'square'; o.frequency.value = mtof(n);
        env(g, t, 0.003, 0.045, 0.09); o.connect(g); g.connect(mus); o.start(t); o.stop(t + 0.12);
      }
      if (intensity >= 3 && s === 0) { // пэд
        [0, 7, 12].forEach((k) => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = 'triangle'; o.frequency.value = mtof(root + 12 + k);
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.3);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
          o.connect(g); g.connect(mus); o.start(t); o.stop(t + 1.9);
        });
      }
    }
  })();

  // ───────────────────────── пружинная сетка ─────────────────────────
  const Grid = (() => {
    const SP = 50;
    const cols = Math.round(ARENA_W / SP) + 1, rows = Math.round(ARENA_H / SP) + 1;
    const N = cols * rows;
    const dx = new Float32Array(N), dy = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
    function force(x, y, radius, strength) {
      const c0 = Math.max(1, Math.floor((x - radius) / SP)), c1 = Math.min(cols - 2, Math.ceil((x + radius) / SP));
      const r0 = Math.max(1, Math.floor((y - radius) / SP)), r1 = Math.min(rows - 2, Math.ceil((y + radius) / SP));
      const rr = radius * radius;
      for (let j = r0; j <= r1; j++) {
        for (let i = c0; i <= c1; i++) {
          const k = j * cols + i;
          const ex = i * SP + dx[k] - x, ey = j * SP + dy[k] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 < rr && d2 > 1) {
            const d = Math.sqrt(d2);
            const f = (strength * (1 - d / radius)) / d;
            vx[k] += ex * f; vy[k] += ey * f;
          }
        }
      }
    }
    function step() {
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const k = j * cols + i;
          const lx = dx[k - 1] + dx[k + 1] + dx[k - cols] + dx[k + cols] - 4 * dx[k];
          const ly = dy[k - 1] + dy[k + 1] + dy[k - cols] + dy[k + cols] - 4 * dy[k];
          vx[k] = (vx[k] - 0.018 * dx[k] + 0.09 * lx) * 0.91;
          vy[k] = (vy[k] - 0.018 * dy[k] + 0.09 * ly) * 0.91;
        }
      }
      const lim = SP * 1.4;
      for (let k = 0; k < N; k++) {
        let x = dx[k] + vx[k], y = dy[k] + vy[k];
        const m = x * x + y * y;
        if (m > lim * lim) { const s = lim / Math.sqrt(m); x *= s; y *= s; }
        dx[k] = x; dy[k] = y;
      }
    }
    function reset() { dx.fill(0); dy.fill(0); vx.fill(0); vy.fill(0); }
    function draw(c, x0, y0, x1, y1) {
      const i0 = Math.max(0, Math.floor(x0 / SP) - 1), i1 = Math.min(cols - 1, Math.ceil(x1 / SP) + 1);
      const j0 = Math.max(0, Math.floor(y0 / SP) - 1), j1 = Math.min(rows - 1, Math.ceil(y1 / SP) + 1);
      for (let pass = 0; pass < 2; pass++) {
        c.beginPath();
        for (let j = j0; j <= j1; j++) {
          if ((j % 4 === 0) !== (pass === 1)) continue;
          for (let i = i0; i <= i1; i++) {
            const k = j * cols + i;
            const x = i * SP + dx[k], y = j * SP + dy[k];
            if (i === i0) c.moveTo(x, y); else c.lineTo(x, y);
          }
        }
        for (let i = i0; i <= i1; i++) {
          if ((i % 4 === 0) !== (pass === 1)) continue;
          for (let j = j0; j <= j1; j++) {
            const k = j * cols + i;
            const x = i * SP + dx[k], y = j * SP + dy[k];
            if (j === j0) c.moveTo(x, y); else c.lineTo(x, y);
          }
        }
        if (pass === 0) { c.strokeStyle = 'rgba(50,80,255,0.2)'; c.lineWidth = 1.3; }
        else { c.strokeStyle = 'rgba(80,120,255,0.45)'; c.lineWidth = 2.2; }
        c.stroke();
      }
      // яркие узлы там, где сетка сильно смещена
      c.fillStyle = 'rgba(150,190,255,0.9)';
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * cols + i;
          const m = Math.abs(dx[k]) + Math.abs(dy[k]);
          if (m > 9) {
            const s = Math.min(4, m * 0.08);
            c.fillRect(i * SP + dx[k] - s / 2, j * SP + dy[k] - s / 2, s, s);
          }
        }
      }
    }
    return { force, step, reset, draw };
  })();

  // ───────────────────────── частицы ─────────────────────────
  const PMAX = 6000;
  const px = new Float32Array(PMAX), py = new Float32Array(PMAX), pvx = new Float32Array(PMAX), pvy = new Float32Array(PMAX);
  const plife = new Float32Array(PMAX), pmax = new Float32Array(PMAX), plen = new Float32Array(PMAX), pdrag = new Float32Array(PMAX);
  const pcol = new Uint8Array(PMAX);
  let pcount = 0;
  function spawnP(x, y, vx, vy, life, col, len = 1, drag = 0.93) {
    let i;
    if (pcount < PMAX) i = pcount++;
    else i = (Math.random() * PMAX) | 0;
    px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy; plife[i] = pmax[i] = life; pcol[i] = col; plen[i] = len; pdrag[i] = drag;
  }
  function burst(x, y, col, n, speed, life = 0.9, len = 1, drag = 0.93) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = speed * Math.pow(Math.random(), 0.6);
      spawnP(x, y, Math.cos(a) * s, Math.sin(a) * s, life * rand(0.5, 1.2), col, len, drag);
    }
  }
  const NB = COLS.length * 4;
  const bucketCount = new Int32Array(NB), bucketStart = new Int32Array(NB), bucketFill = new Int32Array(NB);
  const bucketIdx = new Int32Array(PMAX);
  const ALPHAS = [0.22, 0.45, 0.72, 1];
  function updateParticles(dt) {
    const holes = enemies.filter((e) => e.type === 'hole' && e.spawnT <= 0 && !e.dead);
    for (let i = 0; i < pcount; i++) {
      plife[i] -= dt;
      if (plife[i] <= 0) {
        pcount--;
        px[i] = px[pcount]; py[i] = py[pcount]; pvx[i] = pvx[pcount]; pvy[i] = pvy[pcount];
        plife[i] = plife[pcount]; pmax[i] = pmax[pcount]; pcol[i] = pcol[pcount]; plen[i] = plen[pcount]; pdrag[i] = pdrag[pcount];
        i--; continue;
      }
      for (let h = 0; h < holes.length; h++) {
        const o = holes[h];
        const ex = o.x - px[i], ey = o.y - py[i];
        const d2 = ex * ex + ey * ey;
        if (d2 < 160000 && d2 > 4) {
          const d = Math.sqrt(d2), f = 1400 * (1 - d / 400) * dt / d;
          pvx[i] += (ex - ey * 0.9) * f; pvy[i] += (ey + ex * 0.9) * f;
        }
      }
      const dr = Math.pow(pdrag[i], dt * 60);
      pvx[i] *= dr; pvy[i] *= dr;
      px[i] += pvx[i] * dt; py[i] += pvy[i] * dt;
      if (px[i] < 0) { px[i] = 0; pvx[i] = -pvx[i] * 0.6; } else if (px[i] > ARENA_W) { px[i] = ARENA_W; pvx[i] = -pvx[i] * 0.6; }
      if (py[i] < 0) { py[i] = 0; pvy[i] = -pvy[i] * 0.6; } else if (py[i] > ARENA_H) { py[i] = ARENA_H; pvy[i] = -pvy[i] * 0.6; }
    }
  }
  function drawParticles(c, x0, y0, x1, y1) {
    bucketCount.fill(0);
    const keys = new Uint8Array(pcount);
    for (let i = 0; i < pcount; i++) {
      if (px[i] < x0 || px[i] > x1 || py[i] < y0 || py[i] > y1) { keys[i] = 255; continue; }
      const lvl = Math.min(3, ((plife[i] / pmax[i]) * 4) | 0);
      const k = pcol[i] * 4 + lvl;
      keys[i] = k; bucketCount[k]++;
    }
    let acc = 0;
    for (let k = 0; k < NB; k++) { bucketStart[k] = acc; bucketFill[k] = acc; acc += bucketCount[k]; }
    for (let i = 0; i < pcount; i++) if (keys[i] !== 255) bucketIdx[bucketFill[keys[i]]++] = i;
    c.lineWidth = 2.4; c.lineCap = 'round';
    for (let k = 0; k < NB; k++) {
      const n = bucketCount[k];
      if (!n) continue;
      c.strokeStyle = CA(k >> 2, ALPHAS[k & 3]);
      c.beginPath();
      for (let q = bucketStart[k], e = q + n; q < e; q++) {
        const i = bucketIdx[q];
        let tx = pvx[i] * 0.024 * plen[i], ty = pvy[i] * 0.024 * plen[i];
        if (tx * tx + ty * ty < 2) { tx = 1; ty = 0.5; }
        c.moveTo(px[i], py[i]); c.lineTo(px[i] - tx, py[i] - ty);
      }
      c.stroke();
    }
  }

  // ───────────────────────── состояние ─────────────────────────
  const G = {
    state: 'title', paused: false, score: 0, best: 0, mult: 1, lives: 3, bombs: 3, wave: 0,
    waveTime: 0, spawnTimer: 0, isBoss: false, bossSpawned: false, bossTimer: 0,
    timeScale: 1, hitstop: 0, shake: 0, flash: 0, flashCol: WHITE, t: 0,
    announce: null, nextLife: 75000, nextBomb: 50000, puTimer: 18, respawnT: 0, autofire: false,
    kills: 0, maxMult: 1, usePad: false, god: false,
  };
  try { G.best = +localStorage.getItem('pulsar.best') || 0; } catch (e) { /* нет хранилища */ }

  const P = { x: ARENA_W / 2, y: ARENA_H / 2, vx: 0, vy: 0, ang: 0, r: 13, alive: false, inv: 0,
    dashCD: 0, dashT: 0, dashX: 0, dashY: 0, fireCD: 0, power: null, powerT: 0, ghostT: 0 };
  const cam = { x: ARENA_W / 2, y: ARENA_H / 2 };
  let enemies = [], bullets = [], ebullets = [], gems = [], pickups = [], rings = [], texts = [], ghosts = [];

  // ───────────────────────── ввод ─────────────────────────
  const keys = new Set();
  const mouse = { x: 0, y: 0, down: false, moved: false };
  const pad = { mx: 0, my: 0, ax: 0, ay: 0, dash: false, bomb: false, start: false, prev: {} };
  window.addEventListener('keydown', (e) => {
    const k = e.code;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
    if (keys.has(k)) return;
    keys.add(k);
    if (G.state === 'play') {
      if (k === 'Space') useBomb();
      if (k === 'ShiftLeft' || k === 'ShiftRight') tryDash();
      if (k === 'KeyP' || k === 'Escape') togglePause();
      if (k === 'KeyF') { G.autofire = !G.autofire; floatText(P.x, P.y - 40, G.autofire ? 'АВТООГОНЬ ВКЛ' : 'АВТООГОНЬ ВЫКЛ', CYAN, 1.2); }
    } else if (G.state === 'title' || G.state === 'over') {
      if (k === 'Enter') startGame();
    }
    if (k === 'KeyM') Sound.toggleMute();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); mouse.down = false; if (G.state === 'play' && !G.paused) togglePause(); });
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; G.usePad = false; });
  canvas.addEventListener('mousedown', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (e.button === 0) mouse.down = true;
    if (e.button === 2 && G.state === 'play') tryDash();
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    pad.mx = dz(gp.axes[0] || 0); pad.my = dz(gp.axes[1] || 0);
    pad.ax = dz(gp.axes[2] || 0); pad.ay = dz(gp.axes[3] || 0);
    if (Math.hypot(pad.ax, pad.ay) > 0.3 || Math.hypot(pad.mx, pad.my) > 0.3) G.usePad = true;
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (name, v) => { const was = pad.prev[name]; pad.prev[name] = v; return v && !was; };
    if (edge('dash', b(0) || b(5))) { if (G.state === 'play') tryDash(); }
    if (edge('bomb', b(4) || b(1))) { if (G.state === 'play') useBomb(); }
    if (edge('start', b(9))) {
      if (G.state === 'play') togglePause();
      else startGame();
    }
  }

  // ───────────────────────── утилиты эффектов ─────────────────────────
  function addRing(x, y, maxR, col, life = 0.5, w = 4) { rings.push({ x, y, r: 0, maxR, col, life, max: life, w }); }
  function floatText(x, y, txt, col, life = 0.9, size = 20) { texts.push({ x, y, txt, col, life, max: life, size }); }
  function shake(a) { G.shake = Math.min(1.2, G.shake + a); }
  function flash(a, col = WHITE) { G.flash = Math.max(G.flash, a); G.flashCol = col; }
  function explode(x, y, col, size = 1) {
    burst(x, y, col, Math.round(36 * size), 520 * Math.sqrt(size), 0.9, 1.2);
    burst(x, y, WHITE, Math.round(12 * size), 380 * Math.sqrt(size), 0.5, 1);
    addRing(x, y, 70 * size, col, 0.35 + 0.1 * size, 3);
    Grid.force(x, y, 150 * Math.sqrt(size), 5 * size);
    shake(0.08 * size);
    Sound.boom(size);
  }
  function announce(title, sub, col = CYAN) { G.announce = { title, sub, t: 0, col }; }

  // ───────────────────────── враги ─────────────────────────
  const TYPES = {
    wanderer: { r: 16, hp: 1, score: 25, col: PURPLE, gems: 1 },
    seeker: { r: 15, hp: 1, score: 50, col: CYAN, gems: 1 },
    square: { r: 18, hp: 2, score: 100, col: GREEN, gems: 2 },
    mini: { r: 10, hp: 1, score: 50, col: PINK, gems: 1 },
    dart: { r: 15, hp: 2, score: 80, col: ORANGE, gems: 2 },
    hole: { r: 24, hp: 14, score: 400, col: RED, gems: 6 },
    snake: { r: 16, hp: 5, score: 300, col: YELLOW, gems: 5 },
    spark: { r: 8, hp: 1, score: 20, col: WHITE, gems: 0 },
    boss: { r: 62, hp: 220, score: 15000, col: MAGENTA, gems: 40 },
  };
  function spawnEnemy(type, x, y, opt = {}) {
    const t = TYPES[type];
    const e = { type, x: clamp(x, 40, ARENA_W - 40), y: clamp(y, 40, ARENA_H - 40), vx: 0, vy: 0, r: t.r, hp: t.hp,
      score: t.score, col: t.col, gems: t.gems, ang: rand(0, TAU), t: rand(0, 10), spawnT: opt.instant ? 0.12 : 0.8,
      dead: false, hitFlash: 0, seed: rand(0, 100) };
    e.maxHp = e.hp;
    if (type === 'wanderer') e.dir = rand(0, TAU);
    if (type === 'dart') { e.state = 'aim'; e.st = rand(0.4, 1.2); e.tx = 0; e.ty = 0; }
    if (type === 'hole') { e.mass = 0; Sound.spawnHole(); }
    if (type === 'snake') {
      e.hp = e.maxHp = 5 + Math.floor(G.wave / 3);
      e.segs = [];
      for (let i = 0; i < 16; i++) e.segs.push({ x: e.x, y: e.y });
      e.heading = rand(0, TAU);
    }
    if (type === 'boss') {
      e.hp = e.maxHp = 200 + G.wave * 14;
      e.segN = 16; e.segs = new Array(e.segN).fill(8); e.segR = 108; e.rot = 0;
      e.atk = 'idle'; e.atkT = 2.5; e.shotT = 0; e.volleys = 0; e.spawnT = 2.2; e.dying = 0; e.atkIdx = 0;
      e.home = { x: e.x, y: e.y };
    }
    if (opt.vx) { e.vx = opt.vx; e.vy = opt.vy; }
    enemies.push(e);
    if (!opt.instant) addRing(e.x, e.y, 46, e.col, 0.8, 2);
    return e;
  }
  function spawnPos(minD = 380) {
    for (let tries = 0; tries < 30; tries++) {
      const x = rand(70, ARENA_W - 70), y = rand(70, ARENA_H - 70);
      if (!P.alive || Math.hypot(x - P.x, y - P.y) > minD) return { x, y };
    }
    return { x: P.x < ARENA_W / 2 ? ARENA_W - 100 : 100, y: P.y < ARENA_H / 2 ? ARENA_H - 100 : 100 };
  }
  function killEnemy(e, byBomb = false) {
    if (e.dead) return;
    e.dead = true;
    G.kills++;
    const pts = e.score * G.mult;
    G.score += pts;
    const size = e.type === 'hole' ? 3 : e.type === 'snake' ? 2 : e.type === 'square' ? 1.3 : e.type === 'spark' ? 0.5 : 1;
    explode(e.x, e.y, e.col, size);
    if (e.score >= 250) floatText(e.x, e.y, '+' + pts.toLocaleString('ru-RU'), e.col, 1.1, 24);
    if (!byBomb) for (let i = 0; i < e.gems; i++) gems.push({ x: e.x, y: e.y, vx: rand(-160, 160), vy: rand(-160, 160), life: 9, ang: rand(0, TAU) });
    if (!byBomb && Math.random() < 0.025 && pickups.length < 2) spawnPickup(e.x, e.y);
    if (e.type === 'square') {
      for (let i = 0; i < 2; i++) {
        const a = rand(0, TAU);
        spawnEnemy('mini', e.x, e.y, { instant: true, vx: Math.cos(a) * 320, vy: Math.sin(a) * 320 });
      }
    }
    if (e.type === 'snake') {
      e.segs.forEach((s, i) => setTimeout(() => { burst(s.x, s.y, YELLOW, 14, 300, 0.6); Grid.force(s.x, s.y, 90, 3); }, i * 30));
    }
    if (e.type === 'hole') {
      G.hitstop = 0.06; flash(0.25, RED);
      burst(e.x, e.y, ORANGE, 120, 800, 1.3, 1.6);
      Grid.force(e.x, e.y, 400, 14);
    }
    checkThresholds();
  }
  function checkThresholds() {
    if (G.score >= G.nextLife) { G.nextLife += 100000; G.lives++; announce('+1 ЖИЗНЬ', '', GREEN); Sound.oneUp(); }
    if (G.score >= G.nextBomb) { G.nextBomb += 60000; G.bombs++; floatText(P.x, P.y - 50, '+1 БОМБА', YELLOW, 1.5, 24); Sound.oneUp(); }
  }
  function damageEnemy(e, dmg, bx, by) {
    e.hp -= dmg; e.hitFlash = 0.08;
    if (e.type === 'hole') { Grid.force(e.x, e.y, 200, 3); e.mass = Math.max(0, e.mass - 0.5); }
    if (e.hp <= 0) killEnemy(e);
    else { burst(bx, by, e.col, 6, 260, 0.35); Sound.hit(); }
  }

  function updateEnemy(e, dt) {
    e.t += dt;
    if (e.hitFlash > 0) e.hitFlash -= dt;
    if (e.spawnT > 0) { e.spawnT -= dt; if (e.type !== 'boss') return; }
    const tx = P.alive ? P.x : ARENA_W / 2, ty = P.alive ? P.y : ARENA_H / 2;
    const ddx = tx - e.x, ddy = ty - e.y, dd = Math.hypot(ddx, ddy) || 1;
    const speedUp = 1 + Math.min(0.6, G.wave * 0.03);
    switch (e.type) {
      case 'wanderer': {
        e.dir += Math.sin(e.t * 1.3 + e.seed) * dt * 2.2;
        e.vx = lerp(e.vx, Math.cos(e.dir) * 120, dt * 3); e.vy = lerp(e.vy, Math.sin(e.dir) * 120, dt * 3);
        e.ang += dt * 4;
        break;
      }
      case 'seeker': case 'spark': case 'mini': {
        const acc = e.type === 'spark' ? 900 : e.type === 'mini' ? 700 : 620;
        const max = (e.type === 'spark' ? 380 : e.type === 'mini' ? 280 : 250) * speedUp;
        e.vx += (ddx / dd) * acc * dt; e.vy += (ddy / dd) * acc * dt;
        const s = Math.hypot(e.vx, e.vy);
        if (s > max) { e.vx *= max / s; e.vy *= max / s; }
        e.ang = e.type === 'mini' ? e.ang + dt * 6 : Math.atan2(e.vy, e.vx);
        break;
      }
      case 'square': {
        let ax = (ddx / dd) * 500, ay = (ddy / dd) * 500;
        for (const b of bullets) { // уклонение от пуль
          const bx = e.x - b.x, by = e.y - b.y;
          const d2 = bx * bx + by * by;
          if (d2 < 120 * 120 && bx * b.vx + by * b.vy > 0) {
            const bs = Math.hypot(b.vx, b.vy);
            const side = Math.sign(bx * -b.vy + by * b.vx) || 1;
            ax += (-b.vy / bs) * side * 1600; ay += (b.vx / bs) * side * 1600;
            break;
          }
        }
        e.vx += ax * dt; e.vy += ay * dt;
        const max = 190 * speedUp, s = Math.hypot(e.vx, e.vy);
        if (s > max) { e.vx *= max / s; e.vy *= max / s; }
        e.ang += dt * 2;
        break;
      }
      case 'dart': {
        e.st -= dt;
        if (e.state === 'aim') {
          e.vx *= 0.9; e.vy *= 0.9;
          e.ang = Math.atan2(ddy, ddx);
          e.tx = tx; e.ty = ty;
          if (e.st <= 0) {
            e.state = 'dash'; e.st = 0.5;
            e.vx = Math.cos(e.ang) * 950 * speedUp; e.vy = Math.sin(e.ang) * 950 * speedUp;
            burst(e.x, e.y, ORANGE, 10, 200, 0.4);
          }
        } else if (e.state === 'dash') {
          if (Math.random() < 0.7) spawnP(e.x, e.y, -e.vx * 0.2 + rand(-40, 40), -e.vy * 0.2 + rand(-40, 40), 0.4, ORANGE, 1);
          if (e.st <= 0) { e.state = 'rest'; e.st = 0.5; }
        } else {
          e.vx *= 0.92; e.vy *= 0.92;
          if (e.st <= 0) { e.state = 'aim'; e.st = Math.max(0.45, 0.9 - G.wave * 0.03); }
        }
        break;
      }
      case 'hole': {
        e.vx *= 0.95; e.vy *= 0.95;
        e.ang += dt * 1.5;
        Grid.force(e.x, e.y, 260 + e.mass * 8, -0.35 * dt * 60);
        if (Math.random() < 0.5) {
          const a = rand(0, TAU), d = rand(150, 320);
          spawnP(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, 0, 0, 1.2, pick([RED, ORANGE, MAGENTA]), 1.2, 0.97);
        }
        // притяжение врагов и игрока
        const R = 400;
        for (const o of enemies) {
          if (o === e || o.dead || o.type === 'hole' || o.type === 'boss' || o.spawnT > 0) continue;
          const ex = e.x - o.x, ey = e.y - o.y, d = Math.hypot(ex, ey);
          if (d < R) {
            const f = 900 * (1 - d / R) * dt;
            o.vx += (ex / d) * f; o.vy += (ey / d) * f;
            if (d < e.r + o.r * 0.4) {
              o.dead = true; e.mass++; e.hp += 2; e.r = Math.min(44, e.r + 1.2);
              burst(o.x, o.y, o.col, 16, 160, 0.6);
              Grid.force(e.x, e.y, 200, -6);
              if (e.mass >= 10) { // перегрузка
                e.dead = true;
                explode(e.x, e.y, RED, 3);
                for (let i = 0; i < 12; i++) {
                  const a = (i / 12) * TAU;
                  spawnEnemy('spark', e.x + Math.cos(a) * 30, e.y + Math.sin(a) * 30, { instant: true, vx: Math.cos(a) * 500, vy: Math.sin(a) * 500 });
                }
                break;
              }
            }
          }
        }
        if (P.alive && P.dashT <= 0) {
          const ex = e.x - P.x, ey = e.y - P.y, d = Math.hypot(ex, ey);
          if (d < R && d > 1) { const f = 520 * (1 - d / R) * dt; P.vx += (ex / d) * f; P.vy += (ey / d) * f; }
        }
        break;
      }
      case 'snake': {
        const want = Math.atan2(ddy, ddx) + Math.sin(e.t * 2.6) * 0.9;
        let da = want - e.heading;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        e.heading += clamp(da, -2.4 * dt, 2.4 * dt);
        const sp = 230 * speedUp;
        e.vx = Math.cos(e.heading) * sp; e.vy = Math.sin(e.heading) * sp;
        e.ang = e.heading;
        let prev = e;
        for (const s of e.segs) {
          const sx = s.x - prev.x, sy = s.y - prev.y, d = Math.hypot(sx, sy) || 1;
          if (d > 20) { s.x = prev.x + (sx / d) * 20; s.y = prev.y + (sy / d) * 20; }
          prev = s;
        }
        break;
      }
      case 'boss': updateBoss(e, dt, tx, ty); break;
    }
    if (e.type === 'boss') return;
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx); if (e.dir !== undefined) e.dir = Math.PI - e.dir; if (e.type === 'snake') e.heading = Math.PI - e.heading; }
    if (e.x > ARENA_W - e.r) { e.x = ARENA_W - e.r; e.vx = -Math.abs(e.vx); if (e.dir !== undefined) e.dir = Math.PI - e.dir; if (e.type === 'snake') e.heading = Math.PI - e.heading; }
    if (e.y < e.r) { e.y = e.r; e.vy = Math.abs(e.vy); if (e.dir !== undefined) e.dir = -e.dir; if (e.type === 'snake') e.heading = -e.heading; }
    if (e.y > ARENA_H - e.r) { e.y = ARENA_H - e.r; e.vy = -Math.abs(e.vy); if (e.dir !== undefined) e.dir = -e.dir; if (e.type === 'snake') e.heading = -e.heading; }
  }

  // ───────────────────────── босс «Квазар» ─────────────────────────
  const BOSS_ATTACKS = ['spiral', 'burst', 'ring', 'summon', 'spiral', 'charge', 'ring', 'burst'];
  function fireE(x, y, ang, sp, col = PINK) {
    ebullets.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 8, life: 7, col });
  }
  function updateBoss(e, dt, tx, ty) {
    const rage = 1 - e.hp / e.maxHp;
    e.rot += dt * (0.7 + rage * 1.1);
    Grid.force(e.x, e.y, 320, -0.25 * dt * 60);
    if (Math.random() < 0.6) {
      const a = rand(0, TAU);
      spawnP(e.x + Math.cos(a) * 30, e.y + Math.sin(a) * 30, Math.cos(a) * 260, Math.sin(a) * 260, 0.6, pick([MAGENTA, PINK, PURPLE]), 1.5);
    }
    if (e.dying > 0) {
      e.dying -= dt;
      if (Math.random() < 0.35) {
        const a = rand(0, TAU), d = rand(0, 130);
        explode(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, pick([MAGENTA, WHITE, PINK, CYAN]), rand(0.8, 1.8));
      }
      if (e.dying <= 0) {
        e.dead = true;
        G.kills++;
        G.score += e.score * G.mult;
        floatText(e.x, e.y - 40, '+' + (e.score * G.mult).toLocaleString('ru-RU'), MAGENTA, 2.5, 40);
        burst(e.x, e.y, MAGENTA, 400, 1300, 1.8, 2);
        burst(e.x, e.y, WHITE, 250, 900, 1.4, 1.5);
        burst(e.x, e.y, CYAN, 200, 1600, 1.6, 2);
        for (let i = 0; i < 3; i++) addRing(e.x, e.y, 600 + i * 300, [MAGENTA, CYAN, WHITE][i], 0.8 + i * 0.3, 8);
        Grid.force(e.x, e.y, 900, 40);
        for (let i = 0; i < e.gems; i++) gems.push({ x: e.x, y: e.y, vx: rand(-500, 500), vy: rand(-500, 500), life: 12, ang: 0 });
        spawnPickup(e.x + 80, e.y);
        flash(1, WHITE); shake(1.2); G.hitstop = 0.15; G.timeScale = 0.25;
        Sound.bomb(); Sound.oneUp();
        G.lives++; G.bombs++;
        announce('КВАЗАР УНИЧТОЖЕН', '+1 жизнь  ·  +1 бомба', MAGENTA);
        ebullets.length = 0;
        checkThresholds();
      }
      return;
    }
    if (e.spawnT > 0) return;
    // дрейф по эллипсу вокруг центра арены, слегка к игроку
    const hx = ARENA_W / 2 + Math.cos(e.t * 0.25) * 520 + (tx - ARENA_W / 2) * 0.2;
    const hy = ARENA_H / 2 + Math.sin(e.t * 0.37) * 300 + (ty - ARENA_H / 2) * 0.2;
    if (e.atk === 'charge') {
      e.x += e.vx * dt; e.y += e.vy * dt;
      e.vx *= Math.pow(0.985, dt * 60); e.vy *= Math.pow(0.985, dt * 60);
      if (Math.random() < 0.8) burst(e.x, e.y, MAGENTA, 2, 200, 0.5, 1.5);
      if (e.x < e.segR || e.x > ARENA_W - e.segR) { e.vx *= -1; e.x = clamp(e.x, e.segR, ARENA_W - e.segR); Grid.force(e.x, e.y, 300, 12); shake(0.4); }
      if (e.y < e.segR || e.y > ARENA_H - e.segR) { e.vy *= -1; e.y = clamp(e.y, e.segR, ARENA_H - e.segR); Grid.force(e.x, e.y, 300, 12); shake(0.4); }
    } else {
      e.x = lerp(e.x, hx, dt * 0.6); e.y = lerp(e.y, hy, dt * 0.6);
    }
    // регенерация щита в ярости
    if (rage > 0.5) for (let i = 0; i < e.segN; i++) if (e.segs[i] < 8 && Math.random() < dt * 0.25) e.segs[i]++;
    const aim = Math.atan2(ty - e.y, tx - e.x);
    e.atkT -= dt; e.shotT -= dt;
    const fast = 1 + rage * 0.8;
    switch (e.atk) {
      case 'spiral':
        if (e.shotT <= 0) {
          e.shotT = 0.11 / fast;
          const arms = rage > 0.5 ? 4 : 3;
          for (let k = 0; k < arms; k++) fireE(e.x, e.y, e.rot * 1.7 + (k * TAU) / arms, 240 + rage * 60);
          Sound.enemyShot();
        }
        break;
      case 'burst':
        if (e.shotT <= 0 && e.volleys > 0) {
          e.volleys--; e.shotT = 0.45 / fast;
          const n = rage > 0.5 ? 9 : 7;
          for (let k = 0; k < n; k++) fireE(e.x, e.y, aim + (k - (n - 1) / 2) * 0.13, 380, ORANGE);
          Grid.force(e.x, e.y, 200, 5); Sound.enemyShot();
        }
        break;
      case 'ring':
        if (e.shotT <= 0 && e.volleys > 0) {
          e.volleys--; e.shotT = 0.6 / fast;
          const n = 30;
          const off = e.volleys % 2 ? 0 : Math.PI / n;
          for (let k = 0; k < n; k++) fireE(e.x, e.y, (k * TAU) / n + off, 200, PURPLE);
          addRing(e.x, e.y, 200, PURPLE, 0.4, 5); Grid.force(e.x, e.y, 300, 8); Sound.enemyShot();
        }
        break;
    }
    if (e.atkT <= 0) {
      e.atk = BOSS_ATTACKS[e.atkIdx++ % BOSS_ATTACKS.length];
      e.shotT = 0.3;
      switch (e.atk) {
        case 'spiral': e.atkT = 3.4; break;
        case 'burst': e.atkT = 2.4; e.volleys = rage > 0.5 ? 5 : 3; break;
        case 'ring': e.atkT = 2.6; e.volleys = rage > 0.5 ? 4 : 3; break;
        case 'summon':
          e.atkT = 1.6;
          for (let k = 0; k < 6 + Math.floor(rage * 6); k++) {
            const a = (k / 6) * TAU;
            spawnEnemy(k % 3 === 2 ? 'dart' : 'seeker', e.x + Math.cos(a) * 190, e.y + Math.sin(a) * 190);
          }
          addRing(e.x, e.y, 260, MAGENTA, 0.6, 6);
          break;
        case 'charge':
          e.atkT = 2.2;
          e.vx = Math.cos(aim) * 900; e.vy = Math.sin(aim) * 900;
          addRing(e.x, e.y, 180, WHITE, 0.4, 5); Sound.bossRoar();
          break;
      }
      e.atkT += 0.6; // небольшая передышка между атаками
    }
  }

  // ───────────────────────── игрок ─────────────────────────
  const POWERS = {
    spread: { name: 'ВЕЕР', col: MAGENTA, letter: 'В' },
    rapid: { name: 'ШКВАЛ', col: YELLOW, letter: 'Ш' },
    pierce: { name: 'ПРОБОЙ', col: CYAN, letter: 'П' },
  };
  function spawnPickup(x, y) {
    const type = pick(Object.keys(POWERS));
    pickups.push({ x: clamp(x, 80, ARENA_W - 80), y: clamp(y, 80, ARENA_H - 80), type, life: 12, t: 0 });
  }
  function tryDash() {
    if (!P.alive || P.dashCD > 0) return;
    let ix = 0, iy = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) iy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) iy += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    ix += pad.mx; iy += pad.my;
    let m = Math.hypot(ix, iy);
    if (m < 0.1) { ix = Math.cos(P.ang); iy = Math.sin(P.ang); m = 1; }
    P.dashX = ix / m; P.dashY = iy / m;
    P.dashT = 0.2; P.dashCD = 1.1; P.inv = Math.max(P.inv, 0.28);
    addRing(P.x, P.y, 60, CYAN, 0.3, 3);
    Grid.force(P.x, P.y, 120, 4);
    Sound.dash();
  }
  function useBomb() {
    if (!P.alive || G.bombs <= 0) return;
    G.bombs--;
    rings.push({ x: P.x, y: P.y, r: 0, maxR: 1500, col: WHITE, life: 0.9, max: 0.9, w: 14, bomb: true });
    addRing(P.x, P.y, 1100, CYAN, 1.1, 8);
    addRing(P.x, P.y, 800, MAGENTA, 0.8, 6);
    burst(P.x, P.y, WHITE, 300, 1500, 1.1, 2);
    burst(P.x, P.y, CYAN, 200, 1100, 1.3, 2);
    Grid.force(P.x, P.y, 900, 30);
    ebullets.length = 0;
    flash(0.7, CYAN); shake(0.9); Sound.bomb();
    P.inv = Math.max(P.inv, 1);
  }
  function killPlayer() {
    if (!P.alive || P.inv > 0 || G.god) return;
    P.alive = false;
    G.lives--; G.mult = 1;
    burst(P.x, P.y, CYAN, 260, 1100, 1.6, 2);
    burst(P.x, P.y, WHITE, 160, 700, 1.4, 1.5);
    burst(P.x, P.y, MAGENTA, 120, 900, 1.2, 1.5);
    addRing(P.x, P.y, 700, CYAN, 1, 8);
    addRing(P.x, P.y, 400, WHITE, 0.7, 5);
    Grid.force(P.x, P.y, 650, 26);
    shake(1.2); flash(0.8, RED); G.timeScale = 0.12; G.hitstop = 0.12;
    Sound.death();
    for (const e of enemies) {
      if (e.type === 'boss' || e.dead) continue;
      e.dead = true;
      burst(e.x, e.y, e.col, 20, 400, 0.8);
    }
    ebullets.length = 0;
    G.respawnT = 2.4;
  }
  function respawn() {
    P.alive = true; P.inv = 2.5; P.vx = P.vy = 0; P.power = null; P.powerT = 0; P.dashCD = 0;
    const boss = enemies.find((e) => e.type === 'boss');
    if (boss) { P.x = boss.x < ARENA_W / 2 ? ARENA_W - 300 : 300; P.y = ARENA_H / 2; }
    else { P.x = ARENA_W / 2; P.y = ARENA_H / 2; }
    addRing(P.x, P.y, 200, CYAN, 0.8, 5);
    Grid.force(P.x, P.y, 300, -10);
  }
  function aimInput() {
    if (G.usePad && Math.hypot(pad.ax, pad.ay) > 0.3) return { ang: Math.atan2(pad.ay, pad.ax), fire: true };
    if (G.usePad) return { ang: P.ang, fire: false };
    const wx = cam.x + (mouse.x - W / 2) / zoom, wy = cam.y + (mouse.y - H / 2) / zoom;
    return { ang: Math.atan2(wy - P.y, wx - P.x), fire: mouse.down || G.autofire };
  }
  function updatePlayer(dt) {
    if (!P.alive) return;
    P.inv -= dt; P.dashCD -= dt;
    let ix = 0, iy = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) iy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) iy += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    ix += pad.mx; iy += pad.my;
    const m = Math.hypot(ix, iy);
    if (m > 1) { ix /= m; iy /= m; }
    const SPEED = 430;
    if (P.dashT > 0) {
      P.dashT -= dt;
      P.vx = P.dashX * 1350; P.vy = P.dashY * 1350;
      P.ghostT -= dt;
      if (P.ghostT <= 0) { P.ghostT = 0.025; ghosts.push({ x: P.x, y: P.y, ang: P.ang, life: 0.3 }); }
    } else {
      const k = Math.min(1, dt * 11);
      P.vx += (ix * SPEED - P.vx) * k; P.vy += (iy * SPEED - P.vy) * k;
    }
    P.x += P.vx * dt; P.y += P.vy * dt;
    P.x = clamp(P.x, P.r, ARENA_W - P.r); P.y = clamp(P.y, P.r, ARENA_H - P.r);
    const a = aimInput();
    P.ang = a.ang;
    // выхлоп
    const sp = Math.hypot(P.vx, P.vy);
    if (sp > 60) {
      const bx = -P.vx / sp, by = -P.vy / sp;
      for (let i = 0; i < 2; i++) {
        spawnP(P.x + bx * 12, P.y + by * 12, bx * rand(150, 320) + rand(-50, 50), by * rand(150, 320) + rand(-50, 50),
          rand(0.15, 0.35), Math.random() < 0.5 ? ORANGE : YELLOW, 1, 0.9);
      }
      if (Math.random() < 0.3) Grid.force(P.x, P.y, 60, 0.6);
    }
    // стрельба
    P.fireCD -= dt;
    if (P.power) { P.powerT -= dt; if (P.powerT <= 0) P.power = null; }
    if (a.fire && P.fireCD <= 0) {
      const rate = P.power === 'rapid' ? 20 : 10;
      P.fireCD = 1 / rate;
      const ca = Math.cos(P.ang), sa = Math.sin(P.ang);
      const shots = [];
      if (P.power === 'spread') for (let k = -2; k <= 2; k++) shots.push([P.ang + k * 0.12, 0]);
      else shots.push([P.ang + rand(-0.025, 0.025), -6], [P.ang + rand(-0.025, 0.025), 6]);
      const pierce = P.power === 'pierce';
      for (const [ang, off] of shots) {
        const spd = 1200;
        bullets.push({ x: P.x + ca * 16 - sa * off, y: P.y + sa * 16 + ca * off, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
          life: 1.1, r: pierce ? 7 : 5, pierce: pierce ? 4 : 1, last: null, col: pierce ? CYAN : P.power === 'spread' ? MAGENTA : P.power === 'rapid' ? YELLOW : WHITE });
      }
      spawnP(P.x + ca * 18, P.y + sa * 18, ca * 300, sa * 300, 0.1, YELLOW, 1);
      Sound.shoot();
    }
  }

  // ───────────────────────── снаряды и столкновения ─────────────────────────
  function updateBullets(dt) {
    const holes = enemies.filter((e) => e.type === 'hole' && e.spawnT <= 0 && !e.dead);
    for (const b of bullets) {
      for (const h of holes) {
        const ex = h.x - b.x, ey = h.y - b.y, d = Math.hypot(ex, ey);
        if (d < 300) { const f = 2600 * (1 - d / 300) * dt; b.vx += (ex / d) * f; b.vy += (ey / d) * f; }
      }
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
        b.life = 0;
        const x = clamp(b.x, 0, ARENA_W), y = clamp(b.y, 0, ARENA_H);
        burst(x, y, b.col === WHITE ? BLUE : b.col, 5, 220, 0.3);
        Grid.force(x, y, 70, 1.5);
        continue;
      }
      for (const e of enemies) {
        if (e.dead || e.spawnT > 0 || b.life <= 0 || e === b.last) continue;
        if (e.type === 'boss') { if (bossHit(e, b)) break; continue; }
        if (e.type === 'snake') {
          let blocked = false;
          for (const s of e.segs) {
            if ((s.x - b.x) ** 2 + (s.y - b.y) ** 2 < 14 * 14) { blocked = true; break; }
          }
          if (blocked) { b.life = 0; burst(b.x, b.y, YELLOW, 4, 200, 0.25); break; }
        }
        const rr = e.r + b.r;
        if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < rr * rr) {
          damageEnemy(e, 1, b.x, b.y);
          b.pierce--; b.last = e;
          if (b.pierce <= 0) { b.life = 0; break; }
        }
      }
    }
    bullets = bullets.filter((b) => b.life > 0);
    for (const b of ebullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.x < -20 || b.x > ARENA_W + 20 || b.y < -20 || b.y > ARENA_H + 20) b.life = 0;
      if (P.alive && (P.x - b.x) ** 2 + (P.y - b.y) ** 2 < (P.r * 0.7 + b.r) ** 2) {
        if (P.inv <= 0) { b.life = 0; killPlayer(); }
      }
    }
    ebullets = ebullets.filter((b) => b.life > 0);
  }
  function bossHit(e, b) {
    if (e.dying > 0) return false;
    const ex = b.x - e.x, ey = b.y - e.y, d = Math.hypot(ex, ey);
    if (d > e.segR - 14 && d < e.segR + 14) {
      let a = Math.atan2(ey, ex) - e.rot;
      a = ((a % TAU) + TAU) % TAU;
      const i = Math.floor((a / TAU) * e.segN);
      if (e.segs[i] > 0) {
        e.segs[i]--;
        b.life = 0;
        burst(b.x, b.y, e.segs[i] > 0 ? PINK : WHITE, e.segs[i] > 0 ? 5 : 30, e.segs[i] > 0 ? 220 : 500, 0.4);
        if (e.segs[i] === 0) { Grid.force(b.x, b.y, 120, 5); Sound.boom(0.7); G.score += 50 * G.mult; }
        else Sound.hit();
        return true;
      }
    }
    if (d < e.r + b.r) {
      e.hp -= 1; e.hitFlash = 0.06; b.life = 0;
      burst(b.x, b.y, MAGENTA, 8, 300, 0.4);
      Grid.force(e.x, e.y, 160, 1.5);
      Sound.hit();
      if (e.hp <= 0 && e.dying <= 0) {
        e.dying = 2.2; G.timeScale = 0.4; shake(0.6); Sound.bossRoar();
        ebullets.length = 0;
      }
      return true;
    }
    return false;
  }
  function collidePlayer() {
    if (!P.alive || P.inv > 0) return;
    for (const e of enemies) {
      if (e.dead || e.spawnT > 0) continue;
      if (e.type === 'boss') {
        if (e.dying > 0) continue;
        const d = Math.hypot(P.x - e.x, P.y - e.y);
        if (d < e.r + P.r * 0.6) return killPlayer();
        if (Math.abs(d - e.segR) < 12 + P.r * 0.6) {
          let a = Math.atan2(P.y - e.y, P.x - e.x) - e.rot;
          a = ((a % TAU) + TAU) % TAU;
          if (e.segs[Math.floor((a / TAU) * e.segN)] > 0) return killPlayer();
        }
        continue;
      }
      const rr = e.r * 0.8 + P.r * 0.7;
      if ((e.x - P.x) ** 2 + (e.y - P.y) ** 2 < rr * rr) return killPlayer();
      if (e.type === 'snake') {
        for (const s of e.segs) if ((s.x - P.x) ** 2 + (s.y - P.y) ** 2 < 15 * 15) return killPlayer();
      }
    }
  }
  function updatePickups(dt) {
    for (const g of gems) {
      g.life -= dt; g.ang += dt * 3;
      if (P.alive) {
        const ex = P.x - g.x, ey = P.y - g.y, d = Math.hypot(ex, ey) || 1;
        if (d < 190) { const f = 2600 * dt * (1 - d / 220); g.vx += (ex / d) * f; g.vy += (ey / d) * f; }
        if (d < 24) {
          g.life = 0; G.mult++; G.maxMult = Math.max(G.maxMult, G.mult);
          spawnP(g.x, g.y, rand(-60, 60), rand(-60, 60), 0.3, GREEN, 1);
          Sound.pickup(G.mult);
        }
      }
      g.vx *= Math.pow(0.95, dt * 60); g.vy *= Math.pow(0.95, dt * 60);
      g.x = clamp(g.x + g.vx * dt, 5, ARENA_W - 5); g.y = clamp(g.y + g.vy * dt, 5, ARENA_H - 5);
    }
    gems = gems.filter((g) => g.life > 0);
    for (const p of pickups) {
      p.life -= dt; p.t += dt;
      if (P.alive && Math.hypot(P.x - p.x, P.y - p.y) < 34) {
        p.life = 0; P.power = p.type; P.powerT = 12;
        const pw = POWERS[p.type];
        burst(p.x, p.y, pw.col, 60, 500, 0.8);
        addRing(p.x, p.y, 140, pw.col, 0.5, 4);
        floatText(P.x, P.y - 46, pw.name + '!', pw.col, 1.4, 26);
        Sound.power();
      }
    }
    pickups = pickups.filter((p) => p.life > 0);
    G.puTimer -= dt;
    if (G.puTimer <= 0 && P.alive) {
      G.puTimer = rand(18, 26);
      const p = spawnPos(250); spawnPickup(p.x, p.y);
    }
  }
  function updateEffects(dt) {
    for (const r of rings) {
      r.life -= dt;
      const k = 1 - r.life / r.max;
      r.r = r.maxR * (1 - Math.pow(1 - k, 3));
      if (r.bomb) {
        for (const e of enemies) {
          if (e.dead || e.type === 'boss') continue;
          if (Math.hypot(e.x - r.x, e.y - r.y) < r.r) killEnemy(e, true);
        }
      }
    }
    rings = rings.filter((r) => r.life > 0);
    for (const t of texts) { t.life -= dt; t.y -= 40 * dt; }
    texts = texts.filter((t) => t.life > 0);
    for (const g of ghosts) g.life -= dt;
    ghosts = ghosts.filter((g) => g.life > 0);
  }

  // ───────────────────────── режиссёр волн ─────────────────────────
  const WAVE_NAMES = ['', 'Пробуждение', 'Рой', 'Гравитация', 'Змеи', 'Давление', '', 'Шторм', 'Горизонт событий', 'Хаос', 'Сверхновая', 'Бездна'];
  function nextWave() {
    G.wave++;
    G.waveTime = 0; G.spawnTimer = 1.6;
    G.isBoss = G.wave % 6 === 0;
    G.bossSpawned = false; G.bossTimer = 2;
    if (G.isBoss) { announce('ВНИМАНИЕ', 'приближается Квазар', MAGENTA); Sound.bossRoar(); }
    else announce('ВОЛНА ' + G.wave, WAVE_NAMES[G.wave] || 'Бесконечность', CYAN);
    Sound.setIntensity(G.isBoss ? 3 : Math.min(3, Math.floor((G.wave + 1) / 2)));
  }
  function director(dt) {
    G.waveTime += dt;
    if (G.isBoss) {
      if (!G.bossSpawned) {
        G.bossTimer -= dt;
        if (G.bossTimer <= 0) {
          G.bossSpawned = true;
          const x = P.x < ARENA_W / 2 ? ARENA_W * 0.72 : ARENA_W * 0.28;
          spawnEnemy('boss', x, ARENA_H / 2);
          addRing(x, ARENA_H / 2, 500, MAGENTA, 1.4, 10);
          Grid.force(x, ARENA_H / 2, 600, -20);
          shake(0.8);
        }
      } else if (!enemies.some((e) => e.type === 'boss')) {
        if (G.waveTime > 3) nextWave();
      } else {
        G.spawnTimer -= dt;
        if (G.spawnTimer <= 0) { G.spawnTimer = 5; for (let i = 0; i < 3; i++) { const p = spawnPos(); spawnEnemy('wanderer', p.x, p.y); } }
      }
      return;
    }
    G.spawnTimer -= dt;
    if (G.spawnTimer <= 0 && enemies.length < 200 && P.alive) {
      G.spawnTimer = Math.max(0.9, 3.0 - G.wave * 0.17) * rand(0.75, 1.2);
      spawnPattern();
    }
    const dur = 24 + Math.min(10, G.wave);
    if (G.waveTime > dur || (G.waveTime > 10 && enemies.length === 0)) nextWave();
  }
  function spawnPattern() {
    const w = G.wave;
    const holeCount = enemies.filter((e) => e.type === 'hole').length;
    const opts = [['drizzle', 3]];
    if (w >= 1) opts.push(['corners', 1.5]);
    if (w >= 2) opts.push(['ring', 1.2], ['squares', 1.2]);
    if (w >= 3) opts.push(['darts', 1.3]);
    if (w >= 3 && holeCount < (w >= 8 ? 3 : w >= 5 ? 2 : 1)) opts.push(['hole', 0.9]);
    if (w >= 4) opts.push(['snake', 0.8]);
    if (w >= 5) opts.push(['wall', 1]);
    let tot = 0; for (const o of opts) tot += o[1];
    let r = Math.random() * tot, choice = opts[0][0];
    for (const o of opts) { r -= o[1]; if (r <= 0) { choice = o[0]; break; } }
    const basic = w >= 2 ? ['wanderer', 'seeker', 'seeker', 'square'] : ['wanderer', 'seeker'];
    if (w >= 3) basic.push('dart');
    switch (choice) {
      case 'drizzle': {
        const n = 3 + Math.floor(w * 0.8);
        for (let i = 0; i < n; i++) { const p = spawnPos(); spawnEnemy(pick(basic), p.x, p.y); }
        break;
      }
      case 'corners': {
        const n = 3 + Math.floor(w / 2);
        const type = w >= 3 && Math.random() < 0.5 ? 'square' : pick(['wanderer', 'seeker']);
        for (const [cx, cy] of [[90, 90], [ARENA_W - 90, 90], [90, ARENA_H - 90], [ARENA_W - 90, ARENA_H - 90]]) {
          if (P.alive && Math.hypot(cx - P.x, cy - P.y) < 400) continue;
          for (let i = 0; i < n; i++) spawnEnemy(type, cx + rand(-50, 50), cy + rand(-50, 50));
        }
        break;
      }
      case 'ring': {
        const n = 8 + w;
        const R = 460;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          spawnEnemy('seeker', P.x + Math.cos(a) * R, P.y + Math.sin(a) * R);
        }
        break;
      }
      case 'squares': {
        const n = 2 + Math.floor(w / 2);
        for (let i = 0; i < n; i++) { const p = spawnPos(); spawnEnemy('square', p.x, p.y); }
        break;
      }
      case 'darts': {
        const n = 3 + Math.floor(w / 2);
        const side = randi(0, 3);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const x = side === 0 ? 80 : side === 1 ? ARENA_W - 80 : t * ARENA_W;
          const y = side === 2 ? 80 : side === 3 ? ARENA_H - 80 : t * ARENA_H;
          spawnEnemy('dart', x, y);
        }
        break;
      }
      case 'hole': { const p = spawnPos(450); spawnEnemy('hole', p.x, p.y); break; }
      case 'snake': { const p = spawnPos(500); spawnEnemy('snake', p.x, p.y); break; }
      case 'wall': {
        const vertical = Math.random() < 0.5;
        const n = vertical ? 14 : 20;
        const far = vertical ? (P.x < ARENA_W / 2 ? ARENA_W - 100 : 100) : (P.y < ARENA_H / 2 ? ARENA_H - 100 : 100);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          if (vertical) spawnEnemy('wanderer', far, t * ARENA_H); else spawnEnemy('wanderer', t * ARENA_W, far);
        }
        break;
      }
    }
  }

  // ───────────────────────── поток игры ─────────────────────────
  const $ = (id) => document.getElementById(id);
  function showOverlay(id) { ['title', 'pause', 'over'].forEach((o) => $(o).classList.toggle('show', o === id)); }
  function updateBestLabels() { $('bestTitle').textContent = G.best ? 'РЕКОРД: ' + G.best.toLocaleString('ru-RU') : ''; }
  updateBestLabels();
  function startGame() {
    Sound.init(); Sound.startMusic(); Sound.setIntensity(0);
    Object.assign(G, { state: 'play', paused: false, score: 0, mult: 1, lives: 3, bombs: 3, wave: 0, timeScale: 1, hitstop: 0,
      nextLife: 75000, nextBomb: 50000, puTimer: 15, kills: 0, maxMult: 1, respawnT: 0 });
    enemies = []; bullets = []; ebullets = []; gems = []; pickups = []; rings = []; texts = []; ghosts = [];
    Object.assign(P, { x: ARENA_W / 2, y: ARENA_H / 2, vx: 0, vy: 0, alive: true, inv: 2, dashCD: 0, dashT: 0, power: null, powerT: 0 });
    cam.x = P.x; cam.y = P.y;
    Grid.force(P.x, P.y, 500, 18);
    burst(P.x, P.y, CYAN, 150, 800, 1.2, 1.5);
    document.body.classList.add('playing');
    showOverlay(null);
    nextWave();
  }
  function gameOver() {
    G.state = 'over';
    Sound.setIntensity(0);
    document.body.classList.remove('playing');
    const record = G.score > G.best;
    if (record) { G.best = G.score; try { localStorage.setItem('pulsar.best', String(G.best)); } catch (e) { /* ок */ } }
    $('finalScore').textContent = G.score.toLocaleString('ru-RU') + (record ? '  ★ НОВЫЙ РЕКОРД' : '');
    $('finalInfo').textContent = `волна ${G.wave} · убито ${G.kills} · макс. множитель x${G.maxMult}`;
    updateBestLabels();
    showOverlay('over');
  }
  function togglePause() {
    if (G.state !== 'play') return;
    G.paused = !G.paused;
    showOverlay(G.paused ? 'pause' : null);
    document.body.classList.toggle('playing', !G.paused);
  }
  $('play').addEventListener('click', startGame);
  $('again').addEventListener('click', startGame);
  $('pause').addEventListener('click', togglePause);

  function update(dt) {
    G.t += dt;
    updatePlayer(dt);
    for (const e of enemies) if (!e.dead) updateEnemy(e, dt);
    updateBullets(dt);
    collidePlayer();
    enemies = enemies.filter((e) => !e.dead);
    updatePickups(dt);
    updateEffects(dt);
    if (!P.alive) {
      G.respawnT -= dt / Math.max(G.timeScale, 0.3);
      if (G.respawnT <= 0) { if (G.lives <= 0) gameOver(); else respawn(); }
    } else director(dt);
  }
  let attractT = 0;
  function updateAttract(dt) {
    attractT -= dt; G.t += dt;
    if (attractT <= 0) {
      attractT = rand(0.35, 0.9);
      const x = rand(300, ARENA_W - 300), y = rand(250, ARENA_H - 250);
      const col = pick([CYAN, MAGENTA, GREEN, ORANGE, PURPLE, YELLOW]);
      burst(x, y, col, 70, 650, 1.3, 1.4);
      burst(x, y, WHITE, 20, 400, 0.6);
      addRing(x, y, 120, col, 0.5, 3);
      Grid.force(x, y, 260, 9);
    }
    cam.x = ARENA_W / 2 + Math.cos(G.t * 0.11) * 500;
    cam.y = ARENA_H / 2 + Math.sin(G.t * 0.17) * 260;
    updateEffects(dt);
    for (const e of enemies) if (!e.dead) updateEnemy(e, dt);
  }
  function updateCamera(dt) {
    if (G.state !== 'play') return;
    const a = P.ang;
    const tx = P.x + Math.cos(a) * 70, ty = P.y + Math.sin(a) * 70;
    const k = Math.min(1, dt * 5);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    const vw = W / zoom / 2, vh = H / zoom / 2;
    const m = 120;
    cam.x = vw * 2 > ARENA_W + m * 2 ? ARENA_W / 2 : clamp(cam.x, vw - m, ARENA_W - vw + m);
    cam.y = vh * 2 > ARENA_H + m * 2 ? ARENA_H / 2 : clamp(cam.y, vh - m, ARENA_H - vh + m);
  }

  // ───────────────────────── отрисовка ─────────────────────────
  function poly(c, pts) { c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); }
  function drawShip(c, x, y, ang, alpha, col = WHITE) {
    c.save(); c.translate(x, y); c.rotate(ang); c.globalAlpha = alpha;
    c.lineJoin = 'round';
    c.strokeStyle = C[col]; c.lineWidth = 3;
    poly(c, [20, 0, -12, 13, -6, 0, -12, -13]); c.stroke();
    c.strokeStyle = C[CYAN]; c.lineWidth = 2;
    poly(c, [10, 0, -4, 6, -1, 0, -4, -6]); c.stroke();
    c.restore();
  }
  function drawEnemy(c, e) {
    const spawning = e.spawnT > 0 && e.type !== 'boss';
    if (e.type === 'boss') return drawBoss(c, e);
    if (e.type === 'dart' && e.state === 'aim' && !spawning) {
      c.save();
      c.globalAlpha = 0.25 + 0.35 * (1 - clamp(e.st, 0, 1));
      c.setLineDash([10, 12]); c.lineDashOffset = -G.t * 80;
      c.strokeStyle = C[ORANGE]; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(e.x, e.y); c.lineTo(e.x + Math.cos(e.ang) * 500, e.y + Math.sin(e.ang) * 500); c.stroke();
      c.restore();
    }
    if (e.type === 'snake') {
      c.strokeStyle = CA(YELLOW, spawning ? 0.3 : 0.9); c.lineWidth = 2.5;
      for (let i = e.segs.length - 1; i >= 0; i--) {
        const s = e.segs[i];
        const r = 11 - i * 0.4;
        c.beginPath(); c.moveTo(s.x + r, s.y); c.lineTo(s.x, s.y + r); c.lineTo(s.x - r, s.y); c.lineTo(s.x, s.y - r); c.closePath(); c.stroke();
      }
    }
    if (e.type === 'hole' && !spawning) {
      const R = e.r;
      c.save();
      c.globalCompositeOperation = 'source-over';
      const g = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, R * 1.6);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(0,0,0,0.95)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(e.x, e.y, R * 1.6, 0, TAU); c.fill();
      c.restore();
      const pulse = 1 + Math.sin(e.t * 6) * 0.06;
      c.lineWidth = 3; c.strokeStyle = e.hitFlash > 0 ? C[WHITE] : C[RED];
      c.beginPath(); c.arc(e.x, e.y, R * pulse, 0, TAU); c.stroke();
      c.save(); c.translate(e.x, e.y);
      for (let k = 0; k < 3; k++) {
        c.rotate(e.ang * (k % 2 ? -1 : 1) * (1 + k * 0.3));
        c.strokeStyle = CA(k === 1 ? ORANGE : MAGENTA, 0.6 - k * 0.15);
        c.lineWidth = 2;
        c.setLineDash([R * 0.6, R * 0.4]);
        c.beginPath(); c.arc(0, 0, R * (1.35 + k * 0.32), 0, TAU); c.stroke();
      }
      c.restore();
      c.setLineDash([]);
      return;
    }
    c.save();
    c.translate(e.x, e.y); c.rotate(e.ang);
    let s = 1;
    if (spawning) { s = 1 + e.spawnT * 2.2; c.globalAlpha = ((e.spawnT * 18) | 0) % 2 ? 0.25 : 0.6; }
    c.scale(s, s);
    c.lineJoin = 'round'; c.lineWidth = 3;
    c.strokeStyle = e.hitFlash > 0 ? C[WHITE] : C[e.col];
    const r = e.r;
    switch (e.type) {
      case 'wanderer':
        c.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k * TAU) / 4;
          c.moveTo(0, 0); c.lineTo(Math.cos(a) * r, Math.sin(a) * r); c.lineTo(Math.cos(a + 0.75) * r * 0.75, Math.sin(a + 0.75) * r * 0.75); c.closePath();
        }
        c.stroke();
        break;
      case 'seeker':
        poly(c, [r, 0, 0, r * 0.75, -r, 0, 0, -r * 0.75]); c.stroke();
        c.lineWidth = 2; poly(c, [r * 0.45, 0, 0, r * 0.35, -r * 0.45, 0, 0, -r * 0.35]); c.stroke();
        break;
      case 'square': case 'mini': {
        const q = r * 0.78;
        c.strokeRect(-q, -q, q * 2, q * 2);
        c.rotate(Math.PI / 4); c.lineWidth = 2;
        c.strokeRect(-q * 0.7, -q * 0.7, q * 1.4, q * 1.4);
        break;
      }
      case 'dart':
        poly(c, [r * 1.2, 0, -r * 0.8, r * 0.75, -r * 0.35, 0, -r * 0.8, -r * 0.75]); c.stroke();
        break;
      case 'snake':
        poly(c, [r * 1.2, 0, 0, r * 0.8, -r * 0.6, 0, 0, -r * 0.8]); c.stroke();
        c.fillStyle = C[RED]; c.fillRect(r * 0.2, -r * 0.4, 4, 4); c.fillRect(r * 0.2, r * 0.4 - 4, 4, 4);
        break;
      case 'spark':
        c.beginPath();
        for (let k = 0; k < 4; k++) { const a = (k * TAU) / 4; c.moveTo(0, 0); c.lineTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4); }
        c.stroke(); c.strokeStyle = C[CYAN]; c.strokeRect(-r * 0.4, -r * 0.4, r * 0.8, r * 0.8);
        break;
    }
    c.restore();
  }
  function drawBoss(c, e) {
    const appear = e.spawnT > 0 ? 1 - e.spawnT / 2.2 : 1;
    c.save(); c.translate(e.x, e.y);
    c.globalAlpha = appear;
    // тёмное ядро-подложка
    c.save(); c.globalCompositeOperation = 'source-over';
    const g = c.createRadialGradient(0, 0, 0, 0, 0, e.segR + 30);
    g.addColorStop(0, 'rgba(20,0,20,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, e.segR + 30, 0, TAU); c.fill();
    c.restore();
    // внешнее пунктирное кольцо
    c.save(); c.rotate(-e.rot * 0.5);
    c.setLineDash([6, 14]); c.strokeStyle = CA(PURPLE, 0.7); c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, e.segR + 34, 0, TAU); c.stroke();
    c.restore();
    // щит из сегментов
    const n = e.segN, gap = 0.06;
    c.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      const hp = e.segs[i];
      if (hp <= 0) continue;
      const a0 = e.rot + (i / n) * TAU + gap, a1 = e.rot + ((i + 1) / n) * TAU - gap;
      c.strokeStyle = hp > 5 ? C[MAGENTA] : hp > 2 ? C[PINK] : C[RED];
      c.lineWidth = 6 + hp;
      c.beginPath(); c.arc(0, 0, e.segR, a0, a1); c.stroke();
    }
    // ядро
    const pulse = 1 + Math.sin(G.t * 8) * 0.05;
    const flashCol = e.hitFlash > 0 ? WHITE : MAGENTA;
    for (let k = 0; k < 3; k++) {
      c.save(); c.rotate(e.rot * (k % 2 ? -1.3 : 1) + k);
      c.strokeStyle = k === 0 ? C[flashCol] : CA(k === 1 ? PURPLE : CYAN, 0.8);
      c.lineWidth = 4 - k;
      const R = e.r * pulse * (1 - k * 0.22);
      c.beginPath();
      for (let s = 0; s < 6; s++) { const a = (s * TAU) / 6; const fn = s ? 'lineTo' : 'moveTo'; c[fn](Math.cos(a) * R, Math.sin(a) * R); }
      c.closePath(); c.stroke();
      c.restore();
    }
    // глаз
    const tx = P.alive ? P.x : ARENA_W / 2, ty = P.alive ? P.y : ARENA_H / 2;
    const la = Math.atan2(ty - e.y, tx - e.x);
    c.fillStyle = C[WHITE];
    c.beginPath(); c.arc(Math.cos(la) * 12, Math.sin(la) * 12, 9 + Math.sin(G.t * 5) * 2, 0, TAU); c.fill();
    c.strokeStyle = C[CYAN]; c.lineWidth = 2;
    c.beginPath(); c.arc(Math.cos(la) * 12, Math.sin(la) * 12, 16, 0, TAU); c.stroke();
    c.restore();
  }
  function render() {
    const cw = canvas.width, ch = canvas.height;
    const c = sctx;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#03030a'; c.fillRect(0, 0, cw, ch);
    // туманность с параллаксом
    const nz = 1.35;
    const nw = cw * nz, nh = ch * nz;
    const ox = -(cam.x / ARENA_W - 0.5) * (nw - cw) - (nw - cw) / 2, oy = -(cam.y / ARENA_H - 0.5) * (nh - ch) - (nh - ch) / 2;
    c.globalAlpha = 0.95; c.drawImage(nebula, ox, oy, nw, nh); c.globalAlpha = 1;
    // звёзды
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = '#cfe6ff';
    for (const s of stars) {
      const sx = ((s.x - cam.x * s.z * zoom) % cw + cw) % cw;
      const sy = ((s.y - cam.y * s.z * zoom) % ch + ch) % ch;
      c.globalAlpha = (0.35 + 0.65 * Math.abs(Math.sin(G.t * 1.5 + s.tw))) * (0.3 + s.z * 1.5);
      const sz = s.s * DPR;
      c.fillRect(sx, sy, sz, sz);
    }
    c.globalAlpha = 1;
    // мир
    const sh = G.shake * G.shake * 22;
    const shx = (Math.random() * 2 - 1) * sh, shy = (Math.random() * 2 - 1) * sh;
    const z = zoom * DPR;
    c.setTransform(z, 0, 0, z, (W / 2 - (cam.x + shx) * zoom) * DPR, (H / 2 - (cam.y + shy) * zoom) * DPR);
    const vw = W / zoom / 2 + 60, vh = H / zoom / 2 + 60;
    const x0 = cam.x - vw, x1 = cam.x + vw, y0 = cam.y - vh, y1 = cam.y + vh;
    c.globalCompositeOperation = 'source-over';
    Grid.draw(c, x0, y0, x1, y1);
    c.globalCompositeOperation = 'lighter';
    // рамка арены
    c.strokeStyle = 'rgba(90,140,255,0.9)'; c.lineWidth = 4;
    c.strokeRect(0, 0, ARENA_W, ARENA_H);
    // кристаллы множителя
    c.lineWidth = 2; c.strokeStyle = C[GREEN];
    c.beginPath();
    for (const g of gems) {
      if (g.x < x0 || g.x > x1 || g.y < y0 || g.y > y1) continue;
      const s = g.life < 2 && ((g.life * 10) | 0) % 2 ? 0 : 7;
      const ca = Math.cos(g.ang) * s, sa = Math.sin(g.ang) * s;
      c.moveTo(g.x + ca, g.y + sa); c.lineTo(g.x - sa * 0.6, g.y + ca * 0.6); c.lineTo(g.x - ca, g.y - sa); c.lineTo(g.x + sa * 0.6, g.y - ca * 0.6); c.closePath();
    }
    c.stroke();
    // бонусы
    for (const p of pickups) {
      const pw = POWERS[p.type];
      if (p.life < 3 && ((p.life * 8) | 0) % 2) continue;
      c.save(); c.translate(p.x, p.y); c.rotate(p.t * 1.5);
      c.strokeStyle = C[pw.col]; c.lineWidth = 3;
      const R = 20 + Math.sin(p.t * 5) * 2;
      c.beginPath(); for (let s = 0; s < 6; s++) { const a = (s * TAU) / 6; c[s ? 'lineTo' : 'moveTo'](Math.cos(a) * R, Math.sin(a) * R); } c.closePath(); c.stroke();
      c.rotate(-p.t * 1.5);
      c.fillStyle = C[WHITE]; c.font = '700 18px "Exo 2", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(pw.letter, 0, 1);
      c.restore();
    }
    drawParticles(c, x0, y0, x1, y1);
    for (const e of enemies) {
      if (e.x < x0 - 200 || e.x > x1 + 200 || e.y < y0 - 200 || e.y > y1 + 200) continue;
      drawEnemy(c, e);
    }
    // вражеские пули
    for (const b of ebullets) {
      c.fillStyle = CA(b.col, 0.35);
      c.beginPath(); c.arc(b.x, b.y, b.r * 1.7, 0, TAU); c.fill();
      c.fillStyle = C[WHITE];
      c.beginPath(); c.arc(b.x, b.y, b.r * 0.6, 0, TAU); c.fill();
      c.strokeStyle = C[b.col]; c.lineWidth = 2.5;
      c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU); c.stroke();
    }
    // пули игрока
    c.lineCap = 'round';
    for (const b of bullets) {
      const sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp;
      c.strokeStyle = C[b.col === WHITE ? YELLOW : b.col]; c.lineWidth = b.r * 1.2;
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x - ux * 22, b.y - uy * 22); c.stroke();
      c.strokeStyle = C[WHITE]; c.lineWidth = b.r * 0.6;
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x - ux * 12, b.y - uy * 12); c.stroke();
    }
    // игрок
    for (const g of ghosts) drawShip(c, g.x, g.y, g.ang, g.life * 1.6, CYAN);
    if (P.alive && (P.inv <= 0 || ((G.t * 14) | 0) % 2 === 0 || P.dashT > 0)) {
      drawShip(c, P.x, P.y, P.ang, 1, P.power ? POWERS[P.power].col : WHITE);
      if (P.inv > 0 && P.dashT <= 0) { c.strokeStyle = CA(CYAN, 0.4); c.lineWidth = 2; c.beginPath(); c.arc(P.x, P.y, 28, 0, TAU); c.stroke(); }
    }
    if (P.alive && P.dashCD > 0) {
      c.strokeStyle = CA(CYAN, 0.55); c.lineWidth = 2.5;
      c.beginPath(); c.arc(P.x, P.y, 34, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - P.dashCD / 1.1)); c.stroke();
    }
    // кольца
    for (const r of rings) {
      const a = Math.max(0, r.life / r.max);
      c.strokeStyle = CA(r.col, a * 0.9); c.lineWidth = r.w * (0.4 + a);
      c.beginPath(); c.arc(r.x, r.y, Math.max(0.1, r.r), 0, TAU); c.stroke();
    }
    // всплывающий текст
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const t of texts) {
      c.globalAlpha = Math.min(1, t.life / t.max * 2);
      c.fillStyle = C[t.col];
      c.font = `900 ${t.size}px "Exo 2", sans-serif`;
      c.fillText(t.txt, t.x, t.y);
    }
    c.globalAlpha = 1;

    // ── постобработка: bloom ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.drawImage(scene, 0, 0);
    if (HAS_FILTER) {
      bActx.globalCompositeOperation = 'copy';
      bActx.drawImage(scene, 0, 0, bA.width, bA.height);
      bBctx.globalCompositeOperation = 'copy';
      bBctx.filter = 'blur(3px)'; bBctx.drawImage(bA, 0, 0); bBctx.filter = 'none';
      bCctx.globalCompositeOperation = 'copy';
      bCctx.filter = 'blur(4px)'; bCctx.drawImage(bA, 0, 0, bC.width, bC.height); bCctx.filter = 'none';
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.85; ctx.drawImage(bB, 0, 0, cw, ch);
      ctx.globalAlpha = 0.75; ctx.drawImage(bC, 0, 0, cw, ch);
      ctx.globalAlpha = 1;
    }
    // вспышка
    if (G.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = CA(G.flashCol, G.flash * 0.45);
      ctx.fillRect(0, 0, cw, ch);
    }
    // виньетка и сканлайны
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, cw, ch);
    ctx.globalAlpha = 0.5; ctx.fillStyle = scanPattern; ctx.fillRect(0, 0, cw, ch); ctx.globalAlpha = 1;
    drawHUD();
  }

  function glowText(txt, x, y, font, col, blur = 14, align = 'left') {
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'top';
    ctx.shadowColor = C[col]; ctx.shadowBlur = blur * DPR;
    ctx.fillStyle = C[col]; ctx.fillText(txt, x, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.globalAlpha *= 0.6; ctx.fillText(txt, x, y); ctx.globalAlpha = 1;
  }
  function drawHUD() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (G.state === 'play' || (G.state === 'over')) {
      const pad = 22;
      glowText(G.score.toLocaleString('ru-RU'), pad, pad - 4, '900 38px "Exo 2", sans-serif', CYAN, 16);
      glowText('x' + G.mult, pad, pad + 40, '700 24px "Exo 2", sans-serif', GREEN, 12);
      glowText(G.isBoss ? 'БОСС' : 'ВОЛНА ' + G.wave, W - pad, pad, '700 20px "Exo 2", sans-serif', G.isBoss ? MAGENTA : BLUE, 10, 'right');
      // жизни
      ctx.save();
      for (let i = 0; i < Math.min(G.lives, 8); i++) {
        ctx.save(); ctx.translate(W - pad - 12 - i * 30, pad + 46); ctx.rotate(-Math.PI / 2);
        ctx.shadowColor = C[CYAN]; ctx.shadowBlur = 10 * DPR;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        poly(ctx, [11, 0, -7, 8, -3, 0, -7, -8]); ctx.stroke();
        ctx.restore();
      }
      for (let i = 0; i < Math.min(G.bombs, 8); i++) {
        ctx.shadowColor = C[YELLOW]; ctx.shadowBlur = 10 * DPR;
        ctx.strokeStyle = C[YELLOW]; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(W - pad - 12 - i * 30, pad + 80, 8, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(W - pad - 12 - i * 30, pad + 80, 3, 0, TAU); ctx.stroke();
      }
      ctx.restore();
      ctx.shadowBlur = 0;
      if (G.autofire) glowText('АВТООГОНЬ', pad, pad + 74, '700 13px "Exo 2", sans-serif', CYAN, 8);
      // бонус
      if (P.power) {
        const pw = POWERS[P.power];
        const bw = 240, bx = W / 2 - bw / 2, by = H - 46;
        glowText(pw.name, W / 2, by - 26, '700 18px "Exo 2", sans-serif', pw.col, 12, 'center');
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(bx, by, bw, 6);
        ctx.shadowColor = C[pw.col]; ctx.shadowBlur = 12 * DPR;
        ctx.fillStyle = C[pw.col]; ctx.fillRect(bx, by, bw * clamp(P.powerT / 12, 0, 1), 6);
        ctx.shadowBlur = 0;
      }
      // полоса здоровья босса
      const boss = enemies.find((e) => e.type === 'boss');
      if (boss) {
        const bw = Math.min(560, W - 260), bx = W / 2 - bw / 2, by = 30;
        const a = boss.spawnT > 0 ? 1 - boss.spawnT / 2.2 : 1;
        ctx.globalAlpha = a;
        glowText('КВАЗАР', W / 2, by - 4, '900 16px "Russo One", "Exo 2", sans-serif', MAGENTA, 12, 'center');
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(bx, by + 20, bw, 8);
        ctx.shadowColor = C[MAGENTA]; ctx.shadowBlur = 14 * DPR;
        ctx.fillStyle = C[MAGENTA]; ctx.fillRect(bx, by + 20, bw * Math.max(0, boss.hp / boss.maxHp), 8);
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
      // прицел
      if (!G.usePad && G.state === 'play' && !G.paused) {
        ctx.save(); ctx.translate(mouse.x, mouse.y); ctx.rotate(G.t * 1.5);
        ctx.shadowColor = C[CYAN]; ctx.shadowBlur = 8 * DPR;
        ctx.strokeStyle = C[CYAN]; ctx.lineWidth = 2;
        for (let k = 0; k < 4; k++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(14, 0); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(0, 0, 2, 0, TAU); ctx.stroke();
        ctx.restore();
      }
    }
    // анонс волны
    if (G.announce && G.state === 'play') {
      const an = G.announce;
      const life = 2.6;
      if (an.t < life) {
        const k = an.t / life;
        const a = k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
        const sc = 1 + (1 - Math.min(1, an.t * 4)) * 0.6;
        ctx.save(); ctx.globalAlpha = a;
        ctx.translate(W / 2, H * 0.3); ctx.scale(sc, sc);
        glowText(an.title, 0, -30, `900 ${Math.min(64, W / 11)}px "Russo One", "Exo 2", sans-serif`, an.col, 26, 'center');
        ctx.globalAlpha = a;
        if (an.sub) glowText(an.sub.toUpperCase(), 0, 40, '700 18px "Exo 2", sans-serif', WHITE, 8, 'center');
        ctx.restore();
      }
    }
  }

  // ───────────────────────── главный цикл ─────────────────────────
  let last = performance.now(), gridAcc = 0;
  function frame(now) {
    const real = Math.min(0.05, (now - last) / 1000);
    last = now;
    pollPad();
    let gdt = 0;
    if (G.state === 'play' && !G.paused) {
      if (G.hitstop > 0) G.hitstop -= real;
      else { gdt = real * G.timeScale; update(gdt); }
      G.timeScale += (1 - G.timeScale) * Math.min(1, real * 1.6);
      if (G.announce) G.announce.t += real;
    } else if (G.state !== 'play') {
      gdt = real; updateAttract(real);
      enemies = enemies.filter((e) => !e.dead);
    }
    if (gdt > 0) updateParticles(gdt);
    gridAcc += gdt;
    let steps = 0;
    while (gridAcc >= 1 / 60 && steps < 3) { Grid.step(); gridAcc -= 1 / 60; steps++; }
    if (steps === 3) gridAcc = 0;
    G.shake = Math.max(0, G.shake - real * 1.8);
    G.flash = Math.max(0, G.flash - real * 2.2);
    updateCamera(real);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // отладочный доступ (удобно для тестов из консоли)
  window.PULSAR = { G, P, get enemies() { return enemies; }, spawnEnemy, nextWave, startGame, mouse, keys };
})();
