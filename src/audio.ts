import type { Snapshot, Track } from './shared.js';

export function fadeSeconds(configured: number, outgoing: number, incoming: number) {
  if (!Number.isFinite(outgoing) || !Number.isFinite(incoming)) return 0;
  return Math.max(0, Math.min(configured, outgoing / 2, incoming / 2));
}
export function fadeGains(progress: number): [number, number] {
  const p = Math.max(0, Math.min(1, progress));
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}
type Deck = { track: Track; audio: HTMLAudioElement; gain: GainNode; source: MediaElementAudioSourceNode; ready: boolean };
export class AudioPlayer {
  private context = new AudioContext();
  private master = this.context.createGain();
  private active: Deck | null = null;
  private next: Deck | null = null;
  private state: Snapshot | null = null;
  private revision = -1;
  private alarm: number | null = null;
  private fading: { start: number; duration: number } | null = null;
  private advancing = false;
  private destroyed = false;
  private interval: ReturnType<typeof setInterval>;
  constructor(private advance: (revision: number) => Promise<void>, private failure: (message: string, revision: number, fatal?: boolean) => void) {
    this.master.connect(this.context.destination);
    this.interval = setInterval(() => this.tick(), 100);
  }
  async unlock() { await this.context.resume(); }
  private ding() {
    const now = this.context.currentTime;
    // Original synthesized bell; no third-party recording or sample is used.
    for (const [frequency, volume] of [[880, 0.22], [1760, 0.1], [2464, 0.055]]) {
      const tone = this.context.createOscillator();
      const gain = this.context.createGain();
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      tone.connect(gain).connect(this.master);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(now); tone.stop(now + 0.85);
    }
  }
  private deck(track: Track): Deck {
    const audio = new Audio();
    audio.preload = 'auto';
    const source = this.context.createMediaElementSource(audio);
    const gain = this.context.createGain();
    source.connect(gain).connect(this.master);
    const deck: Deck = { track, audio, gain, source, ready: false };
    audio.addEventListener('canplay', () => {
      deck.ready = true;
      if (deck === this.active && this.state?.music.playing) this.play(deck);
    });
    audio.addEventListener('error', () => {
      if (this.destroyed || (deck !== this.active && deck !== this.next)) return;
      deck.ready = false;
      this.failure(`Could not load “${track.title}”. Try another track.`, this.revision, deck === this.active);
    });
    audio.src = `/media/${track.id}`;
    audio.load();
    return deck;
  }
  private play(deck: Deck) {
    void deck.audio.play().catch(() => {
      if (!this.destroyed && this.state?.music.playing && (deck === this.active || deck === this.next)) {
        this.failure('Audio playback was blocked. Check the OBS Browser Source audio settings.', this.revision);
      }
    });
  }
  private drop(deck: Deck | null) {
    if (!deck) return;
    deck.audio.pause(); deck.audio.removeAttribute('src'); deck.audio.load();
    deck.source.disconnect(); deck.gain.disconnect();
  }
  sync(state: Snapshot) {
    if (this.destroyed) return;
    this.state = state;
    if (this.alarm !== null && state.timer.alarm > this.alarm) this.ding();
    this.alarm = Math.max(this.alarm ?? state.timer.alarm, state.timer.alarm);
    if (this.advancing && this.revision === state.music.revision) return;
    const track = state.music.queue[state.music.index];
    this.master.gain.setTargetAtTime(state.settings.volume / 100, this.context.currentTime, 0.03);
    if (this.revision !== state.music.revision || this.active?.track.id !== track?.id) {
      const promoted = this.advancing && this.active?.track.id === track?.id;
      this.revision = state.music.revision;
      this.advancing = false;
      if (!promoted) {
        this.drop(this.active); this.drop(this.next);
        this.active = track ? this.deck(track) : null; this.next = null; this.fading = null;
      }
    }
    if (this.active?.audio.error && state.music.playing) this.failure('The next track could not load. Select another track.', this.revision);
    if (!state.music.playing) {
      this.active?.audio.pause(); this.next?.audio.pause();
    } else {
      if (this.active?.ready && this.active.audio.paused && !this.active.audio.ended) this.play(this.active);
      if (this.fading && this.next?.ready && this.next.audio.paused) this.play(this.next);
    }
    const nextTrack = state.music.queue[state.music.index + 1];
    if (!this.fading && this.next?.track.id !== nextTrack?.id) {
      this.drop(this.next); this.next = nextTrack && track ? this.deck(nextTrack) : null;
      if (this.next) this.next.gain.gain.value = 0;
    }
  }
  private tick() {
    const state = this.state;
    const a = this.active;
    if (!state?.music.playing || !a || this.advancing || this.destroyed) return;
    const b = this.next;
    const seconds = b?.ready ? Math.min(fadeSeconds(state.settings.crossfade, a.audio.duration, b.audio.duration), Math.max(0, a.audio.duration - a.audio.currentTime)) : 0;
    if (!this.fading && b?.ready && seconds > 0 && a.audio.duration - a.audio.currentTime <= seconds && !a.audio.ended) {
      this.fading = { start: b.audio.currentTime, duration: seconds };
      this.play(b);
    }
    if (this.fading && b) {
      // Media time stops on pause or buffering, keeping the fade aligned with audible playback.
      const p = (b.audio.currentTime - this.fading.start) / this.fading.duration;
      const [outgoing, incoming] = fadeGains(p);
      a.gain.gain.setTargetAtTime(outgoing, this.context.currentTime, 0.03);
      b.gain.gain.setTargetAtTime(incoming, this.context.currentTime, 0.03);
      if (p >= 1 || a.audio.ended) this.finish();
    } else if (a.audio.ended) this.finish();
  }
  private finish() {
    if (this.advancing) return;
    this.advancing = true;
    const revision = this.revision;
    this.drop(this.active);
    this.active = this.next; this.next = null; this.fading = null;
    if (this.active) {
      this.active.gain.gain.value = 1;
      if (this.active.ready) this.play(this.active);
    }
    void this.advance(revision).catch(() => {
      this.failure('Audio connection lost. The overlay will reconnect automatically.', revision);
      this.destroy();
    });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; clearInterval(this.interval);
    this.drop(this.active); this.drop(this.next);
    this.active = null; this.next = null;
    void this.context.close();
  }
}
