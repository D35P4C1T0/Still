export type Phase = 'focus' | 'short' | 'long';
export type Provider = 'local' | 'openlofi' | 'royalty';
export interface Settings {
  focus: number; short: number; long: number; interval: number;
  autoStart: boolean; theme: 'dark' | 'light'; motion: boolean;
  transparent: boolean; showTitle: boolean; crossfade: number; volume: number;
}
export const defaults: Settings = {
  focus: 25, short: 5, long: 15, interval: 4, autoStart: false,
  theme: 'dark', motion: true, transparent: false, showTitle: true,
  crossfade: 5, volume: 50,
};
export interface Track {
  id: string; title: string; artist: string; category: string; provider: Provider;
  source: string; credit: string;
}
export interface Snapshot {
  settings: Settings;
  timer: { phase: Phase; phaseRevision: number; running: boolean; deadline: number | null; remaining: number; completed: number; alarm: number };
  music: { queue: Track[]; index: number; playing: boolean; revision: number; player: string | null };
  now: number;
}
export const phaseNames: Record<Phase, string> = { focus: 'Focus', short: 'Short break', long: 'Long break' };
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Settings must be an object.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(defaults, key))) throw Error('Unknown setting.');
  const s = { ...defaults, ...data } as Settings;
  for (const key of ['focus', 'short', 'long'] as const) {
    if (!Number.isFinite(s[key]) || s[key] < 1 / 60 || s[key] > 240) throw Error(`${key} must be between 1 second and 240 minutes.`);
  }
  if (!Number.isInteger(s.interval) || s.interval < 1 || s.interval > 12) throw Error('Sessions must be an integer from 1 to 12.');
  if (!Number.isFinite(s.crossfade) || s.crossfade < 0 || s.crossfade > 30) throw Error('Crossfade must be 0–30 seconds.');
  if (!Number.isInteger(s.volume) || s.volume < 0 || s.volume > 100) throw Error('Volume must be an integer from 0 to 100.');
  for (const key of ['autoStart', 'motion', 'transparent', 'showTitle'] as const) {
    if (typeof s[key] !== 'boolean') throw Error(`${key} must be true or false.`);
  }
  if (!['dark', 'light'].includes(s.theme)) throw Error('Choose a dark or light theme.');
  return s;
}
