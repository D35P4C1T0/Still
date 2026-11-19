import yauzl from 'yauzl';
import { PassThrough, Readable } from 'node:stream';
import { mkdir, readdir, stat, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const ZIP = 'https://github.com/btahir/open-lofi/releases/download/v1.0.0/openlofi.zip';
const MAX_TRACK = 32 * 1024 * 1024;
const MAX_CACHE = 256 * 1024 * 1024;

class HttpReader extends yauzl.RandomAccessReader {
  private cached: { start: number; data: Buffer } | null = null;
  _readStreamForRange(start: number, end: number) {
    if (this.cached && start >= this.cached.start && end <= this.cached.start + this.cached.data.length) {
      return Readable.from([this.cached.data.subarray(start - this.cached.start, end - this.cached.start)]);
    }
    const output = new PassThrough();
    const abort = new AbortController();
    output.on('close', () => abort.abort());
    void (async () => {
      const response = await fetch(ZIP, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      if (response.status !== 206 || !response.body) throw Error('Open Lo-Fi host no longer supports partial downloads.');
      const range = response.headers.get('content-range');
      if (!range?.startsWith(`bytes ${start}-${end - 1}/`)) throw Error('Unexpected ZIP range response.');
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > end - start) throw Error('ZIP range exceeded expected size.');
        if (end - start <= 128 * 1024) chunks.push(Buffer.from(chunk));
        if (!output.write(Buffer.from(chunk))) await new Promise<void>(resolve => output.once('drain', resolve));
      }
      if (size !== end - start) throw Error('Incomplete ZIP range.');
      if (chunks.length) this.cached = { start, data: Buffer.concat(chunks) };
      output.end();
    })().catch(error => output.destroy(error));
    return output;
  }
}
export async function extractRemoteTrack(filename: string): Promise<Buffer> {
  if (!/^[a-z0-9-]+\.mp3$/.test(filename)) throw Error('Invalid track filename.');
  const head = await fetch(ZIP, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  const length = Number(head.headers.get('content-length'));
  if (!head.ok || !Number.isSafeInteger(length) || length < 22 || length > 2_000_000_000) throw Error('Open Lo-Fi archive is unavailable.');
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(new HttpReader(), length, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error || Error('Cannot read music archive.')); return; }
      const fail = (e: Error) => { zip.close(); reject(e); };
      zip.on('error', fail);
      zip.on('end', () => fail(Error('Track not found in Open Lo-Fi archive.')));
      zip.on('entry', entry => {
        if (entry.fileName !== filename) { zip.readEntry(); return; }
        if (entry.uncompressedSize > MAX_TRACK || entry.compressedSize > MAX_TRACK) { fail(Error('Track exceeds 32 MiB.')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error || Error('Cannot decode ZIP entry.')); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_TRACK) stream.destroy(Error('Track exceeds 32 MiB.'));
            else chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); });
        });
      });
      zip.readEntry();
    });
  });
}
export class MusicCache {
  private pending = new Map<string, Promise<string>>();
  private publishing = Promise.resolve();
  constructor(public folder: string) {}
  async get(filename: string) {
    if (!/^[a-z0-9-]+\.mp3$/.test(filename)) throw Error('Invalid cache filename.');
    if (this.pending.has(filename)) return this.pending.get(filename)!;
    const task = this.download(filename);
    this.pending.set(filename, task);
    try { return await task; } finally { this.pending.delete(filename); }
  }
  private async download(filename: string) {
    await mkdir(this.folder, { recursive: true });
    const file = join(this.folder, filename);
    try { await stat(file); return file; } catch { /* Download only on a cache miss. */ }
    const data = await extractRemoteTrack(filename);
    await writeFile(`${file}.part`, data, { mode: 0o600 });
    const publish = this.publishing.then(async () => {
      await rename(`${file}.part`, file);
      const files = await Promise.all((await readdir(this.folder)).filter(f => f.endsWith('.mp3')).map(async name => ({ name, ...await stat(join(this.folder, name)) })));
      let size = files.reduce((sum, f) => sum + f.size, 0);
      for (const old of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (size <= MAX_CACHE) break;
        if (old.name !== filename) { await unlink(join(this.folder, old.name)); size -= old.size; }
      }
    });
    this.publishing = publish.catch(() => {});
    await publish;
    return file;
  }
}
