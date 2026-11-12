import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { inside } from './library.js';

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.json': 'application/json' };
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw Error('Request body too large.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Expected a JSON object.');
  return result;
}
export function parseRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2]) || size === 0) throw Error('Invalid byte range.');
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw Error('Invalid byte range.');
  return { start, end };
}
export async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, root: string) {
  const actual = await realpath(file);
  if (!inside(root, actual)) throw Error('File outside the allowed directory.');
  const info = await stat(actual);
  if (!info.isFile()) throw Error('Not a file.');
  let range;
  try { range = parseRange(req.headers.range, info.size); }
  catch { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  res.writeHead(range ? 206 : 200, {
    'Content-Type': types[extname(actual)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  await pipeline(createReadStream(actual, { start, end }), res);
}
