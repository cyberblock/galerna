/*
 * Galerna: land a rescue drone on the cliffs in a storm.
 * Fixed-step physics (120 Hz) decoupled from rendering, seeded procedural
 * terrain, layered wind gusts and a pooled particle system. No libraries.
 */
(() => {
  'use strict';

  const STEP = 1 / 120;
  const MAX_FRAME = 0.25;
  const SAFE_VX = 22;
  const SAFE_VY = 34;
  const SAFE_ANGLE = 0.2;

  const COLORS = {
    sky: '#1c1c1c',
    skyLow: '#262626',
    rock: '#343432',
    rockEdge: '#6c6e68',
    sea: '#20282a',
    ink: '#f1f1ef',
    muted: '#a5a6a1',
    accent: '#8fa68e',
    accentStrong: '#a6bba5',
    danger: '#d98f7e',
    flame: '#e8c48a',
  };

  /* ---------- Language ---------- */

  const STRINGS = {
    en: {
      level: 'Level', fuel: 'Fuel', speed: 'Speed', wind: 'Wind', score: 'Score', best: 'Best score',
      intro: 'A storm hits the coast of A Coruña. Land the rescue drone on the lit pad: slow, upright and with fuel to spare.',
      keyRotate: 'Rotate', keyThrust: 'Thrust', keyPause: 'Pause', keyRestart: 'Restart level',
      start: 'Start', next: 'Next level', retry: 'Try again', resume: 'Resume', again: 'Play again',
      landed: 'Landed', crashed: 'Lost the drone', paused: 'Paused', won: 'Storm over',
      tooFast: 'Too fast: {v} on touchdown. Keep it under {max}.',
      tilted: 'Tilted {a}° on touchdown. Keep it under {max}°.',
      offPad: 'Touched the rocks, not the pad.',
      hull: 'The hull hit the cliff.',
      lost: 'The wind carried the drone off the map.',
      landedText: '+{points} points. {fuel}% fuel left.',
      wonText: 'All six pads reached. Final score {score}.',
      pausedText: 'The storm waits for you.',
    },
    es: {
      level: 'Nivel', fuel: 'Combustible', speed: 'Velocidad', wind: 'Viento', score: 'Puntos', best: 'Mejor puntuación',
      intro: 'Una galerna golpea la costa de A Coruña. Aterriza el dron de rescate en la plataforma iluminada: despacio, recto y con combustible de sobra.',
      keyRotate: 'Girar', keyThrust: 'Propulsar', keyPause: 'Pausa', keyRestart: 'Reiniciar nivel',
      start: 'Empezar', next: 'Siguiente nivel', retry: 'Reintentar', resume: 'Seguir', again: 'Jugar otra vez',
      landed: 'Aterrizado', crashed: 'Dron perdido', paused: 'En pausa', won: 'Pasó la galerna',
      tooFast: 'Demasiado rápido: {v} al tocar. Mantente por debajo de {max}.',
      tilted: 'Inclinado {a}° al tocar. Mantente por debajo de {max}°.',
      offPad: 'Tocaste las rocas, no la plataforma.',
      hull: 'El casco chocó contra el acantilado.',
      lost: 'El viento sacó el dron del mapa.',
      landedText: '+{points} puntos. Queda un {fuel}% de combustible.',
      wonText: 'Las seis plataformas alcanzadas. Puntuación final {score}.',
      pausedText: 'La galerna te espera.',
    },
  };
  const lang = (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  const t = (key, vars = {}) => STRINGS[lang][key].replace(/\{(\w+)\}/g, (_, k) => vars[k]);
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });

  /* ---------- Storage ---------- */

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };

  /* ---------- Seeded random and noise ---------- */

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function valueNoise(rand, count) {
    const knots = Array.from({ length: count + 1 }, rand);
    return (x) => {
      const i = Math.floor(x), f = x - i;
      const s = f * f * (3 - 2 * f);
      return knots[i % count] * (1 - s) + knots[(i + 1) % count] * s;
    };
  }

  /* ---------- Levels ---------- */

  const LEVELS = [
    { gravity: 26, wind: 4, gust: 0, pad: 150, fuel: 100, seed: 11 },
    { gravity: 30, wind: 8, gust: 6, pad: 130, fuel: 100, seed: 23 },
    { gravity: 34, wind: 12, gust: 10, pad: 115, fuel: 100, seed: 37 },
    { gravity: 38, wind: 16, gust: 16, pad: 100, fuel: 110, seed: 51 },
    { gravity: 42, wind: 20, gust: 22, pad: 90, fuel: 115, seed: 64 },
    { gravity: 46, wind: 26, gust: 30, pad: 80, fuel: 120, seed: 89 },
  ];

  /* ---------- Canvas and world size ---------- */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let dpr = 1, cw = 0, ch = 0;
  let W = 1600, H = 900, scale = 1, offsetY = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth; ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    fitWorld();
  }

  function sizeWorld() {
    W = cw >= ch ? 1600 : 900;
    H = Math.round(W * ch / cw);
    fitWorld();
  }

  function fitWorld() {
    scale = cw / W;
    offsetY = (ch - H * scale) / 2;
  }

  /* ---------- Terrain ---------- */

  let terrain = [];
  let pad = null;
  let lighthouse = null;

  function buildTerrain(level, rand) {
    const noise = valueNoise(rand, 64);
    const step = 20;
    const points = [];
    for (let x = 0; x <= W; x += step) {
      const n = noise(x / 190) * 0.65 + noise(x / 60 + 17) * 0.35;
      points.push({ x, y: H * (0.58 + n * 0.32) });
    }

    // Flatten a pad away from the spawn point.
    const padWidth = level.pad;
    const minX = W * 0.45, maxX = W - padWidth - 60;
    const padX = minX + rand() * (maxX - minX);
    let padY = 0, count = 0;
    for (const p of points) if (p.x >= padX && p.x <= padX + padWidth) { padY += p.y; count++; }
    padY = Math.min(padY / Math.max(count, 1), H * 0.82);
    for (const p of points) {
      if (p.x >= padX - step && p.x <= padX + padWidth + step) p.y = padY;
    }
    pad = { x: padX, y: padY, w: padWidth };

    // The lighthouse stands on the highest rock left of the pad.
    let top = points[2];
    for (const p of points) if (p.x > 80 && p.x < padX - 120 && p.y < top.y) top = p;
    lighthouse = { x: top.x, y: top.y };

    terrain = points;
  }

  function groundAt(x) {
    if (x <= 0) return terrain[0].y;
    if (x >= W) return terrain[terrain.length - 1].y;
    const step = terrain[1].x - terrain[0].x;
    const i = Math.floor(x / step);
    const a = terrain[i], b = terrain[Math.min(i + 1, terrain.length - 1)];
    return a.y + (b.y - a.y) * ((x - a.x) / step);
  }

  /* ---------- Wind ---------- */

  const wind = { base: 0, gust: 0, value: 0, time: 0, gustLeft: 0, gustPower: 0 };

  function updateWind(level, dt, rand) {
    wind.time += dt;
    wind.base = level.wind * (Math.sin(wind.time * 0.37) * 0.6 + Math.sin(wind.time * 0.11 + 1.3) * 0.4);
    if (wind.gustLeft <= 0 && level.gust > 0 && rand() < dt * 0.25) {
      wind.gustLeft = 0.8 + rand() * 1.6;
      wind.gustPower = (rand() < 0.5 ? -1 : 1) * level.gust * (0.6 + rand() * 0.4);
    }
    const target = wind.gustLeft > 0 ? wind.gustPower : 0;
    wind.gust += (target - wind.gust) * Math.min(1, dt * 3);
    wind.gustLeft -= dt;
    wind.value = wind.base + wind.gust;
  }

  /* ---------- Particles (pooled) ---------- */

  const POOL = 900;
  const particles = Array.from({ length: POOL }, () => ({ alive: false }));
  let poolIndex = 0;

  function emit(x, y, vx, vy, life, size, color, drag = 1.5) {
    const p = particles[poolIndex];
    poolIndex = (poolIndex + 1) % POOL;
    Object.assign(p, { alive: true, x, y, vx, vy, life, max: life, size, color, drag });
  }

  function updateParticles(dt, gravity) {
    for (const p of particles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vx += (wind.value * 0.6 - p.vx * p.drag) * dt;
      p.vy += (gravity * 0.3 - p.vy * p.drag) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.y > groundAt(p.x)) { p.y = groundAt(p.x); p.vy *= -0.3; p.vx *= 0.6; }
    }
  }

  const rain = Array.from({ length: 220 }, () => ({ x: Math.random() * 1600, y: Math.random() * 900, s: 0.6 + Math.random() * 0.8 }));

  /* ---------- Drone ---------- */

  const drone = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, fuel: 100, thrusting: false };
  const FEET = [{ x: -13, y: 13 }, { x: 13, y: 13 }];
  const HULL = [{ x: 0, y: -15 }, { x: -11, y: -2 }, { x: 11, y: -2 }, { x: -8, y: 8 }, { x: 8, y: 8 }];

  function local(point) {
    const c = Math.cos(drone.angle), s = Math.sin(drone.angle);
    return { x: drone.x + point.x * c - point.y * s, y: drone.y + point.x * s + point.y * c };
  }

  /* ---------- Input ---------- */

  const keys = { left: false, right: false, thrust: false };
  const KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'thrust', KeyW: 'thrust', Space: 'thrust' };

  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
    if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
    if (e.code === 'KeyR' && state.mode !== 'menu') startLevel(state.level);
    if (e.code === 'Enter' && !panel.hidden) panelButton.click();
  });
  window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; });
  window.addEventListener('blur', () => { keys.left = keys.right = keys.thrust = false; if (state.mode === 'play') togglePause(); });

  document.querySelectorAll('.touch button').forEach((btn) => {
    const key = btn.dataset.key;
    const on = (e) => { e.preventDefault(); keys[key] = true; btn.classList.add('is-down'); };
    const off = () => { keys[key] = false; btn.classList.remove('is-down'); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('pointerleave', off);
  });

  /* ---------- Game state ---------- */

  const panel = document.getElementById('panel');
  const panelTitle = document.getElementById('panel-title');
  const panelText = document.getElementById('panel-text');
  const panelButton = document.getElementById('panel-button');
  const hud = {
    level: document.getElementById('hud-level'),
    fuel: document.getElementById('hud-fuel'),
    speed: document.getElementById('hud-speed'),
    wind: document.getElementById('hud-wind'),
    score: document.getElementById('hud-score'),
  };
  const bestEl = document.getElementById('best');

  const state = { mode: 'menu', level: 0, score: 0, levelStartScore: 0, best: store.get('galerna.best', 0), rand: Math.random, shake: 0, beam: 0 };
  bestEl.textContent = state.best;

  function showPanel(title, text, button, action) {
    panelTitle.textContent = title;
    panelText.textContent = text;
    panelButton.textContent = button;
    panelButton.onclick = action;
    panel.hidden = false;
    panel.querySelector('.keys').hidden = state.mode !== 'menu';
    panelButton.focus({ preventScroll: true });
  }

  function hidePanel() { panel.hidden = true; panelButton.blur(); }

  function startLevel(index) {
    const level = LEVELS[index];
    state.level = index;
    state.score = state.levelStartScore;
    state.rand = mulberry32(level.seed);
    sizeWorld();
    buildTerrain(level, state.rand);
    Object.assign(wind, { base: 0, gust: 0, value: 0, time: 0, gustLeft: 0, gustPower: 0 });
    Object.assign(drone, { x: W * 0.1, y: H * 0.26, vx: 18, vy: 0, angle: 0, fuel: level.fuel, thrusting: false });
    particles.forEach((p) => { p.alive = false; });
    state.mode = 'play';
    hidePanel();
  }

  function togglePause() {
    if (state.mode === 'play') {
      state.mode = 'paused';
      showPanel(t('paused'), t('pausedText'), t('resume'), () => { state.mode = 'play'; hidePanel(); });
    } else if (state.mode === 'paused') {
      state.mode = 'play'; hidePanel();
    }
  }

  function explode() {
    for (let i = 0; i < 140; i++) {
      const a = state.rand() * Math.PI * 2, v = 40 + state.rand() * 220;
      const color = i % 3 === 0 ? COLORS.flame : i % 3 === 1 ? COLORS.danger : COLORS.muted;
      emit(drone.x, drone.y, Math.cos(a) * v, Math.sin(a) * v - 60, 0.6 + state.rand() * 1.2, 1.5 + state.rand() * 3, color, 0.9);
    }
    state.shake = 0.5;
  }

  function crash(reason) {
    state.mode = 'crashed';
    explode();
    setTimeout(() => showPanel(t('crashed'), reason, t('retry'), () => startLevel(state.level)), 700);
  }

  function land() {
    const level = LEVELS[state.level];
    const center = pad.x + pad.w / 2;
    const accuracy = 1 - Math.min(1, Math.abs(drone.x - center) / (pad.w / 2));
    const fuelPct = Math.round((drone.fuel / level.fuel) * 100);
    const points = Math.round(500 + drone.fuel * 12 + accuracy * 400 + (SAFE_VY - Math.abs(drone.vy)) * 8) * (state.level + 1);
    state.score += points;
    state.levelStartScore = state.score;
    drone.vx = drone.vy = 0;
    drone.angle = 0;
    state.mode = 'landed';
    for (let i = 0; i < 40; i++) emit(center, pad.y - 2, (state.rand() - 0.5) * 180, -state.rand() * 120, 0.8, 2, COLORS.accentStrong, 2);

    if (state.score > state.best) { state.best = state.score; store.set('galerna.best', state.best); bestEl.textContent = state.best; }

    const last = state.level === LEVELS.length - 1;
    setTimeout(() => {
      if (last) {
        showPanel(t('won'), t('wonText', { score: state.score }), t('again'), () => { state.levelStartScore = 0; startLevel(0); });
      } else {
        showPanel(t('landed'), t('landedText', { points, fuel: fuelPct }), t('next'), () => startLevel(state.level + 1));
      }
    }, 600);
  }

  /* ---------- Physics step ---------- */

  function step(dt) {
    const level = LEVELS[state.level];
    updateWind(level, dt, state.rand);
    state.beam += dt * 0.9;

    if (state.mode === 'play') {
      if (keys.left) drone.angle -= 2.6 * dt;
      if (keys.right) drone.angle += 2.6 * dt;
      drone.angle = Math.max(-1.4, Math.min(1.4, drone.angle));

      drone.thrusting = keys.thrust && drone.fuel > 0;
      let ax = wind.value * 0.9 - drone.vx * 0.05;
      let ay = level.gravity - drone.vy * 0.05;
      if (drone.thrusting) {
        const power = level.gravity * 2.3;
        ax += Math.sin(drone.angle) * power;
        ay -= Math.cos(drone.angle) * power;
        drone.fuel = Math.max(0, drone.fuel - dt * 5);
        if (state.rand() < 0.9) {
          const nozzle = local({ x: (state.rand() - 0.5) * 6, y: 10 });
          const spread = (state.rand() - 0.5) * 0.5;
          const v = 120 + state.rand() * 80;
          emit(nozzle.x, nozzle.y, -Math.sin(drone.angle + spread) * v + drone.vx, Math.cos(drone.angle + spread) * v + drone.vy, 0.35 + state.rand() * 0.3, 1.5 + state.rand() * 2, state.rand() < 0.6 ? COLORS.flame : COLORS.muted);
        }
      }
      drone.vx += ax * dt; drone.vy += ay * dt;
      drone.x += drone.vx * dt; drone.y += drone.vy * dt;

      if (drone.x < -60 || drone.x > W + 60 || drone.y < -H * 0.6) return crash(t('lost'));

      for (const point of HULL) {
        const p = local(point);
        if (p.y >= groundAt(p.x)) return crash(t('hull'));
      }
      const feet = FEET.map(local);
      if (feet.some((p) => p.y >= groundAt(p.x))) {
        const onPad = feet.every((p) => p.x >= pad.x && p.x <= pad.x + pad.w);
        const speed = Math.hypot(drone.vx, drone.vy);
        if (!onPad) return crash(t('offPad'));
        if (Math.abs(drone.vy) > SAFE_VY || Math.abs(drone.vx) > SAFE_VX) {
          return crash(t('tooFast', { v: (speed / 10).toFixed(1), max: (SAFE_VY / 10).toFixed(1) }));
        }
        if (Math.abs(drone.angle) > SAFE_ANGLE) {
          return crash(t('tilted', { a: Math.round(Math.abs(drone.angle) * 57.3), max: Math.round(SAFE_ANGLE * 57.3) }));
        }
        drone.y = pad.y - 13;
        return land();
      }
    }
    updateParticles(dt, level.gravity);
  }

  /* ---------- Rendering ---------- */

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COLORS.sky);
    g.addColorStop(1, COLORS.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(-W, -H, W * 3, H * 3);

    // Sea line behind the cliffs.
    ctx.fillStyle = COLORS.sea;
    ctx.fillRect(-W, H * 0.8, W * 3, H * 2);
  }

  function drawBeam() {
    if (!lighthouse) return;
    const lx = lighthouse.x, ly = lighthouse.y - 58;
    const a = -Math.PI / 2 + Math.sin(state.beam) * 1.3;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(a);
    const len = W * 0.9;
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(166, 187, 165, 0.32)');
    g.addColorStop(1, 'rgba(166, 187, 165, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, -len * 0.09);
    ctx.lineTo(len, len * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLighthouse() {
    if (!lighthouse) return;
    const { x, y } = lighthouse;
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(x - 12, y - 46, 24, 46);
    ctx.fillRect(x - 13, y - 48, 26, 3);
    ctx.fillRect(x - 8, y - 58, 16, 10);
    ctx.fillStyle = COLORS.accentStrong;
    ctx.fillRect(x - 5, y - 64, 10, 6);
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath(); ctx.moveTo(x - 6, y - 64); ctx.lineTo(x, y - 70); ctx.lineTo(x + 6, y - 64); ctx.fill();
    ctx.strokeStyle = COLORS.sky; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 12, y - 10); ctx.lineTo(x + 12, y - 20); ctx.moveTo(x - 12, y - 26); ctx.lineTo(x + 12, y - 36); ctx.stroke();
  }

  function drawTerrain() {
    ctx.beginPath();
    ctx.moveTo(-W, H * 2);
    ctx.lineTo(-W, terrain[0].y);
    for (const p of terrain) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W * 2, terrain[terrain.length - 1].y);
    ctx.lineTo(W * 2, H * 2);
    ctx.closePath();
    ctx.fillStyle = COLORS.rock;
    ctx.fill();
    ctx.strokeStyle = COLORS.rockEdge;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Landing pad with pulsing lights.
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(pad.x, pad.y - 3, pad.w, 6);
    const pulse = 0.5 + Math.sin(performance.now() / 260) * 0.5;
    ctx.fillStyle = `rgba(166, 187, 165, ${0.4 + pulse * 0.6})`;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(pad.x + (pad.w / 4) * i, pad.y - 6, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawRain(dt) {
    ctx.strokeStyle = 'rgba(165, 166, 161, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const slant = wind.value * 0.06;
    for (const r of rain) {
      r.y += 700 * r.s * dt;
      r.x += wind.value * 9 * r.s * dt;
      if (r.y > H) { r.y = -10; r.x = Math.random() * W; }
      if (r.x > W) r.x -= W; else if (r.x < 0) r.x += W;
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x + slant * 12, r.y + 14 * r.s);
    }
    ctx.stroke();
  }

  function drawParticles() {
    for (const p of particles) {
      if (!p.alive) continue;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawDrone() {
    if (state.mode === 'crashed') return;
    ctx.save();
    ctx.translate(drone.x, drone.y);
    ctx.rotate(drone.angle);
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 6); ctx.lineTo(-13, 13); ctx.moveTo(-16, 13); ctx.lineTo(-10, 13);
    ctx.moveTo(7, 6); ctx.lineTo(13, 13); ctx.moveTo(10, 13); ctx.lineTo(16, 13);
    ctx.stroke();
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.moveTo(0, -15); ctx.lineTo(11, -2); ctx.lineTo(8, 8); ctx.lineTo(-8, 8); ctx.lineTo(-11, -2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(-4, -5, 8, 5);
    ctx.restore();

    // Guide: altitude line to the ground under the drone.
    if (state.mode === 'play') {
      const gy = groundAt(drone.x);
      ctx.strokeStyle = 'rgba(143, 166, 142, 0.25)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.moveTo(drone.x, drone.y + 16); ctx.lineTo(drone.x, gy); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function render(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, cw, ch);

    let sx = 0, sy = 0;
    if (state.shake > 0) {
      state.shake -= dt;
      sx = (Math.random() - 0.5) * 14 * state.shake; sy = (Math.random() - 0.5) * 14 * state.shake;
    }
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * sx, dpr * (offsetY + sy));
    drawBackground();
    drawBeam();
    if (terrain.length) {
      drawLighthouse();
      drawTerrain();
    }
    drawRain(dt);
    drawParticles();
    if (terrain.length && state.mode !== 'menu') drawDrone();
  }

  function updateHud() {
    if (state.mode === 'menu') return;
    const level = LEVELS[state.level];
    hud.level.textContent = `${state.level + 1}/${LEVELS.length}`;
    const pct = drone.fuel / level.fuel;
    hud.fuel.style.transform = `scaleX(${pct})`;
    hud.fuel.classList.toggle('is-low', pct < 0.25);
    const speed = Math.hypot(drone.vx, drone.vy) / 10;
    hud.speed.textContent = speed.toFixed(1);
    hud.speed.style.color = Math.abs(drone.vy) > SAFE_VY || Math.abs(drone.vx) > SAFE_VX ? COLORS.danger : '';
    const w = Math.round(wind.value);
    hud.wind.textContent = `${w < 0 ? '←' : w > 0 ? '→' : ''} ${Math.abs(w)}`;
    hud.score.textContent = state.score;
  }

  /* ---------- Main loop ---------- */

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    if (state.mode !== 'paused') {
      acc += dt;
      while (acc >= STEP) { step(STEP); acc -= STEP; }
    }
    render(state.mode === 'paused' ? 0 : dt);
    updateHud();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();

  // Menu backdrop: a calm level behind the start panel.
  state.rand = mulberry32(7);
  sizeWorld();
  buildTerrain(LEVELS[0], state.rand);
  panelButton.onclick = () => { state.levelStartScore = 0; startLevel(0); };
  if (new URLSearchParams(location.search).has('debug')) {
    window.galerna = { state, drone, keys, wind, get pad() { return pad; }, groundAt };
  }
  requestAnimationFrame(frame);
})();
