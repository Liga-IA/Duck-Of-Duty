/**
 * game.js — Duck Shooting Game Logic (v3 — with snap-to-target)
 *
 * Changes over v2:
 *  - Snap-to-target: magnetic attraction to nearest duck
 *  - Reduced DUCK_HIT_RADIUS (350 → 150) — precision improvement allows it
 *  - Visual highlight on nearest duck when in snap range
 *  - findNearestDuck() helper
 */

const Game = (() => {
  const MAX_AMMO = 7;
  const GAME_DURATION_S = 60;
  const DUCK_HIT_RADIUS = 150;      // Reduced from 350 — better precision now
  const DUCKS_PER_ROW = 4;
  const NUM_ROWS = 3;

  // Snap-to-target config
  const SNAP_RADIUS = 250;          // px: generous snap range for eye tracking
  const SNAP_STRENGTH = 0.30;       // Strong pull toward duck center

  // State
  let ammo = MAX_AMMO;
  let score = 0;
  let missedShots = 0;
  let totalShots = 0;
  let timeLeft = GAME_DURATION_S;
  let timerInterval = null;
  let isRunning = false;
  let actionLock = false;
  let ducks = [];

  // Currently highlighted duck (for snap visual)
  let highlightedDuck = null;

  // DOM refs
  let crosshair = null;
  let shotFlash = null;
  let reloadWarning = null;
  let hudAmmo = null;
  let hudScore = null;
  let hudTimer = null;
  let notification = null;
  let gameScreen = null;

  // Audio context
  let audioCtx = null;

  // Callbacks
  let onGameEnd = null;

  function init() {
    crosshair = document.getElementById('crosshair');
    shotFlash = document.getElementById('shot-flash');
    reloadWarning = document.getElementById('reload-warning');
    hudScore = document.getElementById('hud-score');
    hudTimer = document.getElementById('hud-timer');
    notification = document.getElementById('notification');
    gameScreen = document.getElementById('game-screen');

    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    createDucks();
    createAmmoDisplay();
  }

  function createDucks() {
    ducks = [];

    for (let row = 0; row < NUM_ROWS; row++) {
      const rowEl = document.getElementById(`duck-row-${row + 1}`);
      if (!rowEl) continue;
      rowEl.innerHTML = '';

      for (let col = 0; col < DUCKS_PER_ROW; col++) {
        const duck = document.createElement('img');
        duck.src = 'assets/duck.png';
        duck.className = 'duck-target';
        duck.alt = 'Pato alvo';
        duck.id = `duck-${row}-${col}`;
        duck.draggable = false;
        rowEl.appendChild(duck);

        ducks.push({
          element: duck,
          row,
          col,
          alive: true
        });
      }
    }
  }

  function createAmmoDisplay() {
    hudAmmo = document.getElementById('ammo-container');
    if (!hudAmmo) return;
    hudAmmo.innerHTML = '';

    for (let i = 0; i < MAX_AMMO; i++) {
      const bullet = document.createElement('div');
      bullet.className = 'bullet';
      bullet.id = `bullet-${i}`;
      hudAmmo.appendChild(bullet);
    }
  }

  function start() {
    ammo = MAX_AMMO;
    score = 0;
    missedShots = 0;
    totalShots = 0;
    timeLeft = GAME_DURATION_S;
    isRunning = true;
    highlightedDuck = null;

    ducks.forEach(d => {
      d.alive = true;
      d.element.classList.remove('hit');
      d.element.style.opacity = '1';
      d.element.style.pointerEvents = 'auto';
      d.element.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))';
    });

    updateHUD();
    updateAmmoDisplay();

    timerInterval = setInterval(() => {
      timeLeft--;
      updateHUD();
      if (timeLeft <= 0) endGame();
    }, 1000);

    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    showNotification('COMEÇAR!');
  }

  function endGame() {
    isRunning = false;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    // Clear highlight
    clearHighlight();
    hideReloadWarning();

    if (onGameEnd) {
      onGameEnd({
        score,
        missedShots,
        totalShots,
        totalDucks: ducks.length,
        timeLeft
      });
    }
  }

  // ==========================================
  // Snap-to-Target
  // ==========================================

  /**
   * Find the nearest alive duck to the given screen position.
   * Returns { duck, dist, centerX, centerY } or null if none alive.
   */
  function findNearestDuck(x, y) {
    let nearest = null;
    let nearestDist = Infinity;
    let nearestCX = 0, nearestCY = 0;

    for (const duck of ducks) {
      if (!duck.alive) continue;

      const rect = duck.element.getBoundingClientRect();
      const duckCX = rect.left + rect.width / 2;
      const duckCY = rect.top + rect.height / 2;
      const d = Math.sqrt((x - duckCX) ** 2 + (y - duckCY) ** 2);

      if (d < nearestDist) {
        nearestDist = d;
        nearest = duck;
        nearestCX = duckCX;
        nearestCY = duckCY;
      }
    }

    if (!nearest) return null;
    return { duck: nearest, dist: nearestDist, centerX: nearestCX, centerY: nearestCY };
  }

  /**
   * Apply snap-to-target magnetic attraction.
   * Returns adjusted { x, y }.
   */
  function applySnap(x, y) {
    const result = findNearestDuck(x, y);
    if (!result) return { x, y };

    // Clear previous highlight
    clearHighlight();

    if (result.dist < SNAP_RADIUS) {
      // Quadratic falloff: strength increases as you get closer
      const t = 1 - (result.dist / SNAP_RADIUS);
      const strength = t * t * SNAP_STRENGTH;

      x += (result.centerX - x) * strength;
      y += (result.centerY - y) * strength;

      // Highlight the target duck
      setHighlight(result.duck);
    }

    return { x, y };
  }

  function setHighlight(duck) {
    if (highlightedDuck === duck) return;

    clearHighlight();
    highlightedDuck = duck;
    duck.element.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.6)) drop-shadow(0 0 12px rgba(255, 215, 0, 0.6))';
  }

  function clearHighlight() {
    if (highlightedDuck) {
      highlightedDuck.element.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))';
      highlightedDuck = null;
    }
  }

  // ==========================================
  // Shoot
  // ==========================================
  function shoot() {
    if (!isRunning || actionLock) return;
    actionLock = true;

    if (ammo <= 0) {
      showReloadWarning();
      console.log('[Game] Sem munição! Pisque o olho esquerdo para recarregar.');
      actionLock = false;
      return;
    }

    ammo--;
    totalShots++;
    updateAmmoDisplay();

    if (shotFlash) {
      shotFlash.classList.remove('firing');
      void shotFlash.offsetWidth;
      shotFlash.classList.add('firing');
    }

    // Get crosshair position
    const cx = parseFloat(crosshair.style.left) || window.innerWidth / 2;
    const cy = parseFloat(crosshair.style.top) || window.innerHeight / 2;

    // Check hit
    let hitAny = false;
    for (const duck of ducks) {
      if (!duck.alive) continue;

      const rect = duck.element.getBoundingClientRect();
      const duckCX = rect.left + rect.width / 2;
      const duckCY = rect.top + rect.height / 2;

      const d = Math.sqrt((cx - duckCX) ** 2 + (cy - duckCY) ** 2);

      if (d < DUCK_HIT_RADIUS) {
        duck.alive = false;
        duck.element.classList.add('hit');
        score++;
        hitAny = true;

        showQuackText(rect);
        playQuackSound();
        showNotification('+1 🎯');
        break;
      }
    }

    if (!hitAny) {
      missedShots++;
    }

    updateHUD();

    if (ammo <= 0) {
      showReloadWarning();
    }

    actionLock = false;

    const aliveDucks = ducks.filter(d => d.alive);
    if (aliveDucks.length === 0) {
      setTimeout(() => respawnDucks(), 1000);
    }
  }

  function showQuackText(duckRect) {
    const quack = document.createElement('div');
    quack.className = 'quack-text';
    quack.textContent = 'QUACK!';
    quack.style.left = `${duckRect.right + 5}px`;
    quack.style.top = `${duckRect.top}px`;

    if (gameScreen) {
      gameScreen.appendChild(quack);
      setTimeout(() => {
        if (quack.parentNode) quack.parentNode.removeChild(quack);
      }, 1200);
    }
  }

  function playQuackSound() {
    if (!audioCtx) return;

    try {
      const now = audioCtx.currentTime;
      const duration = 0.25;

      const osc = audioCtx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.06);
      osc.frequency.exponentialRampToValueAtTime(350, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(200, now + duration);

      const osc2 = audioCtx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(400, now);
      osc2.frequency.exponentialRampToValueAtTime(140, now + 0.06);
      osc2.frequency.exponentialRampToValueAtTime(175, now + 0.12);
      osc2.frequency.exponentialRampToValueAtTime(100, now + duration);

      const bufferSize = audioCtx.sampleRate * duration;
      const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        noiseData[i] = (Math.random() * 2 - 1) * 0.15;
      }
      const noise = audioCtx.createBufferSource();
      noise.buffer = noiseBuffer;

      const gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.25, now + 0.02);
      gainNode.gain.linearRampToValueAtTime(0.18, now + 0.08);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

      const gain2 = audioCtx.createGain();
      gain2.gain.setValueAtTime(0.08, now);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + duration);

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(600, now);
      filter.Q.setValueAtTime(2, now);

      osc.connect(filter);
      osc2.connect(gain2);
      gain2.connect(filter);
      noise.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      osc.start(now);
      osc2.start(now);
      noise.start(now);
      osc.stop(now + duration);
      osc2.stop(now + duration);
      noise.stop(now + duration);
    } catch (e) {
      console.warn('Could not play quack sound:', e);
    }
  }

  function reload() {
    if (!isRunning || actionLock) return;
    actionLock = true;

    ammo = MAX_AMMO;
    updateAmmoDisplay();
    hideReloadWarning();
    showNotification('RECARREGADO! 🔫');
    console.log('[Game] Recarregado! Munição: 7');

    actionLock = false;
  }

  function respawnDucks() {
    if (!isRunning) return;

    ducks.forEach(d => {
      d.alive = true;
      d.element.classList.remove('hit');
      d.element.style.opacity = '1';
      d.element.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))';
    });

    showNotification('NOVOS PATOS! 🦆');
  }

  /**
   * Move crosshair to position — with snap-to-target applied
   */
  function moveCrosshair(x, y) {
    if (!crosshair) return;

    // Apply snap-to-target (magnetic attraction to nearest duck)
    const snapped = applySnap(x, y);

    crosshair.style.left = `${snapped.x}px`;
    crosshair.style.top = `${snapped.y}px`;
  }

  function updateHUD() {
    if (hudScore) hudScore.textContent = score;
    if (hudTimer) {
      const mins = Math.floor(timeLeft / 60);
      const secs = timeLeft % 60;
      hudTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }

  function updateAmmoDisplay() {
    if (!hudAmmo) return;
    const bullets = hudAmmo.querySelectorAll('.bullet');
    bullets.forEach((b, i) => {
      if (i < ammo) {
        b.classList.remove('spent');
      } else {
        b.classList.add('spent');
      }
    });
  }

  function showNotification(text) {
    if (!notification) return;
    notification.textContent = text;
    notification.classList.remove('show');
    void notification.offsetWidth;
    notification.classList.add('show');
  }

  function showReloadWarning() {
    if (reloadWarning) reloadWarning.classList.add('visible');
  }

  function hideReloadWarning() {
    if (reloadWarning) reloadWarning.classList.remove('visible');
  }

  function getResults() {
    return { score, missedShots, totalShots, totalDucks: ducks.length };
  }

  return {
    init,
    start,
    shoot,
    reload,
    moveCrosshair,
    endGame,
    getResults,
    get isRunning() { return isRunning; },
    set onGameEnd(fn) { onGameEnd = fn; }
  };
})();
