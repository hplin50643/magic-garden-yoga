type SoundName = "tap" | "countdown" | "go" | "progress" | "success" | "finish";

const SOUND_PATTERNS: Record<
  SoundName,
  Array<{ frequency: number; delay: number; duration: number; gain: number }>
> = {
  tap: [{ frequency: 520, delay: 0, duration: 0.08, gain: 0.04 }],
  countdown: [{ frequency: 440, delay: 0, duration: 0.12, gain: 0.055 }],
  go: [
    { frequency: 660, delay: 0, duration: 0.1, gain: 0.055 },
    { frequency: 880, delay: 0.1, duration: 0.16, gain: 0.05 },
  ],
  progress: [{ frequency: 720, delay: 0, duration: 0.05, gain: 0.025 }],
  success: [
    { frequency: 523.25, delay: 0, duration: 0.12, gain: 0.055 },
    { frequency: 659.25, delay: 0.1, duration: 0.12, gain: 0.052 },
    { frequency: 783.99, delay: 0.2, duration: 0.22, gain: 0.05 },
  ],
  finish: [
    { frequency: 523.25, delay: 0, duration: 0.14, gain: 0.05 },
    { frequency: 659.25, delay: 0.12, duration: 0.14, gain: 0.05 },
    { frequency: 783.99, delay: 0.24, duration: 0.14, gain: 0.05 },
    { frequency: 1046.5, delay: 0.38, duration: 0.35, gain: 0.045 },
  ],
};

const BEAT_SECONDS = 60 / 72;
const SCHEDULE_AHEAD_SECONDS = 0.3;
const SCHEDULER_INTERVAL_MS = 100;
const EFFECTS_VOLUME = 2;
const MUSIC_VOLUME = 0.35;

// An original, unhurried eight-bar garden melody. The bells use only the
// C-major pentatonic scale; soft sustained chords leave room for game cues.
const MUSIC_BARS = [
  { chord: [48, 55, 64], melody: [72, null, 76, 79] },
  { chord: [48, 55, 64], melody: [81, 79, 76, null] },
  { chord: [45, 52, 60], melody: [76, null, 74, 72] },
  { chord: [45, 52, 60], melody: [69, 72, 76, null] },
  { chord: [41, 48, 57], melody: [76, null, 79, 81] },
  { chord: [41, 48, 57], melody: [79, 76, 74, null] },
  { chord: [43, 50, 59], melody: [74, null, 76, 79] },
  { chord: [48, 55, 64], melody: [76, 74, 72, null] },
];

type VoiceKind = "effect" | "music";
type Voice = {
  oscillator: OscillatorNode;
  gain: GainNode;
  kind: VoiceKind;
};

function noteFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export class GardenAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private effects: GainNode | null = null;
  private music: GainNode | null = null;
  private voices = new Set<Voice>();
  private resumePromise: Promise<boolean> | null = null;
  private musicTimer: number | null = null;
  private musicRequested = false;
  private musicVersion = 0;
  private schedulerVersion = 0;
  private outputVersion = 0;
  private nextBeatTime = 0;
  private beatIndex = 0;
  private muted = false;
  private hidden = false;
  private disposed = false;

  constructor(enabled = true) {
    this.muted = !enabled;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    if (this.disposed) return;
    if (this.muted === muted) return;
    this.muted = muted;
    this.outputVersion += 1;
    this.updateMaster();
    if (muted) {
      this.haltMusic();
      this.stopVoices("effect");
    } else {
      this.resumeMusic();
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    if (!this.muted) {
      this.play("tap");
    }
    return this.muted;
  }

  play(name: SoundName): void {
    this.whenRunning((context) => {
      for (const note of SOUND_PATTERNS[name]) {
        this.scheduleNote(
          "effect", note.frequency, context.currentTime + note.delay,
          note.duration, note.gain, "sine", 0.012, 1.015,
        );
      }
    });
  }

  /** Call from the Start button so AudioContext.resume runs in a user gesture. */
  startMusic(): void {
    if (this.disposed) return;
    this.musicRequested = true;
    this.resumeMusic();
  }

  stopMusic(): void {
    this.musicRequested = false;
    this.musicVersion += 1;
    this.haltMusic();
  }

  /** The app owns visibility listeners; a hidden page retains its music intent. */
  setHidden(hidden: boolean): void {
    if (this.disposed || this.hidden === hidden) return;
    this.hidden = hidden;
    this.outputVersion += 1;
    this.updateMaster();
    if (hidden) {
      this.haltMusic();
      this.stopVoices("effect");
    } else {
      this.resumeMusic();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.outputVersion += 1;
    this.stopMusic();
    this.updateMaster();
    this.stopVoices("effect");
    const context = this.context;
    this.context = null;
    this.resumePromise = null;
    this.master?.disconnect();
    this.effects?.disconnect();
    this.music?.disconnect();
    this.master = this.effects = this.music = null;
    if (context) {
      context.onstatechange = null;
      if (context.state !== "closed") {
        try {
          void context.close().catch(() => undefined);
        } catch {
          // Audio support must never prevent the game from being usable.
        }
      }
    }
  }

  private canOutput(): boolean {
    return !this.disposed && !this.muted && !this.hidden;
  }

  private getContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof window === "undefined" || typeof AudioContext === "undefined") {
      return null;
    }
    try {
      const context = new AudioContext();
      this.context = context;
      this.master = context.createGain();
      this.effects = context.createGain();
      this.music = context.createGain();
      this.effects.gain.value = EFFECTS_VOLUME;
      this.music.gain.value = MUSIC_VOLUME;
      this.effects.connect(this.master);
      this.music.connect(this.master);
      this.master.connect(context.destination);
      this.updateMaster();
      context.onstatechange = () => {
        if (this.context !== context || this.disposed) return;
        if (context.state !== "running") {
          this.haltMusic();
          this.stopVoices("effect");
        } else if (this.canOutput() && this.musicRequested) {
          this.beginMusic(context);
        }
      };
      return context;
    } catch {
      return null;
    }
  }

  private updateMaster(): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.canOutput() ? 1 : 0, now);
  }

  private whenRunning(action: (context: AudioContext) => void): void {
    if (!this.canOutput()) return;
    const context = this.getContext();
    if (!context || context.state === "closed") return;
    const version = this.outputVersion;
    const run = () => {
      if (
        this.context === context && this.canOutput() &&
        version === this.outputVersion && context.state === "running"
      ) action(context);
    };
    if (context.state === "running") {
      run();
      return;
    }
    // Invoke resume synchronously in the caller's gesture. Share in-flight
    // requests, and invalidate their callbacks on mute, hide, or disposal.
    if (!this.resumePromise) {
      try {
        this.resumePromise = context.resume().then(() => true, () => false);
      } catch {
        return;
      }
    }
    const resume = this.resumePromise;
    void resume.then((ready) => {
      if (this.resumePromise === resume) this.resumePromise = null;
      if (ready) run();
    });
  }

  private resumeMusic(): void {
    if (!this.musicRequested) return;
    const version = this.musicVersion;
    this.whenRunning((context) => {
      if (this.musicRequested && version === this.musicVersion) {
        this.beginMusic(context);
      }
    });
  }

  private beginMusic(context: AudioContext): void {
    if (this.musicTimer !== null) return;
    this.beatIndex = 0;
    this.nextBeatTime = context.currentTime + 0.04;
    const version = ++this.schedulerVersion;
    const tick = () => {
      if (
        !this.canOutput() || !this.musicRequested ||
        this.context !== context || version !== this.schedulerVersion ||
        context.state !== "running"
      ) return;
      // A slow inference frame must not enqueue a burst of missed notes.
      if (this.nextBeatTime < context.currentTime) {
        this.nextBeatTime = context.currentTime + 0.04;
      }
      while (this.nextBeatTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
        this.scheduleBeat(this.nextBeatTime, this.beatIndex);
        this.nextBeatTime += BEAT_SECONDS;
        this.beatIndex = (this.beatIndex + 1) % (MUSIC_BARS.length * 4);
      }
      this.musicTimer = window.setTimeout(tick, SCHEDULER_INTERVAL_MS);
    };
    tick();
  }

  private scheduleBeat(time: number, beat: number): void {
    const bar = MUSIC_BARS[Math.floor(beat / 4)];
    if (beat % 4 === 0) {
      for (const midi of bar.chord) {
        this.scheduleNote(
          "music", noteFrequency(midi), time,
          BEAT_SECONDS * 3.9, 0.012, "triangle", 0.4,
        );
      }
    }
    const melody = bar.melody[beat % 4];
    if (melody !== null) {
      const frequency = noteFrequency(melody);
      this.scheduleNote("music", frequency, time, 1.25, 0.026, "sine", 0.018);
      this.scheduleNote("music", frequency * 2, time, 0.75, 0.004, "sine", 0.012);
    }
  }

  private scheduleNote(
    kind: VoiceKind, frequency: number, time: number, duration: number,
    volume: number, type: OscillatorType, attack: number, bend = 1,
  ): void {
    const context = this.context;
    const bus = kind === "music" ? this.music : this.effects;
    if (!context || !bus) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const voice: Voice = { oscillator, gain, kind };
    this.voices.add(voice);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * bend, time + duration);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(volume, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(gain);
    gain.connect(bus);
    oscillator.onended = () => this.disconnectVoice(voice);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
  }

  private haltMusic(): void {
    this.schedulerVersion += 1;
    if (this.musicTimer !== null) {
      window.clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    this.stopVoices("music");
  }

  private stopVoices(kind: VoiceKind): void {
    for (const voice of this.voices) {
      if (voice.kind !== kind) continue;
      try {
        voice.oscillator.stop(this.context?.currentTime ?? 0);
      } catch {
        // A voice may have already ended while its ended event was queued.
      }
      this.disconnectVoice(voice);
    }
  }

  private disconnectVoice(voice: Voice): void {
    voice.oscillator.onended = null;
    voice.oscillator.disconnect();
    voice.gain.disconnect();
    this.voices.delete(voice);
  }
}
