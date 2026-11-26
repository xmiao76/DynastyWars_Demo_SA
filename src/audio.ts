// Procedural Web Audio SFX + music. No external audio assets to license;
// everything is synthesized at runtime after a user gesture.

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;
  muted = false;
  started = false;
  /** Boss encounters switch the loop to a faster, lower pattern. */
  bossMode = false;

  /** Must be called from a user-gesture handler. Safe to call repeatedly. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.35;
    this.musicGain.connect(this.master);
    this.started = true;
    this.nextNoteTime = this.ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 120);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setValueAtTime(muted ? 0 : 0.5, this.ctx.currentTime);
    }
  }

  // ---- music: slow pentatonic pluck loop + war drum (original pattern) ----
  private scheduleMusic(): void {
    if (!this.ctx || !this.musicGain) return;
    const SPB = this.bossMode ? 0.3 : 0.42; // seconds per eighth note
    // D pentatonic-ish original loop (Hz), 0 = rest. Boss mode drops the
    // melody a fourth and doubles the war-drum pattern.
    const base = [
      293.66, 0, 369.99, 440.0, 0, 587.33, 440.0, 369.99,
      293.66, 0, 220.0, 293.66, 369.99, 0, 440.0, 0,
      587.33, 0, 659.25, 587.33, 440.0, 369.99, 293.66, 220.0,
      246.94, 293.66, 0, 0, 220.0, 0, 0, 0,
    ];
    const melody = this.bossMode ? base.map((f) => (f > 0 ? f * 0.749 : 0)) : base;
    while (this.nextNoteTime < this.ctx.currentTime + 0.3) {
      const t = this.nextNoteTime;
      const idx = this.step % melody.length;
      const freq = melody[idx];
      if (freq > 0) this.pluck(freq, t, 0.16);
      if (idx % 8 === 0) this.drum(t, 0.5);
      else if (idx % 8 === 4) this.drum(t, 0.3);
      else if (this.bossMode && idx % 4 === 2) this.drum(t, 0.22);
      if (idx % 16 === 0) this.pluck(this.bossMode ? 82.4 : 110.0, t, 0.5, 0.7); // low root
      this.nextNoteTime += SPB;
      this.step += 1;
    }
  }

  private pluck(
    freq: number,
    t: number,
    gain = 0.15,
    dur = 0.35,
  ): void {
    if (!this.ctx || !this.musicGain) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private drum(t: number, gain: number): void {
    if (!this.ctx || !this.musicGain) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * 0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g).connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  // ---- SFX ----
  private noise(dur: number): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  private tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  swing(): void {
    if (!this.ctx || !this.master) return;
    const src = this.noise(0.14);
    if (!src) return;
    const t = this.ctx.currentTime;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.13);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  hit(): void {
    this.tone('square', 220, 60, 0.12, 0.3);
    if (!this.ctx || !this.master) return;
    const src = this.noise(0.08);
    if (!src) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(g).connect(this.master);
    src.start(t);
  }

  hurt(): void {
    this.tone('sawtooth', 300, 90, 0.2, 0.25);
  }

  jump(): void {
    this.tone('sine', 260, 620, 0.16, 0.15);
  }

  death(): void {
    this.tone('triangle', 180, 40, 0.5, 0.3);
  }

  slam(): void {
    this.tone('sine', 140, 35, 0.4, 0.6);
    this.hit();
  }

  ui(): void {
    this.tone('triangle', 660, 880, 0.09, 0.15);
  }

  grab(): void {
    this.tone('square', 160, 90, 0.12, 0.25);
  }

  throwWhoosh(): void {
    if (!this.ctx || !this.master) return;
    const src = this.noise(0.3);
    if (!src) return;
    const t = this.ctx.currentTime;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.exponentialRampToValueAtTime(2200, t + 0.22);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  explosion(): void {
    this.tone('sine', 110, 28, 0.55, 0.65);
    if (!this.ctx || !this.master) return;
    const src = this.noise(0.45);
    if (!src) return;
    const t = this.ctx.currentTime;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(160, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  arrowRelease(): void {
    this.tone('square', 900, 1400, 0.07, 0.12);
    this.swing();
  }

  clank(): void {
    this.tone('square', 1400, 700, 0.09, 0.18);
    this.tone('square', 2100, 1100, 0.06, 0.1);
  }

  creak(): void {
    this.tone('sawtooth', 90, 60, 0.7, 0.16);
  }

  pickup(): void {
    this.tone('triangle', 520, 780, 0.1, 0.18);
    window.setTimeout(() => this.tone('triangle', 780, 1040, 0.12, 0.15), 80);
  }

  medal(): void {
    [587.33, 880.0, 1174.66].forEach((f, i) => {
      window.setTimeout(() => this.tone('triangle', f, f, 0.22, 0.18), i * 110);
    });
  }

  chargeTell(): void {
    this.tone('sawtooth', 196, 196, 0.28, 0.2);
  }

  jingle(win: boolean): void {
    if (!this.ctx) return;
    const notes = win
      ? [293.66, 369.99, 440.0, 587.33, 739.99]
      : [440.0, 369.99, 293.66, 220.0];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.tone('triangle', f, f, 0.32, 0.22), i * 150);
    });
  }
}

export const audio = new AudioEngine();

declare global {
  interface Window {
    __DYNASTY_AUDIO__?: { started: boolean; muted: boolean };
  }
}
window.__DYNASTY_AUDIO__ = {
  get started() {
    return audio.started;
  },
  get muted() {
    return audio.muted;
  },
};
