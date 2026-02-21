/* Pottu: toast-linkit + mini potato jumpper (endless hyppely). */

const BEST_KEY = "pottu_dash_best_v1";
const AUDIO_KEY = "pottu_dash_audio_v1";

const els = {
  toast: document.getElementById("toast"),

  gameArea: document.getElementById("gameArea"),
  canvas: document.getElementById("gameCanvas"),
  overlay: document.getElementById("gameOverlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  overlayHint: document.getElementById("overlayHint"),

  startBtn: document.getElementById("startBtn"),
  restartBtn: document.getElementById("restartBtn"),
  jumpBtn: document.getElementById("jumpBtn"),
  resetBestBtn: document.getElementById("resetBestBtn"),
  audioBtn: document.getElementById("audioBtn"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),

  score: document.getElementById("score"),
  best: document.getElementById("best"),
};

let toastTimer = null;

function loadBool(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function saveBool(key, val) {
  try {
    localStorage.setItem(key, val ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function clampInt(n) {
  const x = Number.parseInt(String(n), 10);
  return Number.isFinite(x) && x >= 0 ? x : 0;
}

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2200);
}

function wireComingSoonLinks() {
  const links = document.querySelectorAll("a[data-coming-soon]");
  links.forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const msg = a.getAttribute("data-coming-soon") || "Tulossa";
      showToast(msg);
    });
  });
}

function createGame() {
  if (!els.canvas) return null;

  const canvas = els.canvas;
  const ctx = canvas.getContext("2d", { alpha: false });

  const netherBg = new Image();
  let netherBgReady = false;
  let renderBgCacheFn = null;
  netherBg.decoding = "async";
  netherBg.src = "assets/nether-bg.svg";
  netherBg.addEventListener("load", () => {
    netherBgReady = true;
    if (renderBgCacheFn) renderBgCacheFn();
  });
  netherBg.addEventListener("error", () => {
    netherBgReady = false;
    if (renderBgCacheFn) renderBgCacheFn();
  });

  // Cache background into an offscreen canvas for mobile performance.
  const bgCache = document.createElement("canvas");
  const bgCtx = bgCache.getContext("2d", { alpha: false });
  let bgCacheReady = false;

  const state = {
    running: false,
    dead: false,
    t: 0,
    score: 0,
    best: 0,

    w: 960,
    h: 540,
    dpr: 1,
    unit: 24,

    prevW: 0,
    prevH: 0,

    speed: 430,
    speedMax: 980,
    speedRamp: 16,

    gravity: 2200,
    jumpV: 860,

    floorY: 0,
    floorH: 0,

    coyote: 0,
    coyoteMax: 0.075,

    obstacles: [],
    nextSpawn: 0,

    // Spawn fairness helpers (ettei tule mahdottomia putkia)
    chain: 0,
    doubleCooldown: 0,
    tallCooldown: 0,
    lastWasDouble: false,
  };

  const player = {
    x: 0,
    y: 0,
    w: 36,
    h: 36,
    vy: 0,
    onGround: true,
    rot: 0,
    maxJumps: 2,
    jumpsLeft: 2,
  };

  const audio = {
    enabled: loadBool(AUDIO_KEY, true),
    ctx: null,
    master: null,
    musicGain: null,
    sfxGain: null,
    musicTimer: null,
    musicOn: false,
  };

  function updateAudioButton() {
    if (!els.audioBtn) return;
    els.audioBtn.textContent = audio.enabled ? "Aani: PÄÄLLÄ" : "Aani: POIS";
  }

  function ensureAudio() {
    if (!audio.enabled) return false;
    if (audio.ctx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    audio.ctx = new Ctx();

    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.6;

    const comp = audio.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.12;

    audio.musicGain = audio.ctx.createGain();
    audio.musicGain.gain.value = 0.0;
    audio.sfxGain = audio.ctx.createGain();
    audio.sfxGain.gain.value = 0.9;

    audio.musicGain.connect(comp);
    audio.sfxGain.connect(comp);
    comp.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    return true;
  }

  async function resumeAudio() {
    if (!ensureAudio()) return;
    if (audio.ctx.state === "suspended") {
      try {
        await audio.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  function noteHz(semitonesFromA4) {
    return 440 * Math.pow(2, semitonesFromA4 / 12);
  }

  function playTone({ hz, duration, type, gain, out, when }) {
    if (!audio.ctx) return;
    const t0 = when ?? audio.ctx.currentTime;
    const osc = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function startMusic() {
    if (!audio.enabled) return;
    if (audio.musicOn) return;
    if (!ensureAudio()) return;

    resumeAudio();
    audio.musicOn = true;

    const now = audio.ctx.currentTime;
    audio.musicGain.gain.cancelScheduledValues(now);
    audio.musicGain.gain.setValueAtTime(audio.musicGain.gain.value, now);
    audio.musicGain.gain.linearRampToValueAtTime(0.32, now + 0.18);

    // Simple 8-bit arpeggio loop (minor-ish), speed ramps slightly with game speed.
    const pattern = [0, 7, 12, 7, 3, 7, 10, 7];
    const base = -9; // C4-ish relative to A4
    let step = 0;

    const tick = () => {
      if (!audio.musicOn || !audio.ctx) return;

      const s = state.speed;
      const bpm = 132 + Math.min(36, (s - 430) * 0.05);
      const beat = 60 / bpm;
      const dur = beat * 0.65;

      const semi = base + pattern[step % pattern.length];
      const hz = noteHz(semi);
      playTone({ hz, duration: dur, type: "square", gain: 0.12, out: audio.musicGain });

      // Tiny click/percussion every other step.
      if (step % 2 === 0) {
        playTone({ hz: 90, duration: beat * 0.12, type: "triangle", gain: 0.05, out: audio.musicGain });
      }

      step += 1;
      const nextMs = Math.max(90, beat * 1000);
      audio.musicTimer = window.setTimeout(tick, nextMs);
    };

    tick();
  }

  function stopMusic() {
    if (!audio.ctx) {
      audio.musicOn = false;
      return;
    }
    audio.musicOn = false;
    if (audio.musicTimer) {
      window.clearTimeout(audio.musicTimer);
      audio.musicTimer = null;
    }
    const now = audio.ctx.currentTime;
    audio.musicGain.gain.cancelScheduledValues(now);
    audio.musicGain.gain.setValueAtTime(audio.musicGain.gain.value, now);
    audio.musicGain.gain.linearRampToValueAtTime(0.0, now + 0.12);
  }

  function playDieSfx() {
    if (!audio.enabled) return;
    if (!ensureAudio()) return;
    resumeAudio();
    const t0 = audio.ctx.currentTime + 0.01;
    // Descending "wah" + thud.
    playTone({ hz: 260, duration: 0.08, type: "sawtooth", gain: 0.12, out: audio.sfxGain, when: t0 });
    playTone({ hz: 160, duration: 0.12, type: "sawtooth", gain: 0.10, out: audio.sfxGain, when: t0 + 0.06 });
    playTone({ hz: 70, duration: 0.10, type: "triangle", gain: 0.10, out: audio.sfxGain, when: t0 + 0.14 });
  }

  function loadBest() {
    try {
      state.best = clampInt(localStorage.getItem(BEST_KEY));
    } catch {
      state.best = 0;
    }
    if (els.best) els.best.textContent = String(state.best);
  }

  function saveBest() {
    try {
      localStorage.setItem(BEST_KEY, String(state.best));
    } catch {
      /* ignore */
    }
  }

  function setOverlay(mode) {
    if (!els.overlay) return;
    els.overlay.classList.remove("hidden");
    if (mode === "ready") {
      if (els.overlayTitle) els.overlayTitle.textContent = "mini potato jumpper";
      if (els.overlayText) els.overlayText.textContent = "Hyppy: klikkaa / koske / valilyonti (tuplahyppy!)";
      if (els.overlayHint) els.overlayHint.textContent = "Vinkki: korkeat esteet vaatii tuplahypyn.";
    }
    if (mode === "dead") {
      if (els.overlayTitle) els.overlayTitle.textContent = "Game over!";
      if (els.overlayText) els.overlayText.textContent = "Hyppy: valilyonti tai napauta";
      if (els.overlayHint) els.overlayHint.textContent = "Paina Uudestaan.";
    }
  }

  function hideOverlay() {
    if (!els.overlay) return;
    els.overlay.classList.add("hidden");
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const prevW = state.w;
    const prevH = state.h;
    const prevUnit = state.unit;

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.w = cssW;
    state.h = cssH;
    state.dpr = dpr;

    // Scale world unit by canvas height (keeps fullscreen proportions sane).
    state.unit = Math.max(18, Math.min(46, Math.floor(state.h * 0.045)));
    const p = Math.max(28, Math.min(72, Math.floor(state.unit * 1.5)));
    player.w = p;
    player.h = p;
    state.floorH = Math.max(92, Math.floor(state.h * 0.18));
    state.floorY = state.h - state.floorH;

    // Scale jump physics by canvas size so mobile is not "free".
    const targetJumpH = Math.max(56, Math.min(state.floorY * 0.72, state.h * 0.32));
    state.gravity = Math.max(1200, Math.min(4200, state.h * 5.0));
    state.jumpV = Math.sqrt(2 * state.gravity * targetJumpH);

    player.x = Math.floor(state.w * 0.18);
    player.y = state.floorY - player.h;

    // Keep existing obstacles pinned to the new floor after resize (e.g. fullscreen).
    if (prevW && prevH && state.obstacles.length > 0) {
      const sx = state.w / prevW;
      const su = prevUnit > 0 ? (state.unit / prevUnit) : 1;
      for (const o of state.obstacles) {
        o.x *= sx;
        o.w = Math.max(8, o.w * su);
        o.h = Math.max(8, o.h * su);
        o.y = state.floorY - o.h;
      }
    }

    renderBgCacheFn();
  }

  renderBgCacheFn = function renderBgCache() {
    const w = state.w;
    const h = state.h;
    if (w <= 2 || h <= 2) {
      bgCacheReady = false;
      return;
    }

    bgCache.width = w;
    bgCache.height = h;

    // Base fill
    bgCtx.fillStyle = "#090108";
    bgCtx.fillRect(0, 0, w, h);

    if (netherBgReady) {
      const iw = netherBg.naturalWidth || 1920;
      const ih = netherBg.naturalHeight || 1080;
      const scale = Math.max(w / iw, h / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      bgCtx.drawImage(netherBg, dx, dy, dw, dh);
      bgCacheReady = true;
    } else {
      // Fallback nether gradient.
      const g = bgCtx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#24040a");
      g.addColorStop(0.65, "#0f0208");
      g.addColorStop(1, "#06010a");
      bgCtx.fillStyle = g;
      bgCtx.fillRect(0, 0, w, h);
      bgCacheReady = true;
    }

    // Vignette
    const vg = bgCtx.createRadialGradient(w * 0.5, h * 0.25, Math.min(w, h) * 0.12, w * 0.5, h * 0.35, Math.max(w, h) * 0.9);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.38)");
    bgCtx.fillStyle = vg;
    bgCtx.fillRect(0, 0, w, h);
  };

  function resetRun() {
    state.running = false;
    state.dead = false;
    state.t = 0;
    state.score = 0;
    state.speed = 430;
    state.obstacles = [];
    state.nextSpawn = 0.6;
    state.coyote = 0;
    state.chain = 0;
    state.doubleCooldown = 0;
    state.tallCooldown = 0;
    state.lastWasDouble = false;

    player.vy = 0;
    player.onGround = true;
    player.rot = 0;
    player.jumpsLeft = player.maxJumps;
    player.y = state.floorY - player.h;

    if (els.score) els.score.textContent = "0";
  }

  function startRun() {
    resetRun();
    state.running = true;
    hideOverlay();
    startMusic();
  }

  function endRun() {
    state.running = false;
    state.dead = true;
    stopMusic();
    playDieSfx();
    setOverlay("dead");
    if (state.score > state.best) {
      state.best = state.score;
      if (els.best) els.best.textContent = String(state.best);
      saveBest();
      showToast("UUSI PARAS! " + state.best);
    }
  }

  function jump() {
    if (!state.running) return;
    const fromGround = player.onGround || state.coyote > 0;
    if (fromGround) {
      player.jumpsLeft = player.maxJumps;
    }
    if (player.jumpsLeft <= 0) return;

    player.jumpsLeft -= 1;
    player.vy = -state.jumpV;
    player.onGround = false;
    state.coyote = 0;
  }

  function spawnObstacle() {
    const floorY = state.floorY;
    const base = state.unit;
    const typeRoll = Math.random();

    const jumpH = (state.jumpV * state.jumpV) / (2 * state.gravity);
    const maxSingle = Math.max(base * 2, Math.floor(jumpH * 0.92));

    const isBlock = typeRoll > 0.74;
    let w = base * 2;
    let height = base * 2;

    if (isBlock) {
      // Sometimes spawn a "needs double jump" tower.
      const canTower = state.tallCooldown === 0 && state.chain < 4;
      const makeTower = canTower && Math.random() < 0.42;
      if (makeTower) {
        // Guaranteed: one jump cannot clear (height > jumpH), but double jump can (height < 2*jumpH).
        const minH = Math.floor(jumpH * 1.20);
        const maxH = Math.floor(jumpH * 1.68);
        const span = Math.max(1, maxH - minH);
        height = minH + Math.floor(Math.random() * span);
        height = Math.min(floorY - 12, height);
        w = Math.floor(base * 2.4);
      } else {
        // Normal blocks.
        const r = Math.random();
        const mul = (r < 0.52) ? 2 : (r < 0.84) ? 3 : 4;
        height = Math.min(floorY - 12, base * mul);
        // Keep normal blocks single-jumpable.
        height = Math.min(height, maxSingle);
        if (mul >= 3) w = Math.floor(base * 2.35);
      }
    } else {
      // Spikes are usually small, sometimes tall.
      const r = Math.random();
      const mul = (r < 0.90) ? 2 : 3;
      height = Math.min(floorY - 12, base * mul);
      height = Math.min(height, maxSingle);
      if (mul >= 3) w = Math.floor(base * 2.2);
    }

    const obs = {
      x: state.w + 40,
      w,
      h: height,
      y: floorY - height,
      type: isBlock ? "block" : "spike",
    };

    // If obstacle is higher than one-jump height, it needs double-jump.
    const needsDouble = height > jumpH * 1.02;
    const canDouble = !isBlock && !needsDouble && state.doubleCooldown === 0 && state.chain < 2;
    const makeDouble = canDouble && Math.random() > 0.84;
    if (makeDouble) {
      state.obstacles.push(obs);
      state.obstacles.push({
        ...obs,
        x: obs.x + obs.w + Math.max(10, base * 0.25),
      });
      return { double: true, needsDouble: false };
    }

    state.obstacles.push(obs);
    return { double: false, needsDouble };
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function playerRect() {
    const pad = Math.max(3, Math.floor(player.w * 0.14));
    return {
      x: player.x + pad,
      y: player.y + pad,
      w: player.w - pad * 2,
      h: player.h - pad * 2,
    };
  }

  function obstacleRect(o) {
    if (o.type === "spike") {
      const pad = Math.max(4, Math.floor(o.w * 0.22));
      return {
        x: o.x + pad,
        y: o.y + Math.floor(o.h * 0.18),
        w: o.w - pad * 2,
        h: o.h - Math.floor(o.h * 0.18),
      };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  function update(dt) {
    if (!state.running) return;

    state.t += dt;
    state.speed = Math.min(state.speedMax, state.speed + state.speedRamp * dt);
    state.score = Math.max(0, Math.floor(state.t * 10));
    if (els.score) els.score.textContent = String(state.score);

    if (!player.onGround) {
      player.vy += state.gravity * dt;
      player.y += player.vy * dt;
      player.rot += dt * 11.2;
      state.coyote = Math.max(0, state.coyote - dt);
    }

    const floorTop = state.floorY;
    if (player.y >= floorTop - player.h) {
      player.y = floorTop - player.h;
      player.vy = 0;
      if (!player.onGround) {
        player.onGround = true;
        player.rot = 0;
      }
      player.jumpsLeft = player.maxJumps;
      state.coyote = state.coyoteMax;
    } else {
      player.onGround = false;
    }

    state.nextSpawn -= dt;
    if (state.nextSpawn <= 0) {
      const spawned = spawnObstacle() || { double: false, needsDouble: false };

      // Count consecutive spawns; double counts as "harder".
      state.chain += spawned.double ? 2 : 1;
      state.lastWasDouble = spawned.double;
      if (spawned.double) state.doubleCooldown = 3;
      else state.doubleCooldown = Math.max(0, state.doubleCooldown - 1);

      if (spawned.needsDouble) state.tallCooldown = 2;
      else state.tallCooldown = Math.max(0, state.tallCooldown - 1);

      // Pick next spawn time with mandatory breathing room.
      const baseMin = 0.92;
      const baseMax = 1.55;
      const baseTime = baseMin + Math.random() * (baseMax - baseMin);

      // Difficulty ramps mostly by speed, but keep time gaps kid-friendly.
      const harder = Math.min(0.18, (state.speed - 430) / 3000);
      let next = Math.max(0.78, baseTime - harder);

      // After a double obstacle, always give extra space.
      if (spawned.double) next += 0.42;

      // After a tall obstacle, give a bit more breathing room.
      if (spawned.needsDouble) next += 0.36;

      // Force a rest after a few in a row.
      if (state.chain >= 5) {
        next += 0.75;
        state.chain = 0;
      }

      // Random rest sometimes (feels less "spammy").
      if (Math.random() < 0.16) next += 0.55;

      state.nextSpawn = next;
    }

    for (const o of state.obstacles) {
      o.x -= state.speed * dt;
    }
    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -40);

    const pr = playerRect();
    for (const o of state.obstacles) {
      if (rectsOverlap(pr, obstacleRect(o))) {
        endRun();
        break;
      }
    }
  }

  function drawBackground() {
    const w = state.w;
    const h = state.h;
    const t = state.t;

    if (bgCacheReady) {
      ctx.drawImage(bgCache, 0, 0);
    } else {
      ctx.fillStyle = "#090108";
      ctx.fillRect(0, 0, w, h);
    }

    // Floating embers.
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#ffb14a";
    const count = 18;
    for (let i = 0; i < count; i += 1) {
      const px = (i * 137 + (t * 42)) % (w + 80) - 40;
      const py = ((i * 89 + (t * 28)) % (h * 0.72)) + 18;
      const r = 1.4 + (i % 3) * 0.55;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloor() {
    const w = state.w;
    const floorY = state.floorY;
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, floorY, w, state.floorH);

    ctx.strokeStyle = "rgba(233, 246, 255, 0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, floorY + 1);
    ctx.lineTo(w, floorY + 1);
    ctx.stroke();

    const t = state.t;
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "rgba(124, 242, 154, 0.85)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i += 1) {
      const y = floorY + 16 + i * 10;
      const len = 42 + i * 12;
      const x0 = (w - ((t * (140 + i * 30)) % (w + len))) - len;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + len, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawObstacle(o) {
    if (o.type === "block") {
      ctx.fillStyle = "rgba(92, 214, 255, 0.18)";
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = "rgba(233, 246, 255, 0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
      return;
    }

    ctx.fillStyle = "rgba(255, 221, 102, 0.92)";
    ctx.beginPath();
    ctx.moveTo(o.x, o.y + o.h);
    ctx.lineTo(o.x + o.w / 2, o.y);
    ctx.lineTo(o.x + o.w, o.y + o.h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawPlayer() {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.onGround ? 0 : player.rot);
    ctx.translate(-cx, -cy);

    const grd = ctx.createLinearGradient(player.x, player.y, player.x + player.w, player.y + player.h);
    grd.addColorStop(0, "rgba(124, 242, 154, 0.92)");
    grd.addColorStop(1, "rgba(92, 214, 255, 0.86)");
    ctx.fillStyle = grd;
    ctx.fillRect(player.x, player.y, player.w, player.h);

    ctx.strokeStyle = "rgba(6, 8, 19, 0.55)";
    ctx.lineWidth = 3;
    ctx.strokeRect(player.x + 1.5, player.y + 1.5, player.w - 3, player.h - 3);

    ctx.fillStyle = "rgba(6, 8, 19, 0.75)";
    {
      const eye = Math.max(3, Math.floor(player.w * 0.14));
      const eyeY = Math.floor(player.h * 0.32);
      const eyeX1 = Math.floor(player.w * 0.28);
      const eyeX2 = Math.floor(player.w * 0.62);
      const mouthW = Math.max(8, Math.floor(player.w * 0.28));
      const mouthH = Math.max(3, Math.floor(player.h * 0.11));
      const mouthX = Math.floor((player.w - mouthW) / 2);
      const mouthY = Math.floor(player.h * 0.64);
      ctx.fillRect(player.x + eyeX1, player.y + eyeY, eye, eye);
      ctx.fillRect(player.x + eyeX2, player.y + eyeY, eye, eye);
      ctx.fillRect(player.x + mouthX, player.y + mouthY, mouthW, mouthH);
    }

    ctx.restore();
  }

  function draw() {
    drawBackground();
    drawFloor();
    for (const o of state.obstacles) drawObstacle(o);
    drawPlayer();

    if (!state.running && !state.dead) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = "rgba(233, 246, 255, 0.9)";
      ctx.font = "12px 'Press Start 2P', monospace";
      ctx.fillText("NAPAUTA / SPACE = HYPPY", 18, 26);
      ctx.globalAlpha = 1;
    }
  }

  let last = 0;
  let acc = 0;
  const FIXED_DT = 1 / 60;
  function frame(ts) {
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;

    // Clamp huge delays (tab background, etc.)
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(0.25, dt);
    acc += dt;

    // Fixed-step update so the game doesn't "slow down" on low FPS.
    let steps = 0;
    while (acc >= FIXED_DT && steps < 8) {
      update(FIXED_DT);
      acc -= FIXED_DT;
      steps += 1;
    }
    if (steps >= 8) acc = 0;

    draw();
    requestAnimationFrame(frame);
  }

  function bindControls() {
    const startOrJump = (e) => {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (!state.running) {
        // Mobile UX: first tap starts AND jumps, so tuplahyppy onnistuu kahdella tapilla.
        startRun();
        jump();
        return;
      }
      jump();
    };

    const onKey = (e) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        startOrJump(e);
      }
      if (e.code === "KeyR") {
        if (state.dead) startRun();
      }
    };

    window.addEventListener("keydown", onKey, { passive: false });

    // Prefer Pointer Events (covers touch + mouse). Fallback if not supported.
    if (window.PointerEvent) {
      canvas.addEventListener("pointerdown", startOrJump, { passive: false });
    } else {
      canvas.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          startOrJump(e);
        },
        { passive: false }
      );
      canvas.addEventListener("mousedown", startOrJump);
    }

    if (els.jumpBtn) els.jumpBtn.addEventListener("click", startOrJump);

    // Buttons should start without forcing a jump.
    if (els.startBtn) els.startBtn.addEventListener("click", () => startRun());
    if (els.restartBtn) els.restartBtn.addEventListener("click", () => startRun());

    if (els.resetBestBtn) {
      els.resetBestBtn.addEventListener("click", () => {
        const ok = window.confirm("Nollataanko paras tulos? Tata ei voi perua.");
        if (!ok) return;
        state.best = 0;
        saveBest();
        if (els.best) els.best.textContent = "0";
        showToast("Paras nollattu!");
      });
    }

    if (els.audioBtn) {
      updateAudioButton();
      els.audioBtn.addEventListener("click", async () => {
        audio.enabled = !audio.enabled;
        saveBool(AUDIO_KEY, audio.enabled);
        updateAudioButton();
        if (!audio.enabled) {
          stopMusic();
          showToast("Aani pois");
          return;
        }
        await resumeAudio();
        showToast("Aani paalle");
        if (state.running) startMusic();
      });
    }

    const isFs = () => {
      return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    };

    const updateFsButton = () => {
      if (!els.fullscreenBtn) return;
      els.fullscreenBtn.textContent = isFs() ? "Poistu" : "Taysnaytto";
    };

    const exitFs = async () => {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch {
        /* ignore */
      }
    };

    const requestFs = async () => {
      const el = els.gameArea || els.canvas;
      if (!el) return;
      try {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        else showToast("Taysnaytto ei toimi tassa selaimessa");
      } catch {
        showToast("Taysnaytto ei toimi tassa selaimessa");
      }
    };

    if (els.fullscreenBtn) {
      updateFsButton();
      els.fullscreenBtn.addEventListener("click", async () => {
        if (isFs()) await exitFs();
        else await requestFs();
        window.setTimeout(() => {
          resize();
          updateFsButton();
        }, 80);
      });
    }

    document.addEventListener("fullscreenchange", () => {
      updateFsButton();
      window.setTimeout(() => {
        resize();
      }, 60);
    });
    document.addEventListener("webkitfullscreenchange", () => {
      updateFsButton();
      window.setTimeout(() => {
        resize();
      }, 60);
    });

    if (els.overlay) {
      els.overlay.addEventListener("pointerdown", (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        startOrJump(e);
      });
    }
  }

  function init() {
    loadBest();
    updateAudioButton();
    resize();
    resetRun();
    setOverlay("ready");
    bindControls();
    requestAnimationFrame(frame);

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resize();
      }, 60);
    });
  }

  return { init };
}

function main() {
  wireComingSoonLinks();
  const game = createGame();
  if (game) game.init();
}

main();
