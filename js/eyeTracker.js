/**
 * eyeTracker.js — Eye Tracking + Blink Detection (MediaPipe FaceMesh)
 *
 * v4 — One Euro Filter + Corrected X-axis
 *
 * Key fixes over v3:
 *  - CRITICAL: X-axis is now INVERTED to compensate for webcam mirroring.
 *    When the user looks right, the iris moves left in camera space — we invert.
 *  - Replaced double-EMA smoothing with One Euro Filter (academic standard)
 *  - Removed dead zone (One Euro Filter absorbs jitter naturally)
 *  - Removed fixation detection (was freezing crosshair prematurely)
 *  - Expanded clamp margins so crosshair can reach screen edges/corners
 *  - Simplified pipeline: Raw Iris → Invert X → Calibration → OneEuroFilter → Output
 */

const EyeTracker = (() => {
  // ==========================================
  // Configuration
  // ==========================================
  const EAR_THRESHOLD = 0.21;
  const BLINK_COOLDOWN_MS = 400;
  const IDEAL_FACE_FRACTION = 0.35;

  // --- One Euro Filter tuning ---
  // These values are tuned for webcam eye tracking at ~30-60fps
  // Para jogabilidade com piscar: mircutoff baixo = mira estável em repouso,
  // beta moderado = ainda se move quando o olhar muda de forma intencional.
  const OEF_FREQ = 30;           // Estimated frame rate from webcam
  const OEF_MINCUTOFF = 0.5;     // Baixo = muito suavização em repouso (reduz tremor)
  const OEF_BETA = 0.6;          // Moderado = responsivo a sacadas, mas não a ruído
  const OEF_DCUTOFF = 1.0;       // Derivative cutoff (usually left at 1.0)

  // Pre-smoothing on raw gaze values (antes da calibração)
  // Valor mais baixo = filtragem mais agressiva antes da calibração amplificar o ruído.
  // 0.25 = a mira move 25% da distância até o alvo por frame (suave, sem travar)
  const RAW_GAZE_SMOOTH = 0.25;  // Mais suave: reduz tremor na fonte

  // Max movement per frame (safety valve for wild jumps)
  const MAX_DELTA_PX = 400;      // Increased: allow fast saccades

  // ==========================================
  // MediaPipe FaceMesh Landmark Indices
  // ==========================================

  // --- Right eye (user's right eye — appears LEFT in camera image) ---
  const RIGHT_EYE_CAM_LEFT = 33;   // Outer/temporal corner — lower x in camera
  const RIGHT_EYE_CAM_RIGHT = 133; // Inner/nasal corner — higher x in camera
  const RIGHT_EYE_TOP = 159;       // Upper eyelid center
  const RIGHT_EYE_BOTTOM = 145;    // Lower eyelid center
  const RIGHT_IRIS_CENTER = 468;   // Iris center

  // EAR landmarks for right eye
  const RIGHT_EYE_UPPER = [159, 145];
  const RIGHT_EYE_UPPER2 = [158, 153];
  const RIGHT_EYE_HORIZ = [33, 133];

  // --- Left eye (user's left eye — appears RIGHT in camera image) ---
  const LEFT_EYE_CAM_LEFT = 362;   // Inner/nasal corner — lower x in camera
  const LEFT_EYE_CAM_RIGHT = 263;  // Outer/temporal corner — higher x in camera
  const LEFT_EYE_TOP = 386;        // Upper eyelid center
  const LEFT_EYE_BOTTOM = 374;     // Lower eyelid center
  const LEFT_IRIS_CENTER = 473;    // Iris center

  // EAR landmarks for left eye
  const LEFT_EYE_UPPER = [386, 374];
  const LEFT_EYE_UPPER2 = [385, 380];
  const LEFT_EYE_HORIZ = [362, 263];

  // ==========================================
  // State
  // ==========================================
  let videoElement = null;
  let faceMesh = null;
  let isTracking = false;
  let animFrameId = null;

  // Calibration coefficients (set after calibration)
  let calibCoeffs = null;

  // One Euro Filters for X and Y (post-calibration screen coordinates)
  let filterX = null;
  let filterY = null;

  // Smoothed gaze position (crosshair output)
  let smoothX = window.innerWidth / 2;
  let smoothY = window.innerHeight / 2;

  // Last valid position (used when frozen during blinks)
  let lastValidX = window.innerWidth / 2;
  let lastValidY = window.innerHeight / 2;

  // Pre-smoothed raw gaze (light EMA before calibration)
  let preSmoothedGazeX = 0.5;
  let preSmoothedGazeY = 0.5;
  let preSmoothedInitialized = false;

  // Blink state
  let prevRightClosed = false;
  let prevLeftClosed = false;
  let lastBlinkActionTime = 0;
  let gazeIsFrozen = false;

  // Debug overlay
  let debugEnabled = false;
  let debugCanvas = null;
  let debugCtx = null;

  // Debug values (exposed for overlay)
  let dbg = {
    relRX: 0, relRY: 0,
    relLX: 0, relLY: 0,
    gazeX: 0, gazeY: 0,
    rawScreenX: 0, rawScreenY: 0,
    filteredX: 0, filteredY: 0,
    frozen: false
  };

  // Callbacks
  let onDistanceFeedback = null;
  let onRawGaze = null;
  let onGazeUpdate = null;
  let onRightBlink = null;
  let onLeftBlink = null;

  // ==========================================
  // Utility
  // ==========================================
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  function clamp01(val) {
    return Math.max(0, Math.min(1, val));
  }

  // ==========================================
  // EAR Calculation
  // ==========================================
  function computeEAR(landmarks, upperPair, upperPair2, horizPair) {
    const v1 = dist(landmarks[upperPair[0]], landmarks[upperPair[1]]);
    const v2 = dist(landmarks[upperPair2[0]], landmarks[upperPair2[1]]);
    const h = dist(landmarks[horizPair[0]], landmarks[horizPair[1]]);
    if (h < 0.0001) return 0.3;
    return (v1 + v2) / (2.0 * h);
  }

  // ==========================================
  // GAZE EXTRACTION — Relative Iris Position
  // ==========================================
  /**
   * Compute gaze as the relative position of each iris center
   * within its eye socket. This isolates eye movement from head movement.
   *
   * CRITICAL FIX (v4): The final gazeX is INVERTED (1.0 - x) to compensate
   * for webcam mirroring. In camera coordinates, looking RIGHT moves the iris
   * LEFT. Without inversion, the crosshair goes in the OPPOSITE direction.
   *
   * For each eye:
   *   relX = (iris.x - camLeftCorner.x) / (camRightCorner.x - camLeftCorner.x)
   *   relY = (iris.y - topLid.y) / (bottomLid.y - topLid.y)
   *
   * Then average both eyes and INVERT X.
   * Result: gazeX, gazeY ∈ [0, 1]
   */
  function computeRawGaze(landmarks) {
    // --- Right eye ---
    const rIris = landmarks[RIGHT_IRIS_CENTER];
    const rLeft = landmarks[RIGHT_EYE_CAM_LEFT];    // landmark 33 — lower x
    const rRight = landmarks[RIGHT_EYE_CAM_RIGHT];  // landmark 133 — higher x
    const rTop = landmarks[RIGHT_EYE_TOP];
    const rBottom = landmarks[RIGHT_EYE_BOTTOM];

    const rEyeWidth = rRight.x - rLeft.x;
    const rEyeHeight = rBottom.y - rTop.y;

    let relRX = 0.5, relRY = 0.5;
    if (Math.abs(rEyeWidth) > 0.001) {
      relRX = (rIris.x - rLeft.x) / rEyeWidth;
    }
    if (Math.abs(rEyeHeight) > 0.001) {
      relRY = (rIris.y - rTop.y) / rEyeHeight;
    }

    // --- Left eye ---
    const lIris = landmarks[LEFT_IRIS_CENTER];
    const lLeft = landmarks[LEFT_EYE_CAM_LEFT];    // landmark 362 — lower x
    const lRight = landmarks[LEFT_EYE_CAM_RIGHT];  // landmark 263 — higher x
    const lTop = landmarks[LEFT_EYE_TOP];
    const lBottom = landmarks[LEFT_EYE_BOTTOM];

    const lEyeWidth = lRight.x - lLeft.x;
    const lEyeHeight = lBottom.y - lTop.y;

    let relLX = 0.5, relLY = 0.5;
    if (Math.abs(lEyeWidth) > 0.001) {
      relLX = (lIris.x - lLeft.x) / lEyeWidth;
    }
    if (Math.abs(lEyeHeight) > 0.001) {
      relLY = (lIris.y - lTop.y) / lEyeHeight;
    }

    // Clamp to [0, 1]
    relRX = clamp01(relRX);
    relRY = clamp01(relRY);
    relLX = clamp01(relLX);
    relLY = clamp01(relLY);

    // Average both eyes
    const avgX = (relRX + relLX) / 2;
    const avgY = (relRY + relLY) / 2;

    // *** CRITICAL FIX: Invert X to compensate for webcam mirroring ***
    // In camera space, looking RIGHT = iris moves LEFT = lower avgX
    // On screen, looking RIGHT should move crosshair RIGHT = higher X
    // So we invert: rawX = 1 - avgX
    const rawX = 1.0 - avgX;
    const rawY = avgY;  // Y is not inverted (looking down = higher Y in both camera and screen)

    // Save debug values
    dbg.relRX = relRX; dbg.relRY = relRY;
    dbg.relLX = relLX; dbg.relLY = relLY;
    dbg.gazeX = rawX; dbg.gazeY = rawY;

    return { rawX, rawY };
  }

  // ==========================================
  // Distance Estimation
  // ==========================================
  function estimateDistance(landmarks) {
    const forehead = landmarks[10];
    const chin = landmarks[152];
    const faceFraction = Math.abs(forehead.y - chin.y);

    if (faceFraction > IDEAL_FACE_FRACTION * 1.5) return 'too_close';
    if (faceFraction < IDEAL_FACE_FRACTION * 0.5) return 'too_far';
    return 'good';
  }

  // ==========================================
  // Apply calibration mapping
  // ==========================================
  /**
   * Maps raw gaze (0–1) to screen coordinates using calibration coefficients.
   * Supports both linear (6-coeff) and quadratic (12-coeff) models.
   */
  function applyCalibration(rawX, rawY) {
    const c = calibCoeffs;

    if (c.isQuadratic) {
      const gx2 = rawX * rawX;
      const gy2 = rawY * rawY;
      const gxy = rawX * rawY;

      const screenX = c.xa * gx2 + c.xb * gy2 + c.xc * gxy + c.xd * rawX + c.xe * rawY + c.xf;
      const screenY = c.ya * gx2 + c.yb * gy2 + c.yc * gxy + c.yd * rawX + c.ye * rawY + c.yf;
      return { screenX, screenY };
    } else {
      const screenX = c.ax * rawX + c.bx * rawY + c.cx;
      const screenY = c.ay * rawX + c.by * rawY + c.cy;
      return { screenX, screenY };
    }
  }

  // ==========================================
  // Core Processing — called each frame
  // ==========================================
  function onResults(results) {
    if (!isTracking) return;
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;

    const landmarks = results.multiFaceLandmarks[0];

    // --- Distance feedback ---
    const distanceStatus = estimateDistance(landmarks);
    if (onDistanceFeedback) onDistanceFeedback(distanceStatus);

    // --- Compute EAR ---
    const rightEAR = computeEAR(landmarks, RIGHT_EYE_UPPER, RIGHT_EYE_UPPER2, RIGHT_EYE_HORIZ);
    const leftEAR = computeEAR(landmarks, LEFT_EYE_UPPER, LEFT_EYE_UPPER2, LEFT_EYE_HORIZ);

    const rightClosed = rightEAR < EAR_THRESHOLD;
    const leftClosed = leftEAR < EAR_THRESHOLD;

    // --- Debug overlay ---
    if (debugEnabled && debugCanvas && debugCtx) {
      drawDebug(rightEAR, leftEAR, rightClosed, leftClosed);
    }

    // ========================================
    // BLINK DETECTION
    // ========================================
    const now = Date.now();
    const cooldownOk = (now - lastBlinkActionTime) >= BLINK_COOLDOWN_MS;

    if (rightClosed && leftClosed) {
      gazeIsFrozen = true;
    } else if (rightClosed && !leftClosed) {
      gazeIsFrozen = true;
      if (!prevRightClosed && cooldownOk) {
        lastBlinkActionTime = now;
        console.log(`[EyeTracker] RIGHT BLINK (EAR: R=${rightEAR.toFixed(3)}, L=${leftEAR.toFixed(3)})`);
        if (onRightBlink) onRightBlink();
      }
    } else if (leftClosed && !rightClosed) {
      gazeIsFrozen = true;
      if (!prevLeftClosed && cooldownOk) {
        lastBlinkActionTime = now;
        console.log(`[EyeTracker] LEFT BLINK (EAR: R=${rightEAR.toFixed(3)}, L=${leftEAR.toFixed(3)})`);
        if (onLeftBlink) onLeftBlink();
      }
    } else {
      gazeIsFrozen = false;
    }

    prevRightClosed = rightClosed;
    prevLeftClosed = leftClosed;

    // ========================================
    // GAZE UPDATE
    // ========================================
    if (!gazeIsFrozen) {
      const { rawX, rawY } = computeRawGaze(landmarks);

      // Send raw gaze for calibration sampling (unfiltered for clean calibration data)
      if (onRawGaze) onRawGaze(rawX, rawY);

      // Apply calibration if available
      if (calibCoeffs) {
        // --- PRE-SMOOTHING: Light EMA on raw 0-1 gaze BEFORE calibration ---
        // Calibration amplifies noise, so we dampen the worst jitter at the source.
        if (!preSmoothedInitialized) {
          preSmoothedGazeX = rawX;
          preSmoothedGazeY = rawY;
          preSmoothedInitialized = true;
        }
        preSmoothedGazeX += (rawX - preSmoothedGazeX) * RAW_GAZE_SMOOTH;
        preSmoothedGazeY += (rawY - preSmoothedGazeY) * RAW_GAZE_SMOOTH;

        let { screenX, screenY } = applyCalibration(preSmoothedGazeX, preSmoothedGazeY);

        // Save raw screen position for debug
        dbg.rawScreenX = screenX;
        dbg.rawScreenY = screenY;

        // --- Safety clamp: reject wild jumps ---
        const dx = screenX - lastValidX;
        const dy = screenY - lastValidY;
        const jumpDist = Math.sqrt(dx * dx + dy * dy);
        if (jumpDist > MAX_DELTA_PX) {
          // Clamp to max delta in the direction of movement
          const scale = MAX_DELTA_PX / jumpDist;
          screenX = lastValidX + dx * scale;
          screenY = lastValidY + dy * scale;
        }

        // --- One Euro Filter (post-calibration) ---
        const timestamp = performance.now() / 1000; // seconds
        if (filterX && filterY) {
          screenX = filterX.filter(screenX, timestamp);
          screenY = filterY.filter(screenY, timestamp);
        }

        // Save filtered position for debug
        dbg.filteredX = screenX;
        dbg.filteredY = screenY;

        // --- Final clamp: allow slight overshoot so edges are reachable ---
        // We allow going to -10 / +10 beyond screen, then visual clamp in CSS
        smoothX = Math.max(-10, Math.min(window.innerWidth + 10, screenX));
        smoothY = Math.max(-10, Math.min(window.innerHeight + 10, screenY));

        lastValidX = smoothX;
        lastValidY = smoothY;

        if (onGazeUpdate) onGazeUpdate(smoothX, smoothY);
      }
    }

    dbg.frozen = gazeIsFrozen;
  }

  // ==========================================
  // Debug Overlay
  // ==========================================
  function drawDebug(rightEAR, leftEAR, rightClosed, leftClosed) {
    if (!debugCtx || !debugCanvas) return;

    const ctx = debugCtx;
    const w = debugCanvas.width;
    const h = debugCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px monospace';

    let y = 14;
    const line = (color, text) => {
      ctx.fillStyle = color;
      ctx.fillText(text, 8, y);
      y += 14;
    };

    // EAR
    line(rightClosed ? '#ff4444' : '#44ff44',
      `R-EAR: ${rightEAR.toFixed(3)} ${rightClosed ? 'CLOSED' : 'OPEN'}`);
    line(leftClosed ? '#ff4444' : '#44ff44',
      `L-EAR: ${leftEAR.toFixed(3)} ${leftClosed ? 'CLOSED' : 'OPEN'}`);

    // Relative iris
    line('#88bbff',
      `RelR: X=${dbg.relRX.toFixed(3)} Y=${dbg.relRY.toFixed(3)}`);
    line('#88bbff',
      `RelL: X=${dbg.relLX.toFixed(3)} Y=${dbg.relLY.toFixed(3)}`);

    // Averaged gaze (after X inversion)
    line('#ffdd44',
      `Gaze(inv): X=${dbg.gazeX.toFixed(3)} Y=${dbg.gazeY.toFixed(3)}`);

    // Raw screen position (before filter)
    line('#dddddd',
      `RawScr: ${dbg.rawScreenX.toFixed(0)}, ${dbg.rawScreenY.toFixed(0)}`);

    // Filtered output
    line('#ffffff',
      `Filtered: ${dbg.filteredX.toFixed(0)}, ${dbg.filteredY.toFixed(0)}`);

    // Final smooth output
    line('#aaffaa',
      `Output: ${smoothX.toFixed(0)}, ${smoothY.toFixed(0)}`);

    // Frozen
    line(gazeIsFrozen ? '#ff6666' : '#666666',
      `Frozen: ${gazeIsFrozen}`);
  }

  // ==========================================
  // Public API
  // ==========================================

  async function init(video) {
    videoElement = video;

    faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.6
    });

    faceMesh.onResults(onResults);
    console.log('[EyeTracker] v4 initialized — One Euro Filter + corrected X-axis');
  }

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    });
    videoElement.srcObject = stream;
    await videoElement.play();
    console.log('[EyeTracker] Camera started');
  }

  function startTracking() {
    if (isTracking) return;
    isTracking = true;

    // Reset all state
    prevRightClosed = false;
    prevLeftClosed = false;
    lastBlinkActionTime = 0;
    gazeIsFrozen = false;

    smoothX = window.innerWidth / 2;
    smoothY = window.innerHeight / 2;
    lastValidX = smoothX;
    lastValidY = smoothY;

    // Reset pre-smoothing
    preSmoothedGazeX = 0.5;
    preSmoothedGazeY = 0.5;
    preSmoothedInitialized = false;

    // Create fresh One Euro Filters
    if (window.OneEuroFilter) {
      filterX = new OneEuroFilter(OEF_FREQ, OEF_MINCUTOFF, OEF_BETA, OEF_DCUTOFF);
      filterY = new OneEuroFilter(OEF_FREQ, OEF_MINCUTOFF, OEF_BETA, OEF_DCUTOFF);
      console.log('[EyeTracker] One Euro Filters created (freq=%d, mincutoff=%s, beta=%s)',
        OEF_FREQ, OEF_MINCUTOFF, OEF_BETA);
    } else {
      console.warn('[EyeTracker] OneEuroFilter not found! Falling back to no filtering.');
      filterX = null;
      filterY = null;
    }

    async function processFrame() {
      if (!isTracking) return;
      if (videoElement && videoElement.readyState >= 2) {
        await faceMesh.send({ image: videoElement });
      }
      animFrameId = requestAnimationFrame(processFrame);
    }

    processFrame();
    console.log('[EyeTracker] Tracking started');
  }

  function stopTracking() {
    isTracking = false;
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    console.log('[EyeTracker] Tracking stopped');
  }

  function setCalibration(coeffs) {
    calibCoeffs = coeffs;

    // Reset filters when new calibration is applied
    if (filterX) filterX.reset();
    if (filterY) filterY.reset();

    // Reset pre-smoothing
    preSmoothedInitialized = false;

    console.log('[EyeTracker] Calibration set:', coeffs);
  }

  function enableDebug() {
    debugEnabled = true;
    if (!debugCanvas) {
      debugCanvas = document.createElement('canvas');
      debugCanvas.id = 'eyetracker-debug';
      debugCanvas.width = 320;
      debugCanvas.height = 145;
      debugCanvas.style.cssText = `
        position: fixed;
        bottom: 10px;
        left: 10px;
        z-index: 9999;
        background: rgba(0,0,0,0.85);
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.2);
        pointer-events: none;
      `;
      document.body.appendChild(debugCanvas);
      debugCtx = debugCanvas.getContext('2d');
    }
    debugCanvas.style.display = 'block';
    console.log('[EyeTracker] Debug overlay enabled');
  }

  function disableDebug() {
    debugEnabled = false;
    if (debugCanvas) debugCanvas.style.display = 'none';
  }

  return {
    init,
    startCamera,
    startTracking,
    stopTracking,
    setCalibration,
    enableDebug,
    disableDebug,

    set onDistanceFeedback(fn) { onDistanceFeedback = fn; },
    set onRawGaze(fn) { onRawGaze = fn; },
    set onGazeUpdate(fn) { onGazeUpdate = fn; },
    set onRightBlink(fn) { onRightBlink = fn; },
    set onLeftBlink(fn) { onLeftBlink = fn; }
  };
})();
