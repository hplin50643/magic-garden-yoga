import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GardenAudio } from "./audio";

class FakeParam {
  value = 1;
  setValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
  });
  exponentialRampToValueAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator {
  type = "sine";
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeContext {
  static instances: FakeContext[] = [];
  static initialState: AudioContextState = "running";
  static onResume: (context: FakeContext) => Promise<void> = async (context) => {
    context.changeState("running");
  };

  state: AudioContextState = FakeContext.initialState;
  destination = {};
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  onstatechange: (() => void) | null = null;
  resume = vi.fn(() => FakeContext.onResume(this));
  close = vi.fn(async () => {
    this.changeState("closed");
  });

  constructor() {
    FakeContext.instances.push(this);
  }

  get currentTime(): number {
    return Date.now() / 1000;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  changeState(state: AudioContextState): void {
    this.state = state;
    this.onstatechange?.();
  }
}

function pendingResume(): { resolve: () => void; reject: () => void } {
  FakeContext.initialState = "suspended";
  let resolve!: () => void;
  let reject!: () => void;
  FakeContext.onResume = (context) => new Promise<void>((accept, decline) => {
    resolve = () => {
      context.changeState("running");
      accept();
    };
    reject = () => decline(new Error("Autoplay blocked"));
  });
  return { resolve: () => resolve(), reject: () => reject() };
}

describe("GardenAudio", () => {
  const players: GardenAudio[] = [];
  function player(enabled = true): GardenAudio {
    const audio = new GardenAudio(enabled);
    players.push(audio);
    return audio;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("AudioContext", FakeContext);
    FakeContext.instances = [];
    FakeContext.initialState = "running";
    FakeContext.onResume = async (context) => context.changeState("running");
  });

  afterEach(() => {
    for (const audio of players.splice(0)) audio.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not allocate audio on construction or while initially muted", () => {
    const audio = player(false);
    audio.startMusic();
    audio.play("success");
    expect(FakeContext.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    expect(audio.toggleMuted()).toBe(false);
    expect(FakeContext.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(FakeContext.instances[0].oscillators.length).toBeGreaterThan(1);
  });

  it("routes louder effects and quiet music through the same master gain", () => {
    const audio = player();
    audio.play("tap");
    audio.startMusic();
    const context = FakeContext.instances[0];
    const [master, effects, music] = context.gains;
    expect(effects.gain.value).toBe(2);
    expect(music.gain.value).toBe(0.35);
    expect(effects.connect).toHaveBeenCalledWith(master);
    expect(music.connect).toHaveBeenCalledWith(master);
    expect(master.connect).toHaveBeenCalledWith(context.destination);
    expect(context.gains[3].connect).toHaveBeenCalledWith(effects);
    expect(context.gains[4].connect).toHaveBeenCalledWith(music);
  });

  it("maintains one scheduler across repeated starts and complete music loops", () => {
    const audio = player();
    audio.startMusic();
    const context = FakeContext.instances[0];
    const initialNotes = context.oscillators.length;
    audio.startMusic();
    audio.startMusic();
    expect(context.oscillators).toHaveLength(initialNotes);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(30_000);
    expect(context.oscillators.length).toBeGreaterThan(initialNotes * 10);
    expect(vi.getTimerCount()).toBe(1);
    audio.stopMusic();
    const stoppedNotes = context.oscillators.length;
    vi.advanceTimersByTime(60_000);
    expect(context.oscillators).toHaveLength(stoppedNotes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mutes every ongoing and scheduled voice and resumes only one fresh loop", () => {
    const audio = player();
    audio.startMusic();
    audio.play("finish");
    const context = FakeContext.instances[0];
    const oldVoices = [...context.oscillators];
    audio.setMuted(true);
    expect(context.gains[0].gain.value).toBe(0);
    expect(oldVoices.every((voice) => voice.disconnect.mock.calls.length === 1)).toBe(true);
    expect(oldVoices.every((voice) => voice.stop.mock.calls.length === 2)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(context.oscillators).toHaveLength(oldVoices.length);

    audio.setMuted(false);
    expect(context.gains[0].gain.value).toBe(1);
    expect(context.oscillators.length).toBeGreaterThan(oldVoices.length);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses a hidden page and does not revive music stopped while hidden", () => {
    const audio = player();
    audio.startMusic();
    audio.setHidden(true);
    const context = FakeContext.instances[0];
    const hiddenNotes = context.oscillators.length;
    audio.play("success");
    vi.advanceTimersByTime(3000);
    expect(context.gains[0].gain.value).toBe(0);
    expect(context.oscillators).toHaveLength(hiddenNotes);
    expect(vi.getTimerCount()).toBe(0);

    audio.setHidden(false);
    expect(vi.getTimerCount()).toBe(1);
    audio.setHidden(true);
    audio.stopMusic();
    audio.setHidden(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping music preserves effects and releases ended notes", () => {
    const audio = player();
    audio.play("tap");
    const context = FakeContext.instances[0];
    const effect = context.oscillators[0];
    audio.startMusic();
    audio.stopMusic();
    expect(effect.disconnect).not.toHaveBeenCalled();
    expect(context.oscillators.slice(1).every((voice) => voice.onended === null)).toBe(true);
    effect.onended?.();
    expect(effect.disconnect).toHaveBeenCalledOnce();
    expect(context.gains[3].disconnect).toHaveBeenCalledOnce();
    audio.dispose();
    expect(effect.disconnect).toHaveBeenCalledOnce();
  });

  it("shares delayed unlock requests without duplicate music or stale sounds", async () => {
    const pending = pendingResume();
    const audio = player();
    audio.startMusic();
    audio.startMusic();
    audio.play("finish");
    const context = FakeContext.instances[0];
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.oscillators).toHaveLength(0);
    audio.setMuted(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.oscillators).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    audio.setMuted(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(context.oscillators.every((voice) =>
      voice.connect.mock.calls[0][0].connect.mock.calls[0][0] === context.gains[2],
    )).toBe(true);
  });

  it("does not resurrect music when an old unlock resolves after stop", async () => {
    const pending = pendingResume();
    const audio = player();
    audio.startMusic();
    audio.stopMusic();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeContext.instances[0].oscillators).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from rejected resume on the next user interaction", async () => {
    const pending = pendingResume();
    const audio = player();
    audio.startMusic();
    const context = FakeContext.instances[0];
    pending.reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(context.oscillators).toHaveLength(0);

    FakeContext.onResume = async (target) => target.changeState("running");
    audio.startMusic();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears audio on browser interruption and restarts a single loop on recovery", () => {
    const audio = player();
    audio.startMusic();
    const context = FakeContext.instances[0];
    context.changeState("suspended");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(4000);
    context.changeState("running");
    expect(vi.getTimerCount()).toBe(1);
    audio.startMusic();
    expect(vi.getTimerCount()).toBe(1);
    expect(context.oscillators.at(-1)?.start.mock.calls[0][0]).toBeGreaterThan(context.currentTime);
  });

  it("ignores a canceled scheduler callback after a fresh start", () => {
    const audio = player();
    const timeout = vi.spyOn(window, "setTimeout");
    audio.startMusic();
    const oldTick = timeout.mock.calls[0][0] as () => void;
    audio.setHidden(true);
    audio.setHidden(false);
    const context = FakeContext.instances[0];
    const freshNotes = context.oscillators.length;
    oldTick();
    expect(context.oscillators).toHaveLength(freshNotes);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("disposes once and ignores late unlocks and all subsequent playback calls", async () => {
    const pending = pendingResume();
    const audio = player();
    audio.startMusic();
    const context = FakeContext.instances[0];
    audio.dispose();
    audio.dispose();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    audio.startMusic();
    audio.play("tap");
    audio.toggleMuted();
    audio.setHidden(false);
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.onstatechange).toBeNull();
    expect(context.oscillators).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeContext.instances).toHaveLength(1);
  });

  it("degrades silently when Web Audio is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    const audio = player();
    expect(() => {
      audio.startMusic();
      audio.play("go");
      audio.dispose();
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
