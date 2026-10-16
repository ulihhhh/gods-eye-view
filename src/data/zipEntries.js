/**
 * @module zipEntries
 * @description Read named text entries from a zip archive (stored or
 * deflated), each under a hard size cap, with the web-standard
 * `DecompressionStream` (Node 18+ and browsers), so the Transit proxy can
 * read an operator's static GTFS without Node built-ins. Only the central
 * directory is trusted for offsets; nothing is written anywhere.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function inflateRaw(bytes, maxBytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('zip: entry larger than declared');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The archive's entries, from its central directory.
 * @param {Uint8Array} bytes The whole archive.
 * @returns {Map<string, {method: number, size: number,
 *   data: Uint8Array}>} name → compression method, uncompressed size and
 *   the entry's compressed bytes
 */
function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  const u16 = (at) => view.getUint16(at, true);
  const entries = new Map();
  let eocd = bytes.byteLength - 22;
  const floor = Math.max(0, bytes.byteLength - 22 - 0xffff);
  while (eocd >= floor && u32(eocd) !== EOCD) eocd -= 1;
  if (eocd < floor) throw new Error('zip: no end of central directory');
  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.byteLength || u32(offset) !== CENTRAL)
      throw new Error('zip: bad central directory entry');
    const method = u16(offset + 10);
    const compressed = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const local = u32(offset + 42);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    entries.set(name, { method, size, local, compressed });
  }
  for (const [name, entry] of entries) {
    const { local, compressed } = entry;
    if (local + 30 > bytes.byteLength || u32(local) !== LOCAL) {
      entries.set(name, { ...entry, data: null });
      continue;
    }
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    entries.set(name, {
      method: entry.method,
      size: entry.size,
      data:
        start + compressed > bytes.byteLength
          ? null
          : bytes.subarray(start, start + compressed),
    });
  }
  return entries;
}

function entryData(name, entry) {
  if (!entry.data) throw new Error(`zip: bad local header for ${name}`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`zip: unsupported method ${entry.method}`);
  return entry.data;
}

/**
 * @param {Uint8Array} bytes The whole archive.
 * @param {string[]} names Entries wanted.
 * @param {number} maxEntryBytes Cap on each entry's uncompressed size.
 * @returns {Promise<Map<string, string>>} name → UTF-8 text, for the
 *   wanted entries the archive has.
 */
export async function readZipTextEntries(bytes, names, maxEntryBytes) {
  const entries = zipDirectory(bytes);
  const decoder = new TextDecoder();
  const files = new Map();
  for (const name of names) {
    const entry = entries.get(name);
    if (!entry) continue;
    if (entry.size > maxEntryBytes) throw new Error(`zip: ${name} too large`);
    const data = entryData(name, entry);
    files.set(
      name,
      decoder.decode(
        entry.method === 0 ? data : await inflateRaw(data, maxEntryBytes),
      ),
    );
  }
  return files;
}

/**
 * The lines of one text entry, inflated as they are read, so an entry far
 * larger than the memory it may take (a GTFS `stop_times.txt`) is read
 * without being held. Line ends (`\n`, `\r\n`) are dropped.
 * @param {Uint8Array} bytes The whole archive.
 * @param {string} name
 * @param {number} maxEntryBytes Cap on the entry's uncompressed size.
 * @returns {AsyncGenerator<string>} nothing when the archive lacks it
 */
export async function* zipEntryLines(bytes, name, maxEntryBytes) {
  const entry = zipDirectory(bytes).get(name);
  if (!entry) return;
  if (entry.size > maxEntryBytes) throw new Error(`zip: ${name} too large`);
  const data = entryData(name, entry);
  let stream = new Blob([data]).stream();
  if (entry.method === 8)
    stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let total = 0;
  let rest = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxEntryBytes)
        throw new Error('zip: entry larger than declared');
      const lines = (rest + value).split('\n');
      rest = lines.pop();
      for (const line of lines)
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
