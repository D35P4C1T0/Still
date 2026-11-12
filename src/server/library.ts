import { createHash } from 'node:crypto';
import { readdir, realpath, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import type { Track, Provider } from '../shared.js';

export interface MediaTrack extends Track { media: string }
export const idFor = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
export const publicTrack = ({ media: _, ...track }: MediaTrack): Track => track;
export const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
export async function localLibrary(directory?: string): Promise<MediaTrack[]> {
  if (!directory) return [];
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw Error('The music directory is not a folder.');
  const tracks: MediaTrack[] = [];
  async function walk(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      // Symlinks are deliberately excluded from discovery and rechecked before serving.
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(mp3|wav|ogg|m4a|flac|webm)$/i.test(entry.name)) {
        tracks.push({ id: idFor(path), title: entry.name.slice(0, -extname(entry.name).length), artist: 'Local library',
          category: relative(root, folder) || 'Music', provider: 'local', source: '', credit: 'Local file — check your own stream permissions.', media: path });
      }
    }
  }
  await walk(root);
  return tracks.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export async function atomicJSON(file: string, data: unknown) {
  await mkdir(join(file, '..'), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export async function fetchText(url: string, limit = 4_000_000): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 (Still local music browser)' } });
  if (!response.ok || !response.body) throw Error(`Catalog request failed (${response.status}).`);
  let data = '';
  let size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('Catalog exceeds the size limit.');
    data += decoder.decode(chunk, { stream: true });
  }
  return data + decoder.decode();
}
export function safeMedia(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'purrplecat-audio.pages.dev' || parsed.port || parsed.username || parsed.password) throw Error('Unexpected music host.');
  return parsed.href;
}
export function parseOpenLofi(text: string): MediaTrack[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data.tracks) || data.tracks.length > 5000) throw Error('Invalid Open Lo-Fi catalog.');
  return data.tracks.map((track: Record<string, unknown>) => {
    if (typeof track.title !== 'string' || typeof track.category !== 'string' || typeof track.filename !== 'string' || !/^[a-z0-9-]+\.mp3$/.test(track.filename)) throw Error('Invalid Open Lo-Fi track.');
    return { id: idFor(`lofi:${track.filename}`), title: track.title, artist: 'Open Lo-Fi / btahir', category: track.category,
      provider: 'openlofi', source: 'https://github.com/btahir/open-lofi', credit: `${track.title} — Open Lo-Fi / btahir. CC0-1.0. https://github.com/btahir/open-lofi`, media: track.filename };
  });
}
function decodeHTML(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[entity.toLowerCase()];
  });
}
export function parseRoyalty(text: string): MediaTrack[] {
  const tracks: MediaTrack[] = [];
  // shortcut: consumes the public catalog's data attributes; update this parser if its markup changes.
  for (const match of text.matchAll(/<li\b[^>]*\bdata-clip="[^"]+"[^>]*>/g)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/\b(data-[\w-]+)="([^"]*)"/g)].map(m => [m[1], decodeHTML(m[2])]));
    const title = attrs['data-t'];
    const media = safeMedia(attrs['data-clip']);
    if (!title || tracks.length >= 5000) throw Error('Invalid RoyaltyMusicFree catalog.');
    tracks.push({ id: idFor(media), title, artist: 'Purrple Cat', category: attrs['data-a'] || 'Lo-fi', provider: 'royalty',
      source: `https://royaltymusicfree.com/#t-${attrs['data-k'] || ''}`,
      credit: `${title} by Purrple Cat — https://purrplecat.com/ — CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ — via https://royaltymusicfree.com/`, media });
  }
  if (!tracks.length) throw Error('RoyaltyMusicFree catalog markup changed or is unavailable.');
  return tracks;
}
export class Library {
  tracks = new Map<string, MediaTrack>();
  catalogs = new Map<Provider, MediaTrack[]>();
  private pending = new Map<Provider, Promise<{ tracks: Track[]; warning: string }>>();
  constructor(public directory: string, public localDirectory?: string) {}
  set(provider: Provider, tracks: MediaTrack[]) {
    this.catalogs.set(provider, tracks);
    for (const track of tracks) this.tracks.set(track.id, track);
  }
  async load(provider: Provider, refresh = false): Promise<{ tracks: Track[]; warning: string }> {
    if (this.pending.has(provider)) return this.pending.get(provider)!;
    const task = this.loadCatalog(provider, refresh);
    this.pending.set(provider, task);
    try { return await task; } finally { this.pending.delete(provider); }
  }
  private async loadCatalog(provider: Provider, refresh: boolean) {
    let tracks = this.catalogs.get(provider);
    let warning = '';
    if (provider === 'local' && refresh) {
      tracks = await localLibrary(this.localDirectory);
      this.set(provider, tracks);
    }
    if (provider !== 'local' && (refresh || !tracks)) {
      const path = join(this.directory, `${provider}.json`);
      const parse = provider === 'openlofi' ? parseOpenLofi : parseRoyalty;
      try {
        const text = await fetchText(provider === 'openlofi' ? 'https://raw.githubusercontent.com/btahir/open-lofi/v1.0.0/catalog.json' : 'https://royaltymusicfree.com/');
        tracks = parse(text);
        await atomicJSON(path, { text });
      } catch (error) {
        warning = error instanceof Error ? error.message : 'Provider unavailable.';
        if (!tracks) {
          try { tracks = parse(JSON.parse(await readFile(path, 'utf8')).text); }
          catch { throw Error(`${warning} No usable cached catalog.`); }
        }
        warning += ' Using the last catalog.';
      }
      this.set(provider, tracks!);
    }
    return { tracks: (tracks || []).map(publicTrack), warning };
  }
}
