/**
 * oneEuroFilter.js — One Euro Filter (Vanilla JS)
 *
 * Based on the paper:
 *   "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 *   by Géry Casiez, Nicolas Roussel, Daniel Vogel (CHI 2012)
 *   https://cristal.univ-lille.fr/~casiez/1euro/
 *
 * The One Euro Filter is a first-order low-pass filter with an adaptive cutoff frequency.
 * When the signal is slow/stable, it uses a low cutoff for maximum smoothing (jitter reduction).
 * When the signal moves fast, it raises the cutoff to reduce lag.
 *
 * This is the gold standard for real-time interactive signal smoothing (gaze, stylus, head tracking).
 */

class LowPassFilter {
  constructor(alpha, initval) {
    this.y = initval || 0;
    this.s = this.y;
    this.a = alpha;
    this.initialized = false;
  }

  setAlpha(alpha) {
    if (alpha < 0 || alpha > 1) {
      throw new Error(`LowPassFilter: alpha (${alpha}) must be in [0, 1]`);
    }
    this.a = alpha;
  }

  filter(value) {
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
      return value;
    }
    this.s = this.a * value + (1 - this.a) * this.s;
    return this.s;
  }

  lastValue() {
    return this.s;
  }

  reset(value) {
    this.s = value || 0;
    this.y = this.s;
    this.initialized = false;
  }
}

class OneEuroFilter {
  /**
   * @param {number} freq     — Estimated signal frequency in Hz (e.g., 60 for 60fps)
   * @param {number} mincutoff — Minimum cutoff frequency. Lower = more smoothing when slow. (default: 1.0)
   * @param {number} beta      — Speed coefficient. Higher = less lag during fast movement. (default: 0.0)
   * @param {number} dcutoff   — Cutoff frequency for the derivative signal. (default: 1.0)
   */
  constructor(freq, mincutoff, beta, dcutoff) {
    this.freq = freq || 60;
    this.mincutoff = mincutoff !== undefined ? mincutoff : 1.0;
    this.beta = beta !== undefined ? beta : 0.0;
    this.dcutoff = dcutoff !== undefined ? dcutoff : 1.0;

    this.x = new LowPassFilter(this._alpha(this.mincutoff));
    this.dx = new LowPassFilter(this._alpha(this.dcutoff), 0.0);
    this.lasttime = null;
  }

  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  /**
   * Filter a noisy value.
   * @param {number} x         — The raw input value
   * @param {number} timestamp — Optional timestamp in seconds. If provided, the filter
   *                             will compute the actual frequency from inter-sample intervals.
   * @returns {number} — The filtered (smoothed) value
   */
  filter(x, timestamp) {
    // Update frequency if timestamp is provided
    if (timestamp !== undefined && this.lasttime !== null) {
      const dt = timestamp - this.lasttime;
      if (dt > 0) {
        this.freq = 1.0 / dt;
      }
    }
    this.lasttime = timestamp;

    // Estimate the derivative of the signal
    const prevX = this.x.lastValue();
    const dx = this.x.initialized
      ? (x - prevX) * this.freq
      : 0.0;

    // Filter the derivative
    this.dx.setAlpha(this._alpha(this.dcutoff));
    const edx = this.dx.filter(dx);

    // Adaptive cutoff based on speed
    const cutoff = this.mincutoff + this.beta * Math.abs(edx);

    // Filter the signal with the adaptive cutoff
    this.x.setAlpha(this._alpha(cutoff));
    return this.x.filter(x);
  }

  /**
   * Reset the filter state. Call when restarting tracking.
   */
  reset() {
    this.x.reset();
    this.dx.reset();
    this.lasttime = null;
  }
}

// Export for use in other scripts (global scope for vanilla JS)
window.OneEuroFilter = OneEuroFilter;
