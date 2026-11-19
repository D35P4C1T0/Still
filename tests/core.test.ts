import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile, truncate, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/server/session.js';
import { defaults, validateSettings, clock } from '../src/shared.js';
import { fadeSeconds, fadeGains } from '../src/audio.js';
import { localLibrary, inside, parseOpenLofi, parseRoyalty, safeMedia, Library, atomicJSON } from '../src/server/library.js';
import { parseRange } from '../src/server/http.js';
import { MusicCache } from '../src/server/remote-zip.js';

test('timer pauses against a deadline, resets without counting, and skips with progress', () => {
  const s = new Session(defaults, 0);
  s.timer('toggle', 0); s.tick(1234);
  assert.equal(s.remaining, 1_500_000 - 1234);
  s.timer('toggle', 1500);
  s.tick(10_000); assert.equal(s.remaining, 1_498_500);
  s.timer('toggle', 10_000); s.tick(11_000);
  assert.equal(s.remaining, 1_497_500);
  s.timer('reset', 11_000); assert.equal(s.remaining, 1_500_000);
  assert.equal(s.completed, 0);
  s.timer('skip', 11_000); assert.equal(s.phase, 'short'); assert.equal(s.completed, 1);
});
test('snapshots between timer ticks use the current deadline rather than stale remaining time', () => {
  const s = new Session(defaults, 0);
  s.timer('toggle', 0);
  s.tick(500);
  assert.equal(s.snapshot(900).timer.remaining, 1_499_100);
  assert.equal(s.snapshot(900).timer.deadline, 1_500_000);
  assert.equal(s.snapshot(1100).timer.remaining, 1_498_900);
  s.timer('toggle', 1200);
  assert.equal(s.snapshot(2000).timer.remaining, 1_498_800);
  assert.equal(s.snapshot(2000).timer.deadline, null);
});
test('explicit start and pause are idempotent and preserve remaining time', () => {
  const s = new Session(defaults, 0);
  s.timer('start', 0);
  s.timer('start', 500);
  assert.equal(s.deadline, 1_500_000);
  s.timer('pause', 1000);
  s.timer('pause', 2000);
  assert.equal(s.remaining, 1_499_000);
  s.timer('start', 3000);
  assert.equal(s.deadline, 1_502_000);
});
test('the bell event advances once on natural completion, never on skip/reset/pause', () => {
  const s = new Session({ ...defaults, focus: 1 / 60 }, 0);
  s.timer('start', 0);
  s.tick(1000); s.tick(1500);
  assert.equal(s.snapshot(1500).timer.alarm, 1);
  s.timer('skip', 1500); s.timer('reset', 1500); s.timer('pause', 1500);
  assert.equal(s.alarm, 1);
  s.timer('start', 2000); s.tick(3000);
  assert.equal(s.alarm, 2);
});
test('skipping advances a full cycle, counts only focus phases, and honors auto-start', () => {
  for (const autoStart of [false, true]) {
    const s = new Session({ ...defaults, interval: 2, autoStart }, 0);
    for (const [phase, completed] of [['short', 1], ['focus', 1], ['long', 2], ['focus', 0]] as const) {
      s.timer('skip', 0);
      assert.equal(s.phase, phase);
      assert.equal(s.snapshot(0).timer.completed, completed);
      assert.equal(s.remaining, s.settings[phase] * 60_000);
      assert.equal(s.deadline !== null, autoStart);
    }
  }
});
test('skip cannot advance a phase that started after the command was issued', () => {
  for (const tickFirst of [false, true]) {
    const s = new Session({ ...defaults, focus: 1 / 60 }, 0);
    s.timer('start', 0);
    const focusRevision = s.snapshot(500).timer.phaseRevision;
    if (tickFirst) s.tick(1001);
    s.timer('skip', 1001, focusRevision);
    assert.equal(s.snapshot(1001).timer.phase, 'short');
    assert.equal(s.alarm, 1);
    s.timer('skip', 1002, s.snapshot(1001).timer.phaseRevision);
    assert.equal(s.snapshot(1002).timer.phase, 'focus');
    assert.equal(s.completed, 1);
  }
});
test('full cycles choose the long break and reset completed sessions afterwards', () => {
  const s = new Session({ ...defaults, focus: 1 / 60, short: 1 / 60, long: 1 / 60, interval: 2, autoStart: true }, 0);
  s.timer('toggle', 0); s.tick(1000);
  assert.equal(s.phase, 'short'); assert.equal(s.completed, 1);
  s.tick(2000); assert.equal(s.phase, 'focus');
  s.tick(3000); assert.equal(s.phase, 'long'); assert.equal(s.completed, 2);
  s.tick(4000); assert.equal(s.phase, 'focus'); assert.equal(s.completed, 0);
});
test('sleep recovery completes only the active phase and pauses the next one', () => {
  const s = new Session({ ...defaults, focus: 1, autoStart: true }, 0);
  s.timer('toggle', 0); s.tick(3_600_000);
  assert.equal(s.phase, 'short'); assert.equal(s.completed, 1); assert.equal(s.deadline, null);
});
test('changing settings does not change the current duration until reset', () => {
  const s = new Session(defaults, 0);
  s.settings = { ...s.settings, focus: 40 };
  assert.equal(s.remaining, 1_500_000);
  s.timer('reset', 0); assert.equal(s.remaining, 2_400_000);
  assert.equal(clock(60_001), '01:01'); assert.equal(clock(-20), '00:00');
});
test('settings validate numeric types, bounds, booleans, and unknown keys', () => {
  for (const value of [{ focus: '25' }, { volume: -1 }, { volume: 0.5 }, { interval: 1.5 }, { focus: Infinity }, { crossfade: 31 }, { motion: 1 }, { theme: 'pink' }, { unknown: 1 }]) {
    assert.throws(() => validateSettings(value));
  }
  assert.equal(validateSettings({ crossfade: 0 }).crossfade, 0);
  assert.equal(validateSettings({ focus: 1 / 60 }).focus, 1 / 60);
});
test('equal-power fade and short track clamping preserve configured limits', () => {
  assert.deepEqual(fadeGains(0), [1, 0]);
  const middle = fadeGains(0.5);
  assert.ok(Math.abs(middle[0] ** 2 + middle[1] ** 2 - 1) < 1e-10);
  assert.equal(fadeSeconds(5, 4, 2), 1); assert.equal(fadeSeconds(0, 4, 4), 0);
  assert.equal(fadeSeconds(5, NaN, 4), 0);
});
test('byte ranges support seeks and suffixes and reject invalid or multi ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9 });
  for (const range of ['bytes=10-', 'bytes=-0', 'bytes=4-1', 'bytes=0-1,4-5', 'bytes=-']) assert.throws(() => parseRange(range, 10));
});
test('library recursively discovers audio, excludes symlinks, and stays inside its root', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'still-library-'));
  try {
    await mkdir(join(folder, 'album')); await writeFile(join(folder, 'album', 'B.mp3'), '');
    await writeFile(join(folder, 'A.wav'), ''); await writeFile(join(folder, 'ignore.txt'), '');
    await symlink('/etc/passwd', join(folder, 'escape.mp3'));
    const tracks = await localLibrary(folder);
    assert.deepEqual(tracks.map(t => t.title), ['A', 'B']);
    assert.equal(tracks[1].category, 'album');
    assert.equal(inside(folder, join(folder, 'A.wav')), true);
    assert.equal(inside(folder, `${folder}-other/A.wav`), false);
    assert.equal(inside(folder, '/etc/passwd'), false);
    await atomicJSON(join(folder, 'nested', 'settings.json'), { volume: 50 });
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'nested', 'settings.json'), 'utf8')), { volume: 50 });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
const lofi = JSON.stringify({ tracks: [{ title: 'Quiet night', category: 'ambient', filename: 'quiet-night.mp3' }] });
const royalty = '<li data-k="clouds" data-t="Clouds &amp; Rain" data-a="Night" data-clip="https://purrplecat-audio.pages.dev/audio/night/01-clouds.mp3">';
test('catalogs preserve titles and credits and reject malformed data or unexpected media hosts', () => {
  assert.equal(parseOpenLofi(lofi)[0].media, 'quiet-night.mp3');
  assert.ok(parseOpenLofi(lofi)[0].credit.includes('CC0'));
  const r = parseRoyalty(royalty)[0];
  assert.equal(r.title, 'Clouds & Rain'); assert.ok(r.credit.includes('CC BY 4.0'));
  assert.throws(() => parseOpenLofi('{"tracks":[{"filename":"../../oops.mp3"}]}'));
  assert.throws(() => parseRoyalty('<html>Provider down</html>'));
  assert.throws(() => parseRoyalty(royalty.replace('purrplecat-audio.pages.dev', '127.0.0.1')));
  assert.throws(() => safeMedia('http://purrplecat-audio.pages.dev/test.mp3'));
});
test('provider failure uses a validated cached catalog without preventing local access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'still-catalog-'));
  const original = globalThis.fetch;
  try {
    await atomicJSON(join(dir, 'openlofi.json'), { text: lofi });
    globalThis.fetch = async () => { throw Error('Offline'); };
    const library = new Library(dir);
    const result = await library.load('openlofi');
    assert.equal(result.tracks.length, 1); assert.ok(result.warning.includes('last catalog'));
    assert.deepEqual(await library.load('local'), { tracks: [], warning: '' });
    await assert.rejects(library.load('royalty'), /No usable cached catalog/);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});
test('parallel cache misses both succeed when the cache needs eviction', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'still-cache-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const trackLimit = 32 * 1024 * 1024;
  for (let i = 0; i < 8; i++) {
    const file = join(folder, `old-${i}.mp3`);
    await writeFile(file, '');
    await truncate(file, trackLimit);
    await utimes(file, 0, 0);
  }
  // ZIP with first.mp3 and second.mp3 containing the strings "first" and "second".
  const archive = Buffer.from('UEsDBBQAAAAAAAAAIQBX7nGSBQAAAAUAAAAJAAAAZmlyc3QubXAzZmlyc3RQSwMEFAAAAAAAAAAhAGkRH7YGAAAABgAAAAoAAABzZWNvbmQubXAzc2Vjb25kUEsBAhQDFAAAAAAAAAAhAFfucZIFAAAABQAAAAkAAAAAAAAAAAAAAIABAAAAAGZpcnN0Lm1wM1BLAQIUAxQAAAAAAAAAIQBpER+2BgAAAAYAAAAKAAAAAAAAAAAAAACAASwAAABzZWNvbmQubXAzUEsFBgAAAAACAAIAbwAAAFoAAAAAAA==', 'base64');
  t.mock.method(globalThis, 'fetch', async (_: string, init: { method?: string; headers?: { Range: string } }) => {
    if (init.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(archive.length) } });
    const [start, end] = init.headers!.Range.match(/\d+/g)!.map(Number);
    return new Response(archive.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${archive.length}` } });
  });
  const cache = new MusicCache(folder);
  const results = await Promise.allSettled([cache.get('first.mp3'), cache.get('second.mp3')]);
  const contents = await Promise.all(results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return readFile(result.value, 'utf8');
  }));
  assert.deepEqual(contents, ['first', 'second']);
  const sizes = await Promise.all((await readdir(folder)).map(async name => (await stat(join(folder, name))).size));
  assert.ok(sizes.reduce((total, size) => total + size, 0) <= 8 * trackLimit);
});
test('queue navigation stops at the end and can restart', () => {
  const s = new Session();
  const tracks = parseOpenLofi(lofi);
  s.select(tracks, 0); s.music('next');
  assert.equal(s.playing, false); assert.equal(s.index, -1);
  s.music('toggle'); assert.equal(s.index, 0); assert.equal(s.playing, true);
});
