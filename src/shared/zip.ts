// A small zip reader for the browser and Node: lists the entries of a zip and inflates them with the platform's
// DecompressionStream. Plausible's export is a plain zip of CSV files (stored or deflated, no zip64, no encryption), capped at 200 MB unpacked.

export interface ZipEntry {
  name: string;
  text: () => Promise<string>;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Most bytes a zip may expand to, all entries together. A small zip can hold gigabytes (a zip bomb). */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

const TOO_BIG = `The zip holds more than ${MAX_UNZIPPED_BYTES / 1024 / 1024} MB once unpacked, which is more than an export has. Import the CSV files you need instead.`;

/** Inflate `data`, stopping with an error as soon as the running total of `budget` would pass the cap. */
async function inflate(data: Uint8Array, budget: { used: number }): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    budget.used += value.length;
    if (budget.used > MAX_UNZIPPED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(TOO_BIG);
    }
    parts.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Entries of the zip in `buf`. Throws a plain message when it is not a zip this reader supports. */
export function readZip(buf: Uint8Array): ZipEntry[] {
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a zip file.');
  const count = u16(buf, eocd + 10);
  if (count === 0xffff || u32(buf, eocd + 16) === 0xffffffff) throw new Error('This zip uses zip64 (65,535 files or more, or a size past 4 GB), which is not supported. Import the CSV files you need instead.');
  const budget = { used: 0 };
  let p = u32(buf, eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('The zip is damaged.');
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    if (csize === 0xffffffff || u32(buf, p + 24) === 0xffffffff || u32(buf, p + 42) === 0xffffffff) throw new Error('This zip uses zip64, which is not supported. Import the CSV files you need instead.');
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('The zip is password protected.');
    out.push({
      name,
      text: async () => {
        if (u32(buf, local) !== 0x04034b50) throw new Error('The zip is damaged.');
        const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) {
          budget.used += raw.length;
          if (budget.used > MAX_UNZIPPED_BYTES) throw new Error(TOO_BIG);
          return dec.decode(raw);
        }
        if (method === 8) return dec.decode(await inflate(raw, budget));
        throw new Error(`The zip uses compression method ${method}, which is not supported.`);
      },
    });
  }
  return out;
}
