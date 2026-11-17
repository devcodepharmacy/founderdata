// Builds a local certificate chain shaped like Apple's (root P-384, intermediate P-384, leaf P-256 with
// Apple's marker OIDs) and signs JWS with it, so tests can exercise the real verification code.
import { INTERMEDIATE_OID, LEAF_OID } from '../../src/worker/lib/apple-jws';

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return Uint8Array.of(0x80 | b.length, ...b);
}
const tlv = (tag: number, ...c: Uint8Array[]) => {
  const body = cat(...c);
  return cat(Uint8Array.of(tag), len(body.length), body);
};
const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
function oid(s: string) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Uint8Array.from(out));
}
function int(bytes: Uint8Array) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const v = bytes.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? cat(Uint8Array.of(0), v) : v);
}
function time(ms: number) {
  const iso = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return tlv(0x17, new TextEncoder().encode(iso.slice(2)));
}
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, new TextEncoder().encode(cn)))));

const ALG = { 'SHA-256': '1.2.840.10045.4.3.2', 'SHA-384': '1.2.840.10045.4.3.3' } as const;

async function rawToDer(raw: ArrayBuffer) {
  const b = new Uint8Array(raw);
  const h = b.length / 2;
  return seq(int(b.subarray(0, h)), int(b.subarray(h)));
}

export interface TestCert {
  der: Uint8Array;
  keys: CryptoKeyPair;
}

interface CertOpts {
  cn: string;
  curve: 'P-256' | 'P-384';
  issuer?: TestCert & { cn: string };
  extOids?: string[];
  notBefore?: number;
  notAfter?: number;
}

export async function makeCert(o: CertOpts): Promise<TestCert & { cn: string }> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: o.curve }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const signer = o.issuer?.keys.privateKey ?? keys.privateKey;
  const hash = 'SHA-384';
  const exts = (o.extOids ?? []).map((x) => seq(oid(x), tlv(0x04, Uint8Array.of(0x05, 0x00))));
  const tbs = seq(
    tlv(0xa0, int(Uint8Array.of(2))),
    int(crypto.getRandomValues(new Uint8Array(8))),
    seq(oid(ALG[hash])),
    name(o.issuer?.cn ?? o.cn),
    seq(time(o.notBefore ?? Date.now() - 86_400_000), time(o.notAfter ?? Date.now() + 365 * 86_400_000)),
    name(o.cn),
    spki,
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const sig = await rawToDer(await crypto.subtle.sign({ name: 'ECDSA', hash }, signer, tbs));
  const der = seq(tbs, seq(oid(ALG[hash])), tlv(0x03, cat(Uint8Array.of(0), sig)));
  return { der, keys, cn: o.cn };
}

export interface TestChain {
  root: TestCert & { cn: string };
  intermediate: TestCert & { cn: string };
  leaf: TestCert & { cn: string };
}

export async function makeChain(overrides: { leafOids?: string[]; intermediateOids?: string[]; leafNotAfter?: number } = {}): Promise<TestChain> {
  const root = await makeCert({ cn: 'Test Root CA - G3', curve: 'P-384' });
  const intermediate = await makeCert({
    cn: 'Test WWDR CA',
    curve: 'P-384',
    issuer: root,
    extOids: overrides.intermediateOids ?? [INTERMEDIATE_OID],
  });
  const leaf = await makeCert({
    cn: 'Test App Store Signing',
    curve: 'P-256',
    issuer: intermediate,
    extOids: overrides.leafOids ?? [LEAF_OID],
    notAfter: overrides.leafNotAfter,
  });
  return { root, intermediate, leaf };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

/** Sign a payload the way the App Store does (ES256, x5c = leaf, intermediate, root). */
export async function signJws(payload: unknown, chain: TestChain, opts: { alg?: string; x5c?: Uint8Array[] } = {}): Promise<string> {
  const header = { alg: opts.alg ?? 'ES256', x5c: (opts.x5c ?? [chain.leaf.der, chain.intermediate.der, chain.root.der]).map(b64) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chain.leaf.keys.privateKey, new TextEncoder().encode(input)),
  );
  return `${input}.${b64url(sig)}`;
}
