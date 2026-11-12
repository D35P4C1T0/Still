import assert from 'node:assert/strict';
import { fetchText, parseOpenLofi, parseRoyalty } from '../src/server/library.js';
import { extractRemoteTrack } from '../src/server/remote-zip.js';

const [lofi, royalty] = await Promise.all([
  fetchText('https://raw.githubusercontent.com/btahir/open-lofi/v1.0.0/catalog.json').then(parseOpenLofi),
  fetchText('https://royaltymusicfree.com/').then(parseRoyalty),
]);
assert.ok(lofi.length > 0 && royalty.length > 0);
console.log(`Live catalogs: ${lofi.length} Open Lo-Fi tracks, ${royalty.length} RoyaltyMusicFree tracks.`);
const bytes = await extractRemoteTrack(lofi[0].media);
assert.ok(bytes.length > 1000);
console.log(`Selective ZIP extraction: ${lofi[0].title}, ${bytes.length} bytes (no full archive download).`);
const response = await fetch(royalty[0].media, { signal: AbortSignal.timeout(20_000), headers: { Range: 'bytes=0-15' }, redirect: 'error' });
assert.ok(response.ok && response.body);
assert.ok(response.headers.get('content-type')?.startsWith('audio/'));
const reader = response.body.getReader();
const first = await reader.read();
assert.ok(first.value?.length);
await reader.cancel();
console.log(`RoyaltyMusicFree media responds with audio: ${royalty[0].title}.`);
