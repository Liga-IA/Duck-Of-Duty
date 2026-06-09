/**
 * main.js — Main Controller (v2 — with distance feedback)
 * 
 * Manages the flow between screens:
 *  Start → Calibration → Game → Results
 * 
 * Wires up EyeTracker, Calibration, and Game modules.
 * Includes distance feedback to guide user positioning.
 */

(async function Main() {
  // ==========================================
  // DOM References
  // ==========================================
  const screens = {
    start: document.getElementById('start-screen'),
    calibration: document.getElementById('calibration-screen'),
    game: document.getElementById('game-screen'),
    results: document.getElementById('results-screen')
  };

  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const btnStart = document.getElementById('btn-start');
  const btnCalibrate = document.getElementById('btn-calibrate');
  const faceGuide = document.getElementById('face-guide');
  const btnRestart = document.getElementById('btn-restart');
  const video = document.getElementById('webcam-video');
  const webcamPreview = document.getElementById('webcam-preview-video');

  // Results elements
  const resultScore = document.getElementById('result-score');
  const resultMissed = document.getElementById('result-missed');
  const resultTotal = document.getElementById('result-total');
  const resultAccuracy = document.getElementById('result-accuracy');

  // Distance feedback elements
  const distanceFeedbackGame = document.getElementById('distance-feedback-game');
  const distanceIconGame = document.getElementById('distance-icon-game');
  const distanceTextGame = document.getElementById('distance-text-game');

  let currentDistanceStatus = 'unknown';

  // ==========================================
  // Screen Management
  // ==========================================
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    if (screens[name]) screens[name].classList.add('active');
  }

  function showLoading(text) {
    loadingText.textContent = text || 'Carregando...';
    loadingOverlay.classList.remove('hidden');
  }

  function hideLoading() {
    loadingOverlay.classList.add('hidden');
  }

  // ==========================================
  // Distance Feedback UI
  // ==========================================
  function updateDistanceUI(status) {
    const messages = {
      too_close: { icon: '🔴', text: 'Muito perto! Afaste-se da câmera', cls: 'distance-bad' },
      too_far:   { icon: '🔴', text: 'Muito longe! Aproxime-se da câmera', cls: 'distance-bad' },
      good:      { icon: '🟢', text: 'Distância ideal ✓', cls: 'distance-good' }
    };

    const msg = messages[status] || messages.good;

    // Update calibration screen indicator
    if (faceGuide && status === 'good') {
      faceGuide.className = 'face-guide guide-green';
      btnCalibrate.style.opacity = '1';
      btnCalibrate.style.cursor = 'pointer';
      btnCalibrate.textContent = 'Iniciar Calibração';
    } else if (faceGuide) {
      faceGuide.className = 'face-guide guide-red';
      btnCalibrate.style.opacity = '0.5';
      btnCalibrate.style.cursor = 'not-allowed';
      btnCalibrate.textContent = 'Aguardando Posicionamento...';
    }

    // Update game screen indicator
    if (distanceFeedbackGame) {
      distanceIconGame.textContent = msg.icon;
      distanceTextGame.textContent = msg.text;
      distanceFeedbackGame.className = `distance-feedback distance-feedback-game ${msg.cls}`;

      // In game, only show when NOT good (to avoid distraction)
      if (status === 'good') {
        distanceFeedbackGame.style.opacity = '0';
      } else {
        distanceFeedbackGame.style.opacity = '1';
      }
    }
  }

  // ==========================================
  // Generate Stars for background
  // ==========================================
  function generateStars(container, count = 50) {
    const starsDiv = container.querySelector('.stars') || document.createElement('div');
    starsDiv.className = 'stars';
    starsDiv.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 100}%`;
      star.style.animationDelay = `${Math.random() * 3}s`;
      star.style.width = `${1 + Math.random() * 3}px`;
      star.style.height = star.style.width;
      starsDiv.appendChild(star);
    }
    if (!container.querySelector('.stars')) container.appendChild(starsDiv);
  }

  // ==========================================
  // Generate carnival lights
  // ==========================================
  function generateLights() {
    const lightsContainer = document.querySelector('.carnival-lights');
    if (lightsContainer) {
      lightsContainer.innerHTML = '';
      const count = Math.floor(window.innerWidth / 30);
      for (let i = 0; i < count; i++) {
        const bulb = document.createElement('div');
        bulb.className = 'bulb';
        lightsContainer.appendChild(bulb);
      }
    }

    const gameLights = document.querySelector('.game-lights');
    if (gameLights) {
      gameLights.innerHTML = '';
      const count = Math.floor(window.innerWidth / 40);
      for (let i = 0; i < count; i++) {
        const bulb = document.createElement('div');
        bulb.className = 'game-bulb';
        gameLights.appendChild(bulb);
      }
    }
  }

  // ==========================================
  // INIT
  // ==========================================
  showScreen('start');
  generateStars(screens.start);
  generateStars(screens.results);
  generateLights();

  // ==========================================
  // START SCREEN
  // ==========================================
  btnStart.addEventListener('click', async () => {
    showLoading('Inicializando câmera e IA...');

    try {
      await EyeTracker.init(video);
      await EyeTracker.startCamera();

      // Show webcam preview in calibration
      if (webcamPreview) {
        webcamPreview.srcObject = video.srcObject;
        webcamPreview.play();
      }

      // Wire up distance feedback (active during all screens with tracking)
      EyeTracker.onDistanceFeedback = (status) => {
        currentDistanceStatus = status;
        updateDistanceUI(status);
      };

      hideLoading();
      showScreen('calibration');
      EyeTracker.startTracking(); // Iniciar o rastreamento imediatamente para avaliar a distância
    } catch (err) {
      console.error('Erro ao inicializar:', err);
      hideLoading();
      alert('Erro ao acessar a câmera ou carregar a IA. Verifique as permissões e tente novamente.\n\nErro: ' + err.message);
    }
  });

  // ==========================================
  // CALIBRATION SCREEN
  // ==========================================
  btnCalibrate.addEventListener('click', () => {
    if (currentDistanceStatus !== 'good') {
      alert('Por favor, ajuste seu rosto e ombros dentro da linha pontilhada no vídeo. Ela ficará verde quando a posição estiver validada!');
      return;
    }

    const instructions = document.querySelector('.calibration-instructions');
    // Sumir com a camera ao começar
    const webcamContainer = document.getElementById('webcam-preview-container');
    if (webcamContainer) webcamContainer.style.display = 'none';

    if (instructions) instructions.style.display = 'none';

    const statusEl = document.getElementById('calibration-status');
    const progressBarEl = document.getElementById('calibration-progress-bar');

    Calibration.init(screens.calibration, statusEl, progressBarEl);

    // Connect eye tracker raw gaze and raw ears to calibration
    EyeTracker.onRawGaze = (gx, gy) => {
      if (Calibration.isCalibrating) {
        Calibration.addSample(gx, gy);
      }
    };

    // On calibration complete
    Calibration.onComplete = (coeffs) => {
      if (!coeffs) {
        const instructions = document.querySelector('.calibration-instructions');
        if (instructions) instructions.style.display = 'flex';
        Calibration.reset();
        alert('Calibração falhou. Certifique-se de que há boa iluminação e que seu rosto está visível. Tente novamente.');
        return;
      }

      EyeTracker.setCalibration(coeffs);

      setTimeout(() => {
        startGame();
      }, 500);
    };

    // Start tracking for calibration (this also begins adaptive blink baseline)
    Calibration.start();
  });

  // ==========================================
  // GAME
  // ==========================================
  function startGame() {
    showScreen('game');

    Game.init();
    Game.start();

    // Enable debug overlay to visualize gaze tracking
    EyeTracker.enableDebug();

    // Connect eye tracker to game
    let gazeCount = 0;
    EyeTracker.onGazeUpdate = (x, y) => {
      gazeCount++;
      if (gazeCount % 30 === 1) {
        console.log(`[Game] Gaze #${gazeCount}: x=${x.toFixed(0)}, y=${y.toFixed(0)}`);
      }
      Game.moveCrosshair(x, y);
    };

    EyeTracker.onRightBlink = () => {
      console.log('[Game] RIGHT BLINK → shoot()');
      Game.shoot();
    };

    EyeTracker.onLeftBlink = () => {
      console.log('[Game] LEFT BLINK → reload()');
      Game.reload();
    };

    // Handle game end
    Game.onGameEnd = (results) => {
      EyeTracker.disableDebug();
      showResults(results);
    };
  }

  // ==========================================
  // RESULTS SCREEN
  // ==========================================
  function showResults(results) {
    EyeTracker.stopTracking();
    showScreen('results');

    if (resultScore) resultScore.textContent = results.score;
    if (resultMissed) resultMissed.textContent = results.missedShots;
    if (resultTotal) resultTotal.textContent = results.totalShots;

    const accuracy = results.totalShots > 0
      ? Math.round((results.score / results.totalShots) * 100)
      : 0;
    if (resultAccuracy) resultAccuracy.textContent = `${accuracy}%`;
  }

  btnRestart.addEventListener('click', () => {
    Calibration.reset();
    showScreen('calibration');

    const instructions = document.querySelector('.calibration-instructions');
    if (instructions) instructions.style.display = 'flex';
    
    const webcamContainer = document.getElementById('webcam-preview-container');
    if (webcamContainer) webcamContainer.style.display = 'block';

    currentDistanceStatus = 'unknown';
    EyeTracker.startTracking(); // Retomar tracking para medir distância novamente
  });

})();
