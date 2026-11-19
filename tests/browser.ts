import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { idFor } from '../src/server/library.js';
import type { Snapshot } from '../src/shared.js';

const folder = await mkdtemp(join(tmpdir(), 'still-browser-'));
function tone(frequency: number) {
  const rate = 16000, seconds = 6, size = rate * seconds * 2;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF'); wav.writeUInt32LE(size + 36, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(size, 40);
  for (let i = 0; i < rate * seconds; i++) wav.writeInt16LE(Math.round(Math.sin(i / rate * frequency * 2 * Math.PI) * 1000), 44 + i * 2);
  return wav;
}
await writeFile(join(folder, 'A.wav'), tone(220));
await writeFile(join(folder, 'B.wav'), tone(330));
await writeFile(join(folder, 'Broken.mp3'), 'This is not an audio file.');
const longTitle = 'A very long quiet evening soundtrack for studying under the stars '.repeat(3).trim();
await writeFile(join(folder, `${longTitle}.wav`), tone(220));
const origin = 'http://127.0.0.1:4197';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--port', '4197', '--music-dir', folder, '--data-dir', join(folder, 'state')], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const errors: string[] = [];
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.addInitScript(() => {
    const win = window as any;
    win.__audios = [];
    win.__contexts = [];
    win.__bells = [];
    win.__alarmFrames = [];
    const OriginalAudio = window.Audio;
    win.Audio = class extends OriginalAudio {
      constructor(src?: string) {
        super(src); win.__audios.push(this);
        this.addEventListener('playing', () => console.log('STILL_AUTOPLAY:' + JSON.stringify({ gesture: navigator.userActivation.hasBeenActive, running: win.__contexts.some((c: AudioContext) => c.state === 'running') })));
      }
    };
    const OriginalContext = window.AudioContext;
    win.AudioContext = class extends OriginalContext {
      constructor(options?: AudioContextOptions) { super(options); win.__contexts.push(this); }
      createOscillator() {
        const tone = super.createOscillator();
        const start = tone.start.bind(tone);
        tone.start = (when?: number) => { win.__bells.push(tone.frequency.value); start(when); };
        return tone;
      }
    };
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as any).__events = this;
        this.addEventListener('message', event => win.__alarmFrames.push(JSON.parse(event.data).timer.alarm));
      }
    };
  });
const post = async (data: object) => {
  const response = await fetch(`${origin}/api/command`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Still': '1' }, body: JSON.stringify(data) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
async function waitState(check: (snapshot: Snapshot) => boolean, timeout = 12_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const snapshot: Snapshot = await (await fetch(`${origin}/api/state`)).json();
    if (check(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Timed out waiting for the server state.');
}
try {
  await new Promise<void>((resolve, reject) => {
    if (output.includes('Still  ')) { resolve(); return; }
    const timeout = setTimeout(() => reject(Error(`Server did not start: ${output}`)), 10_000);
    server.stdout.on('data', () => { if (output.includes('Still  ')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited ${code}: ${output}`)); });
  });
  // No evaluation, selector action, or input is sent to this cold source before audio starts.
  await post({ type: 'select', ids: [idFor(join(folder, 'A.wav'))], index: 0 });
  const cold = await context.newPage();
  const coldPlayback = new Promise<{ gesture: boolean; running: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Cold OBS source did not autoplay.')), 10_000);
    cold.on('console', message => {
      if (message.text().startsWith('STILL_AUTOPLAY:')) { clearTimeout(timer); resolve(JSON.parse(message.text().slice('STILL_AUTOPLAY:'.length))); }
    });
  });
  await cold.goto(`${origin}/overlay`);
  assert.deepEqual(await coldPlayback, { gesture: false, running: true });
  await cold.close();
  await post({ type: 'music', action: 'next' });
  const operator = await context.newPage();
  await operator.goto(origin);
  assert.ok(await operator.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some(font => font.family === 'Nunito' && font.status === 'loaded'); }));
  const operatorTimerY = (await operator.locator('.timer-card').boundingBox())!.y;
  assert.equal(await operator.getByRole('heading').count(), 0);
  assert.equal(await operator.getByRole('link').count(), 0);
  assert.equal(await operator.getByRole('region', { name: 'Music player' }).count(), 0);
  await operator.getByRole('button', { name: 'Begin session' }).click();
  await operator.getByRole('button', { name: 'Pause session' }).waitFor();
  const overlay = await context.newPage();
  await overlay.goto(`${origin}/overlay`);
  await overlay.getByRole('timer').waitFor();
  assert.equal(await overlay.getByRole('button').count(), 0);
  assert.equal(await operator.getByRole('timer').textContent(), await overlay.getByRole('timer').textContent());
  await overlay.reload();
  await overlay.getByRole('timer').waitFor();
  await overlay.evaluate(() => document.fonts.ready.then(() => {}));
  const overlayTimerY = (await overlay.locator('.timer-card').boundingBox())!.y;
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).timer.running, true);
  const running = await (await fetch(`${origin}/api/state`)).json();
  const seconds = await operator.evaluate(async snapshot => {
    const values: number[] = [];
    const sample = setInterval(() => {
      const [minutes, seconds] = document.querySelector('[role="timer"]')!.textContent!.split(':').map(Number);
      values.push(minutes * 60 + seconds);
    }, 50);
    const delayed = { ...snapshot, now: snapshot.now - 800, timer: { ...snapshot.timer, remaining: snapshot.timer.remaining + 800 } };
    const packets = setInterval(() => {
      (window as any).__events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(delayed) }));
    }, 230);
    await new Promise(resolve => setTimeout(resolve, 3200));
    clearInterval(sample); clearInterval(packets);
    return values;
  }, running);
  for (let i = 1; i < seconds.length; i++) assert.ok(seconds[i - 1] - seconds[i] >= 0 && seconds[i - 1] - seconds[i] <= 1, `Countdown jumped: ${seconds[i - 1]} → ${seconds[i]}`);
  assert.ok(seconds[0] - seconds.at(-1)! >= 2, 'Countdown must keep advancing despite delayed broadcasts.');
  assert.ok(await overlay.getByRole('timer').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 300));
  assert.ok(await overlay.locator('.phase-row').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 48));
  await post({ type: 'timer', action: 'reset' });
  await operator.getByRole('button', { name: 'Open settings' }).click();
  await operator.screenshot({ path: '/tmp/still-settings-1080.png' });
  await post({ type: 'settings', settings: { volume: 17, crossfade: 3 } });
  await operator.getByRole('combobox', { name: /Theme/ }).selectOption('light');
  await operator.getByLabel('Gentle background motion').uncheck();
  await operator.getByRole('button', { name: 'Save preferences' }).click();
  await operator.locator('.room.light.static').waitFor();
  const savedSettings = (await waitState(s => s.settings.theme === 'light')).settings;
  assert.equal(savedSettings.volume, 17);
  assert.equal(savedSettings.crossfade, 3);
  await operator.screenshot({ path: '/tmp/still-light-1080.png' });
  await post({ type: 'settings', settings: { theme: 'dark', motion: true, crossfade: 2, transparent: true } });
  await operator.locator('.room:not(.light)').waitFor();
  await operator.screenshot({ path: '/tmp/still-dark-1080.png' });
  await operator.setViewportSize({ width: 390, height: 844 });
  const mobileTimerY = (await operator.locator('.timer-card').boundingBox())!.y;
  await operator.screenshot({ path: '/tmp/still-mobile.png' });
  await operator.getByRole('button', { name: 'Open settings' }).click();
  await operator.screenshot({ path: '/tmp/still-settings-mobile.png' });
  await operator.getByRole('button', { name: 'Close settings' }).click();
  await operator.setViewportSize({ width: 1920, height: 1080 });
  await post({ type: 'settings', settings: { interval: 2, autoStart: false } });
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(16, 28, 27)');
  const focusRevision = (await waitState(s => s.timer.phase === 'focus')).timer.phaseRevision;
  await operator.getByRole('button', { name: 'Skip current phase' }).click();
  await operator.locator('.room.break-time').waitFor();
  await overlay.locator('.room.break-time').waitFor();
  const lateSkip = await post({ type: 'timer', action: 'skip', phaseRevision: focusRevision });
  assert.equal(lateSkip.timer.phase, 'short');
  await operator.waitForFunction(() => {
    const color = getComputedStyle(document.querySelector('.room')!).backgroundColor;
    return color !== 'rgb(16, 28, 27)' && color !== 'rgb(8, 39, 37)';
  });
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(8, 39, 37)');
  await operator.screenshot({ path: '/tmp/still-break-dark.png' });
  await post({ type: 'settings', settings: { theme: 'light' } });
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(225, 243, 237)');
  await operator.screenshot({ path: '/tmp/still-break-light.png' });
  await post({ type: 'timer', action: 'skip' });
  await post({ type: 'timer', action: 'skip' });
  await operator.locator('.room.break-time .phase-pill').filter({ hasText: 'Long break' }).waitFor();
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(230, 243, 255)');
  await operator.screenshot({ path: '/tmp/still-long-break-light.png' });
  await post({ type: 'settings', settings: { theme: 'dark' } });
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(19, 47, 69)');
  await operator.screenshot({ path: '/tmp/still-long-break-dark.png' });
  await post({ type: 'timer', action: 'skip' });
  await post({ type: 'settings', settings: { theme: 'dark', interval: 4 } });
  await operator.locator('.room:not(.break-time)').waitFor();
  await operator.waitForFunction(() => getComputedStyle(document.querySelector('.room')!).backgroundColor === 'rgb(16, 28, 27)');

  await overlay.locator('.transparent').waitFor();
  assert.equal(await overlay.locator('.room').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await overlay.setViewportSize({ width: 640, height: 360 });
  assert.ok(await overlay.getByRole('timer').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= 640; }));
  await operator.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await operator.locator('.orb.one').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await operator.locator('.room').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  const badOrigin = await fetch(`${origin}/api/command`, { method: 'POST', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json', 'X-Still': '1' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const id = idFor(join(folder, 'A.wav'));
  const range = await fetch(`${origin}/media/${id}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), 'RIFF');
  await rm(join(folder, 'A.wav')); await symlink('/etc/passwd', join(folder, 'A.wav'));
  assert.equal((await fetch(`${origin}/media/${id}`)).status, 400);
  await rm(join(folder, 'A.wav')); await writeFile(join(folder, 'A.wav'), tone(220));
  await post({ type: 'select', ids: [idFor(join(folder, `${longTitle}.wav`))], index: 0 });
  await post({ type: 'music', action: 'toggle' });
  await overlay.setViewportSize({ width: 1920, height: 1080 });
  await overlay.getByText(longTitle, { exact: true }).waitFor();
  assert.equal(await overlay.locator('.track-title').evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 32);
  assert.equal(await overlay.locator('.track-meta').textContent(), 'Local library · Music');
  assert.equal(await overlay.locator('.track-source').textContent(), 'Source: Local folder');
  assert.ok(Math.abs((await overlay.locator('.timer-card').boundingBox())!.y - overlayTimerY) < 1, 'Song metadata must not move the overlay timer.');
  assert.ok(Math.abs((await operator.locator('.timer-card').boundingBox())!.y - operatorTimerY) < 1, 'Song metadata must not move the operator timer.');
  const songRegion = (await overlay.locator('.song-region').boundingBox())!;
  const song = (await overlay.locator('.now-playing').boundingBox())!;
  assert.ok(Math.abs(song.y + song.height / 2 - (songRegion.y + songRegion.height / 2)) < 1, 'Song details must be centered below the timer.');
  assert.equal(await overlay.locator('.music-note').count(), 1);
  const fadeSamples = await overlay.locator('.track-details').evaluate(el => {
    const animation = el.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === 'song-fade')!;
    animation.pause();
    animation.currentTime = 0; const hidden = Number(getComputedStyle(el).opacity);
    animation.currentTime = 6000; const shown = Number(getComputedStyle(el).opacity);
    animation.currentTime = 23500; const faded = Number(getComputedStyle(el).opacity);
    return { hidden, shown, faded };
  });
  assert.equal(fadeSamples.hidden, 0); assert.equal(fadeSamples.shown, 0.82); assert.equal(fadeSamples.faded, 0);
  await overlay.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await overlay.locator('.track-details').evaluate(el => getComputedStyle(el).opacity), '0.82');
  await post({ type: 'settings', settings: { showTitle: false } });
  await overlay.getByRole('region', { name: 'Music player' }).waitFor({ state: 'detached' });
  assert.ok(Math.abs((await overlay.locator('.timer-card').boundingBox())!.y - overlayTimerY) < 1);
  await post({ type: 'settings', settings: { showTitle: true } });
  await overlay.getByRole('region', { name: 'Music player' }).waitFor();
  assert.ok(await overlay.locator('main').evaluate(el => el.getBoundingClientRect().height <= 1080));
  await overlay.screenshot({ path: '/tmp/still-overlay-1080.png' });
  await overlay.setViewportSize({ width: 390, height: 844 });
  assert.ok(await overlay.getByRole('timer').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= 390; }));
  assert.ok(await overlay.locator('body').evaluate(el => el.scrollWidth <= 390));
  await overlay.screenshot({ path: '/tmp/still-overlay-mobile.png' });
  await operator.setViewportSize({ width: 390, height: 844 });
  assert.ok(Math.abs((await operator.locator('.timer-card').boundingBox())!.y - mobileTimerY) < 1, 'Phone timer must remain anchored when a track appears.');
  await operator.screenshot({ path: '/tmp/still-mobile-song.png' });
  await operator.setViewportSize({ width: 1920, height: 1080 });

  const player = overlay;
  const playerId1 = await player.evaluate(() => new URL((window as any).__events.url).searchParams.get('id'));
  await waitState(s => s.music.player === playerId1);
  const owner = (await (await fetch(`${origin}/api/state`)).json()).music.player;
  const duplicate = await context.newPage();
  await duplicate.goto(`${origin}/overlay`);
  await duplicate.getByRole('timer').waitFor();
  await player.bringToFront();
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).music.player, owner);
  assert.equal(await operator.evaluate(() => (window as any).__audios.length), 0);
  await post({ type: 'select', ids: [id, idFor(join(folder, 'B.wav'))], index: 0 });
  await player.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).filter(a => !a.paused && !a.ended && a.readyState >= 3).length === 2, null, { timeout: 12_000 });
  assert.ok(await player.evaluate(() => ((window as any).__contexts as AudioContext[]).some(c => c.state === 'running')));
  assert.equal(await duplicate.evaluate(() => ((window as any).__audios as HTMLAudioElement[]).filter(a => !a.paused).length), 0);
  await duplicate.close();
  await post({ type: 'music', action: 'toggle' });
  await player.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).filter(a => a.src && !a.paused).length === 0);
  const positions = await player.evaluate(() => ((window as any).__audios as HTMLAudioElement[]).map(a => a.currentTime));
  await player.waitForTimeout(300);
  const paused = await player.evaluate(() => ((window as any).__audios as HTMLAudioElement[]).map(a => a.currentTime));
  positions.forEach((value, i) => assert.ok(Math.abs(value - paused[i]) < 0.05));
  await post({ type: 'settings', settings: { volume: 17 } });
  await post({ type: 'music', action: 'toggle' });
  await waitState(s => s.music.index === 1);
  await waitState(s => !s.music.playing);
  await post({ type: 'select', ids: [id, idFor(join(folder, 'B.wav'))], index: 0 });
  await post({ type: 'music', action: 'next' });
  await post({ type: 'music', action: 'previous' });
  assert.ok(await player.evaluate(() => ((window as any).__audios as HTMLAudioElement[]).filter(a => a.src && !a.paused).length <= 2));
  const deckCount = await player.evaluate(() => (window as any).__audios.length as number);
  await post({ type: 'select', ids: [id, idFor(join(folder, 'B.wav'))], index: 0 });
  await player.waitForFunction(count => (window as any).__audios.length > count, deckCount);
  await player.reload();
  const playerId2 = await player.evaluate(() => new URL((window as any).__events.url).searchParams.get('id'));
  await waitState(s => s.music.player === playerId2);
  await player.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).some(a => !a.paused && a.readyState >= 3));
  const afterRefresh = await (await fetch(`${origin}/api/state`)).json();
  assert.ok(afterRefresh.music.player); assert.equal(afterRefresh.music.playing, true);
  await post({ type: 'select', ids: [idFor(join(folder, 'Broken.mp3'))], index: 0 });
  await player.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).some(a => a.error !== null));
  await waitState(s => !s.music.playing);
  const bellsBefore = await player.evaluate(() => (window as any).__bells.length as number);
  await post({ type: 'settings', settings: { focus: 1 / 60, short: 1 / 60, long: 1 / 60, interval: 2, autoStart: true } });
  await post({ type: 'timer', action: 'reset' });
  await post({ type: 'timer', action: 'toggle' });
  await waitState(s => s.timer.phase === 'long');
  await waitState(s => s.timer.phase === 'focus' && s.timer.completed === 0);
  await post({ type: 'timer', action: 'pause' });
  await player.waitForFunction(before => (window as any).__bells.length === before + 12, bellsBefore, { timeout: 3000 });
  assert.deepEqual(await player.evaluate(() => (window as any).__bells.slice(-3)), [880, 1760, 2464]);
  assert.equal(await operator.evaluate(() => (window as any).__bells.length), 0);
  const bellsAfter = await player.evaluate(() => (window as any).__bells.length as number);
  await post({ type: 'timer', action: 'skip' });
  await player.waitForTimeout(600);
  assert.equal(await player.evaluate(() => (window as any).__bells.length), bellsAfter);

  await post({ type: 'select', ids: [id], index: 0 });
  await player.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).some(a => !a.paused));
  const successor = await context.newPage();
  await successor.goto(`${origin}/overlay`);
  await successor.getByRole('timer').waitFor();
  await player.close();
  const successorId = await successor.evaluate(() => new URL((window as any).__events.url).searchParams.get('id'));
  await waitState(s => s.music.player === successorId);
  await successor.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).some(a => !a.paused && a.readyState >= 3));
  assert.equal(await successor.evaluate(() => (window as any).__bells.length), 0, 'Owner handoff must not replay an old bell.');
  const contextCount = await successor.evaluate(() => (window as any).__contexts.length as number);
  let droppedAdvance = false;
  await successor.route('**/api/command', async route => {
    if (!droppedAdvance && route.request().postDataJSON().type === 'advance') {
      droppedAdvance = true;
      await route.abort();
    } else await route.continue();
  });
  await post({ type: 'select', ids: [id, idFor(join(folder, 'B.wav'))], index: 0 });
  await successor.waitForFunction(count => {
    const contexts: AudioContext[] = (window as any).__contexts;
    return contexts.length > count && contexts[count - 1].state === 'closed' && contexts.at(-1)?.state === 'running';
  }, contextCount, { timeout: 12_000 });
  assert.ok(droppedAdvance);
  const recovered = await waitState(s => s.music.index === 1 && s.music.playing);
  assert.equal(recovered.music.player, successorId);
  server.kill('SIGTERM');
  await once(server, 'exit');
  await successor.waitForFunction(() => ((window as any).__audios as HTMLAudioElement[]).every(a => !a.src || a.paused));
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: 1080p themes, timer sync, settings, overlay resize/transparency, reduced motion, CSRF, byte ranges, symlink rejection, automatic OBS-policy audio without clicks, real two-deck overlap/pause/advance, refresh recovery, duplicate suppression, and owner handoff.');
} catch (error) {
  console.error('Page errors:', errors, 'Server:', output);
  for (const page of context.pages()) {
    console.error(page.url(), (await page.locator('body').innerText()).slice(-1800));
    console.error(await page.evaluate(() => ({ alarms: (window as any).__alarmFrames, oscillator: (window as any).__contexts?.[0]?.createOscillator.toString(), bells: (window as any).__bells, contexts: (window as any).__contexts?.map((c: AudioContext) => ({ state: c.state, time: c.currentTime })), audios: (window as any).__audios?.map((a: HTMLAudioElement) => ({ src: a.getAttribute('src'), paused: a.paused, ended: a.ended, time: a.currentTime, duration: a.duration, ready: a.readyState, network: a.networkState, error: a.error?.message })) })));
    await page.screenshot({ path: `/tmp/still-failed-${context.pages().indexOf(page)}.png` });
  }
  throw error;
} finally {
  await browser.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  await rm(folder, { recursive: true, force: true });
}
