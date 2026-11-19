import { defaults, validateSettings, type Phase, type Settings, type Snapshot, type Track } from '../shared.js';

export class Session {
  settings: Settings;
  phase: Phase = 'focus';
  phaseRevision = 0;
  completed = 0;
  alarm = 0;
  remaining: number;
  deadline: number | null = null;
  lastTick: number;
  queue: Track[] = [];
  index = -1;
  playing = false;
  revision = 0;
  player: string | null = null;
  constructor(settings: Settings = defaults, now = Date.now()) {
    this.settings = validateSettings(settings);
    this.remaining = this.duration();
    this.lastTick = now;
  }
  duration() { return this.settings[this.phase] * 60_000; }
  tick(now = Date.now()) {
    const slept = now - this.lastTick > 5000;
    this.lastTick = now;
    if (this.deadline === null) return;
    this.remaining = Math.max(0, this.deadline - now);
    if (this.remaining === 0) { this.alarm++; this.advance(now, !slept); }
  }
  advance(now = Date.now(), allowAuto = true) {
    this.phaseRevision++;
    if (this.phase === 'focus') {
      this.completed++;
      this.phase = this.completed >= this.settings.interval ? 'long' : 'short';
    } else {
      if (this.phase === 'long') this.completed = 0;
      this.phase = 'focus';
    }
    this.remaining = this.duration();
    this.deadline = this.settings.autoStart && allowAuto ? now + this.remaining : null;
  }
  timer(action: string, now = Date.now(), phaseRevision = this.phaseRevision) {
    this.tick(now);
    if (action === 'toggle') this.deadline = this.deadline === null ? now + this.remaining : null;
    else if (action === 'start') { if (this.deadline === null) this.deadline = now + this.remaining; }
    else if (action === 'pause') this.deadline = null;
    else if (action === 'reset') { this.deadline = null; this.remaining = this.duration(); }
    else if (action === 'skip') { if (phaseRevision === this.phaseRevision) this.advance(now); }
    else throw Error('Unknown timer command.');
  }
  music(action: string) {
    if (action === 'toggle') {
      if (!this.queue.length) throw Error('Select a track in the terminal first.');
      if (this.index < 0) this.index = 0;
      this.playing = !this.playing;
    } else if (action === 'next' || action === 'previous') {
      if (!this.queue.length) return;
      const next = this.index + (action === 'next' ? 1 : -1);
      if (next >= this.queue.length) { this.playing = false; this.index = -1; }
      else this.index = Math.max(0, next);
      this.revision++;
    } else throw Error('Unknown music command.');
  }
  select(tracks: Track[], start: number) {
    if (!tracks[start]) throw Error('Track not found.');
    this.queue = tracks.slice(); this.index = start; this.playing = true; this.revision++;
  }
  snapshot(now = Date.now()): Snapshot {
    return { settings: this.settings, timer: { phase: this.phase, phaseRevision: this.phaseRevision, running: this.deadline !== null, deadline: this.deadline,
      remaining: this.deadline === null ? this.remaining : Math.max(0, this.deadline - now), completed: this.completed, alarm: this.alarm }, music: { queue: this.queue, index: this.index,
      playing: this.playing, revision: this.revision, player: this.player }, now };
  }
}
