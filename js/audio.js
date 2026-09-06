// Audio: everything is synthesized with Web Audio — no sample files, so
// this costs nothing in download size and can't fail on a missing asset.
//
// Continuous layers (engine, wind, tire scrub) are built once and have
// their gain/frequency steered every frame; impacts and boosts are
// one-shot voices created on demand. Browsers block audio until a user
// gesture, so init() must be called from a click/tap handler — until
// then, and on any browser without Web Audio, every method here is a
// safe no-op rather than an error.

class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this._nodes = {};
  }

  // Call from inside a user gesture (a button tap). Safe to call repeatedly.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no Web Audio here — stay silent rather than throw
    try {
      this.ctx = new AC();
    } catch (e) {
      return;
    }

    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.enabled ? 0.9 : 0;
    master.connect(ctx.destination);

    // --- engine: two detuned saws through a lowpass that opens with revs ---
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 600;
    engineFilter.Q.value = 6;
    engineFilter.connect(engineGain);
    engineGain.connect(master);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 60;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 60;
    osc2.detune.value = -12; // slight beat against osc1 keeps it from sounding like a test tone
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;
    osc1.connect(engineFilter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(engineFilter);
    osc1.start();
    osc2.start();

    // --- shared noise buffer, reused by wind, tire scrub and impacts ---
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

    // --- wind: broad noise that swells with speed ---
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 900;
    windFilter.Q.value = 0.7;
    windFilter.connect(windGain);
    windGain.connect(master);
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;
    windSrc.connect(windFilter);
    windSrc.start();

    // --- tire scrub: narrow, high noise for drifting and off-track gravel ---
    const scrubGain = ctx.createGain();
    scrubGain.gain.value = 0;
    const scrubFilter = ctx.createBiquadFilter();
    scrubFilter.type = 'bandpass';
    scrubFilter.frequency.value = 2200;
    scrubFilter.Q.value = 5;
    scrubFilter.connect(scrubGain);
    scrubGain.connect(master);
    const scrubSrc = ctx.createBufferSource();
    scrubSrc.buffer = noiseBuffer;
    scrubSrc.loop = true;
    scrubSrc.connect(scrubFilter);
    scrubSrc.start();

    this._nodes = { master, engineGain, engineFilter, osc1, osc2, windGain, windFilter, scrubGain, scrubFilter, noiseBuffer };
    this.ready = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._nodes.master.gain.setTargetAtTime(on ? 0.9 : 0, t, 0.05);
  }

  // Steer the continuous layers. `s` describes the player's kart this frame.
  update(s) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this._nodes;

    const speedFrac = Math.min(1, Math.abs(s.speed) / Math.max(1, s.maxSpeed));
    // Revs don't track speed exactly — throttle adds a little "load" so the
    // engine lifts when you're on the gas, not only when you're already fast.
    const revs = Math.min(1, speedFrac * 0.85 + (s.throttle > 0 ? 0.15 : 0));

    n.osc1.frequency.setTargetAtTime(55 + revs * 250, t, 0.06);
    n.osc2.frequency.setTargetAtTime((55 + revs * 250) * 0.5, t, 0.06);
    n.engineFilter.frequency.setTargetAtTime(400 + revs * 2200, t, 0.08);
    n.engineGain.gain.setTargetAtTime(0.035 + revs * 0.10, t, 0.08);

    n.windGain.gain.setTargetAtTime(speedFrac * speedFrac * 0.13, t, 0.12);
    n.windFilter.frequency.setTargetAtTime(500 + speedFrac * 1400, t, 0.12);

    // Drifting squeals; off-track is a duller, lower gravel rumble.
    let scrub = 0;
    let scrubFreq = 2200;
    if (s.drifting && speedFrac > 0.15) scrub = 0.10 + speedFrac * 0.06;
    else if (s.offTrack && speedFrac > 0.1) { scrub = 0.05 + speedFrac * 0.05; scrubFreq = 700; }
    n.scrubGain.gain.setTargetAtTime(scrub, t, 0.05);
    n.scrubFilter.frequency.setTargetAtTime(scrubFreq, t, 0.08);
  }

  // Quiet the continuous layers without tearing the graph down (menus, results).
  idle() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this._nodes;
    n.engineGain.gain.setTargetAtTime(0, t, 0.15);
    n.windGain.gain.setTargetAtTime(0, t, 0.15);
    n.scrubGain.gain.setTargetAtTime(0, t, 0.15);
  }

  // One-shot: a low thump plus a noise crack, scaled by how hard the hit was.
  impact(strength = 1) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = Math.min(1, strength) * 0.5;

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(160, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(amp, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    thump.connect(thumpGain);
    thumpGain.connect(this._nodes.master);
    thump.start(t);
    thump.stop(t + 0.3);

    const crack = ctx.createBufferSource();
    crack.buffer = this._nodes.noiseBuffer;
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.value = 1400;
    crackFilter.Q.value = 1.2;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(amp * 0.6, t);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(this._nodes.master);
    crack.start(t);
    crack.stop(t + 0.15);
  }

  // One-shot: rising whoosh when a boost or mini-turbo fires.
  boost() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this._nodes.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(3000, t + 0.35);
    filter.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this._nodes.master);
    src.start(t);
    src.stop(t + 0.5);
  }
}
