/**
 * calibration.js — 9-Point Gaze Calibration with Quadratic Regression
 *
 * v7 — Fewer points, same model efficiency
 *
 * Changes over v6:
 *  - 9 calibration points (4 corners + 4 edge midpoints + center)
 *  - Removed 4 redundant ¼-edge points (covered by ridge regularization)
 *  - 35 samples per point (was 40) — still enough for robust median
 *  - Settle time reduced to 1200ms (was 1500ms) — faster without quality loss
 *  - Post-calibration validation retained
 */

const Calibration = (() => {
  const MARGIN_PERCENT = 0.03;       // 3% margin — closer to real edges
  const SAMPLES_PER_POINT = 35;      // 35 samples — robust median, less wait
  const SAMPLE_INTERVAL_MS = 60;     // Sampling interval
  const SETTLE_TIME_MS = 1200;       // 1.2s settle (was 1.5s) — still stable

  let points = [];
  let currentPointIndex = -1;
  let samples = [];
  let allSamples = [];
  let sampleCount = 0;
  let sampleTimer = null;
  let isCalibrating = false;

  let resultCoeffs = null;

  let container = null;
  let statusEl = null;
  let progressBar = null;

  let onComplete = null;
  let onProgress = null;

  function init(containerEl, statusElement, progressBarEl) {
    container = containerEl;
    statusEl = statusElement;
    progressBar = progressBarEl;

    const blinkUi = document.getElementById('blink-calib-ui');
    if (blinkUi) blinkUi.style.display = 'none';

    const w = window.innerWidth;
    const h = window.innerHeight;
    const mx = w * MARGIN_PERCENT;
    const my = h * MARGIN_PERCENT;

    // 9 points: 4 corners + 4 edge midpoints + center
    // Order: corners first (most important for edge coverage),
    // then edge midpoints, then center — optimal for quadratic regression
    const positions = [
      // === Corners (4) — MOST IMPORTANT for edge coverage ===
      { x: mx,       y: my,       label: 'Canto Superior Esquerdo' },
      { x: w - mx,   y: my,       label: 'Canto Superior Direito' },
      { x: mx,       y: h - my,   label: 'Canto Inferior Esquerdo' },
      { x: w - mx,   y: h - my,   label: 'Canto Inferior Direito' },

      // === Edge midpoints (4) — fill gaps between corners ===
      { x: w / 2,    y: my,       label: 'Borda Superior Centro' },
      { x: w / 2,    y: h - my,   label: 'Borda Inferior Centro' },
      { x: mx,       y: h / 2,    label: 'Borda Esquerda Centro' },
      { x: w - mx,   y: h / 2,    label: 'Borda Direita Centro' },

      // === Center (1) — anchor point ===
      { x: w / 2,    y: h / 2,    label: 'Centro' }
    ];

    points = positions.map((pos, i) => {
      let el = document.getElementById(`calib-point-${i}`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'calibration-point';
        el.id = `calib-point-${i}`;
        container.appendChild(el);
      }
      el.style.left = `${pos.x - 20}px`;
      el.style.top = `${pos.y - 20}px`;
      el.classList.remove('active', 'completed');
      el.style.display = 'none';
      return { ...pos, element: el, index: i };
    });

    allSamples = [];
  }

  function start() {
    isCalibrating = true;
    currentPointIndex = -1;
    allSamples = [];

    updateStatus('Olhe para o ponto e mantenha o olhar fixo...');
    updateProgress(0);
    nextPoint();
  }

  function nextPoint() {
    if (currentPointIndex >= 0 && currentPointIndex < points.length) {
      points[currentPointIndex].element.classList.remove('active');
      points[currentPointIndex].element.classList.add('completed');
      points[currentPointIndex].element.style.display = 'none';
    }

    currentPointIndex++;

    if (currentPointIndex >= points.length) {
      finishCalibration();
      return;
    }

    const point = points[currentPointIndex];
    point.element.style.display = 'block';
    point.element.classList.add('active');
    sampleCount = 0;
    samples = [];

    updateStatus(`Olhe para o ponto: ${point.label} (${currentPointIndex + 1}/${points.length})`);
    updateProgress(currentPointIndex / points.length);

    setTimeout(() => {
      startSampling();
    }, SETTLE_TIME_MS);
  }

  function startSampling() {
    if (!isCalibrating) return;

    sampleTimer = setInterval(() => {
      sampleCount++;

      if (sampleCount >= SAMPLES_PER_POINT) {
        clearInterval(sampleTimer);

        if (samples.length > 5) {
          const filtered = filterOutliers(samples);
          if (filtered.length > 0) {
            const medianSample = getMedianSample(filtered);
            allSamples.push({
              gazeX: medianSample.gazeX,
              gazeY: medianSample.gazeY,
              screenX: points[currentPointIndex].x,
              screenY: points[currentPointIndex].y
            });
          }
        }

        setTimeout(() => nextPoint(), 400);
      }
    }, SAMPLE_INTERVAL_MS);
  }

  function addSample(gazeX, gazeY) {
    if (!isCalibrating || currentPointIndex < 0) return;
    samples.push({ gazeX, gazeY });
  }

  function finishCalibration() {
    if (sampleTimer) clearInterval(sampleTimer);

    if (allSamples.length < 6) {
      // Need at least 6 points for quadratic regression
      updateStatus('Calibração falhou — pontos insuficientes. Tente novamente.');
      isCalibrating = false;
      if (onComplete) onComplete(null);
      return;
    }

    resultCoeffs = computeQuadraticRegression(allSamples);

    // --- Validation: check calibration quality ---
    const validation = validateCalibration(resultCoeffs, allSamples);
    console.log('[Calib] Validation — Mean error:', validation.meanError.toFixed(1), 'px',
      '| Max error:', validation.maxError.toFixed(1), 'px');

    // Warn if error is too high but don't reject (user can re-calibrate)
    if (validation.meanError > window.innerWidth * 0.15) {
      console.warn('[Calib] WARNING: High calibration error! Mean:', validation.meanError.toFixed(0), 'px');
    }

    points.forEach(p => {
      p.element.style.display = 'none';
      p.element.classList.remove('active', 'completed');
    });

    isCalibrating = false;

    updateStatus('Calibração Concluída!');
    updateProgress(1.0);

    console.log('[Calib] Quadratic calibration done with', allSamples.length, 'points');
    console.log('[Calib] Coefficients:', resultCoeffs);

    if (onComplete) {
      setTimeout(() => onComplete(resultCoeffs, null), 800);
    }
  }

  // ==========================================
  // Validation
  // ==========================================
  /**
   * Check how well the calibration fits the training data.
   * Returns mean and max error in pixels.
   */
  function validateCalibration(coeffs, data) {
    let totalError = 0;
    let maxError = 0;

    for (const d of data) {
      const gx = d.gazeX;
      const gy = d.gazeY;
      const gx2 = gx * gx;
      const gy2 = gy * gy;
      const gxy = gx * gy;

      const predX = coeffs.xa * gx2 + coeffs.xb * gy2 + coeffs.xc * gxy +
                     coeffs.xd * gx + coeffs.xe * gy + coeffs.xf;
      const predY = coeffs.ya * gx2 + coeffs.yb * gy2 + coeffs.yc * gxy +
                     coeffs.yd * gx + coeffs.ye * gy + coeffs.yf;

      const err = Math.sqrt((predX - d.screenX) ** 2 + (predY - d.screenY) ** 2);
      totalError += err;
      if (err > maxError) maxError = err;
    }

    return {
      meanError: totalError / data.length,
      maxError
    };
  }

  // ==========================================
  // Outlier Filtering
  // ==========================================
  function filterOutliers(samples) {
    if (samples.length < 5) return samples;

    const xVals = samples.map(s => s.gazeX).sort((a, b) => a - b);
    const yVals = samples.map(s => s.gazeY).sort((a, b) => a - b);

    const q1x = xVals[Math.floor(xVals.length * 0.25)];
    const q3x = xVals[Math.floor(xVals.length * 0.75)];
    const iqrX = q3x - q1x;

    const q1y = yVals[Math.floor(yVals.length * 0.25)];
    const q3y = yVals[Math.floor(yVals.length * 0.75)];
    const iqrY = q3y - q1y;

    const factor = 1.5;
    return samples.filter(s =>
      s.gazeX >= q1x - factor * iqrX &&
      s.gazeX <= q3x + factor * iqrX &&
      s.gazeY >= q1y - factor * iqrY &&
      s.gazeY <= q3y + factor * iqrY
    );
  }

  function getMedianSample(samples) {
    const sortedX = [...samples].sort((a, b) => a.gazeX - b.gazeX);
    const sortedY = [...samples].sort((a, b) => a.gazeY - b.gazeY);
    const mid = Math.floor(samples.length / 2);
    return {
      gazeX: sortedX[mid].gazeX,
      gazeY: sortedY[mid].gazeY
    };
  }

  // ==========================================
  // Quadratic Regression
  // ==========================================
  /**
   * Compute quadratic regression from calibration data.
   *
   * Model: screenX = a·gx² + b·gy² + c·gx·gy + d·gx + e·gy + f
   *        screenY = [same form, different coefficients]
   *
   * Uses least squares with Tikhonov regularization (ridge),
   * solved via Gauss elimination on the normal equations.
   *
   * Feature vector per sample: [gx², gy², gx·gy, gx, gy, 1]
   */
  function computeQuadraticRegression(data) {
    const n = data.length;
    const numFeatures = 6;
    const lambda = 0.001; // Ridge regularization — sufficient for 9 well-distributed points

    // Build feature matrix Φ (n × 6) and target vectors
    const Phi = [];
    const targetX = [];
    const targetY = [];

    for (const d of data) {
      const gx = d.gazeX;
      const gy = d.gazeY;
      Phi.push([gx * gx, gy * gy, gx * gy, gx, gy, 1]);
      targetX.push(d.screenX);
      targetY.push(d.screenY);
    }

    // Compute Φᵀ·Φ (6×6 symmetric matrix)
    const PhiTPhi = Array.from({ length: numFeatures }, () =>
      new Array(numFeatures).fill(0)
    );
    for (let i = 0; i < numFeatures; i++) {
      for (let j = i; j < numFeatures; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += Phi[k][i] * Phi[k][j];
        }
        PhiTPhi[i][j] = sum;
        PhiTPhi[j][i] = sum; // Symmetric
      }
      // Add ridge regularization (except bias term)
      if (i < numFeatures - 1) {
        PhiTPhi[i][i] += lambda;
      }
    }

    // Compute Φᵀ·targetX and Φᵀ·targetY (6×1 vectors)
    const PhiTtX = new Array(numFeatures).fill(0);
    const PhiTtY = new Array(numFeatures).fill(0);
    for (let i = 0; i < numFeatures; i++) {
      for (let k = 0; k < n; k++) {
        PhiTtX[i] += Phi[k][i] * targetX[k];
        PhiTtY[i] += Phi[k][i] * targetY[k];
      }
    }

    // Solve (Φᵀ·Φ)·w = Φᵀ·t via Gauss elimination
    const xCoeffs = solveGauss(deepCopy2D(PhiTPhi), [...PhiTtX]);
    const yCoeffs = solveGauss(deepCopy2D(PhiTPhi), [...PhiTtY]);

    return {
      isQuadratic: true,
      // X mapping: screenX = xa·gx² + xb·gy² + xc·gx·gy + xd·gx + xe·gy + xf
      xa: xCoeffs[0], xb: xCoeffs[1], xc: xCoeffs[2],
      xd: xCoeffs[3], xe: xCoeffs[4], xf: xCoeffs[5],
      // Y mapping
      ya: yCoeffs[0], yb: yCoeffs[1], yc: yCoeffs[2],
      yd: yCoeffs[3], ye: yCoeffs[4], yf: yCoeffs[5]
    };
  }

  /**
   * Gauss elimination with partial pivoting.
   * Solves A·x = b where A is n×n.
   * Returns x (n×1 array).
   */
  function solveGauss(A, b) {
    const n = A.length;

    // Forward elimination with partial pivoting
    for (let col = 0; col < n; col++) {
      // Find pivot
      let maxRow = col;
      let maxVal = Math.abs(A[col][col]);
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(A[row][col]) > maxVal) {
          maxVal = Math.abs(A[row][col]);
          maxRow = row;
        }
      }

      // Swap rows
      if (maxRow !== col) {
        [A[col], A[maxRow]] = [A[maxRow], A[col]];
        [b[col], b[maxRow]] = [b[maxRow], b[col]];
      }

      // Check for zero pivot (singular matrix)
      if (Math.abs(A[col][col]) < 1e-12) {
        console.warn('[Calib] Near-singular matrix at column', col);
        continue;
      }

      // Eliminate below
      for (let row = col + 1; row < n; row++) {
        const factor = A[row][col] / A[col][col];
        for (let j = col; j < n; j++) {
          A[row][j] -= factor * A[col][j];
        }
        b[row] -= factor * b[col];
      }
    }

    // Back substitution
    const x = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row--) {
      let sum = b[row];
      for (let j = row + 1; j < n; j++) {
        sum -= A[row][j] * x[j];
      }
      if (Math.abs(A[row][row]) > 1e-12) {
        x[row] = sum / A[row][row];
      } else {
        x[row] = 0; // Fallback for degenerate case
      }
    }

    return x;
  }

  function deepCopy2D(arr) {
    return arr.map(row => [...row]);
  }

  // ==========================================
  // UI Helpers
  // ==========================================
  function updateStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function updateProgress(fraction) {
    if (progressBar) progressBar.style.width = `${fraction * 100}%`;
    if (onProgress) onProgress(fraction);
  }

  function reset() {
    isCalibrating = false;
    if (sampleTimer) clearInterval(sampleTimer);
    currentPointIndex = -1;
    allSamples = [];
    samples = [];
    const blinkUi = document.getElementById('blink-calib-ui');
    if (blinkUi) blinkUi.style.display = 'none';
    points.forEach(p => {
      p.element.style.display = 'none';
      p.element.classList.remove('active', 'completed');
    });
    updateProgress(0);
  }

  return {
    init,
    start,
    addSample,
    reset,
    get isCalibrating() { return isCalibrating; },
    set onComplete(fn) { onComplete = fn; },
    set onProgress(fn) { onProgress = fn; }
  };
})();
