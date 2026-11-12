import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real terminal preserves rapid volume/fade keys, search priority, and restores terminal on quit', { skip: !existsSync('/usr/bin/script'), timeout: 20_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'still-tui-'));
  await writeFile(join(folder, 'A.wav'), '');
  await writeFile(join(folder, 'B.wav'), '');
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const cmd = [process.execPath, '--import', 'tsx', 'src/server/index.ts', '--dev', '--port', '4196', '--data-dir', folder, '--music-dir', folder].map(quote).join(' ');
  const child = spawn('/usr/bin/script', ['-q', '-e', '-c', cmd, '/dev/null'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const exit = once(child, 'exit');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  async function until(text: string) {
    if (output.includes(text)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error(`Terminal never showed ${text}: ${output}`)); }, 10_000);
      function onData() { if (output.includes(text)) { cleanup(); resolve(); } }
      function onExit() { cleanup(); reject(Error(`Terminal exited early: ${output}`)); }
      function cleanup() { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); }
      child.stdout.on('data', onData); child.once('exit', onExit);
    });
  }
  try {
    await until('? help · Enter play');
    await until('[h] Previous');
    await until('[Space] Play');
    await until('[l] Next');
    child.stdin.write('jjj\r');
    await until('▶ B');
    await until('[Space] Pause');
    child.stdin.write(' ');
    await until('Ⅱ B');
    assert.equal((await (await fetch('http://127.0.0.1:4196/api/state')).json()).music.playing, false);
    child.stdin.write(' ');
    child.stdin.write('++[[t/t');
    await until('SEARCH: t');
    const response = await fetch('http://127.0.0.1:4196/api/state');
    const snapshot = await response.json();
    assert.equal(snapshot.settings.volume, 52);
    assert.equal(snapshot.settings.crossfade, 3);
    assert.equal(snapshot.timer.running, true);
    assert.equal(snapshot.music.queue[snapshot.music.index].title, 'B');
    child.stdin.write('\r4');
    await until('4 TIMER');
    await until('[s] Start');
    async function waitState(check: (state: any) => boolean) {
      for (let i = 0; i < 100; i++) {
        const state = await (await fetch('http://127.0.0.1:4196/api/state')).json();
        if (check(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('Timer panel command did not update the shared session.');
    }
    child.stdin.write('p');
    await waitState(s => !s.timer.running);
    child.stdin.write('s');
    await waitState(s => s.timer.running);
    child.stdin.write('n');
    const skipped = await waitState(s => s.timer.phase === 'short' && s.timer.completed === 1);
    assert.equal(skipped.timer.alarm, 0);
    assert.equal(skipped.music.queue[skipped.music.index].title, 'B');
    child.stdin.write('q');
    const [code] = await exit;
    assert.equal(code, 0, output);
    assert.ok(output.includes('\x1b[?25h'));
    assert.ok(output.includes('\x1b[?1049l'));
  } finally {
    if (child.exitCode === null) { process.kill(-child.pid!, 'SIGTERM'); await exit; }
    await rm(folder, { recursive: true, force: true });
  }
});
