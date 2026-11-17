/**
 * Just enough DER and X.509 to check the certificate chains Apple puts in the x5c header of its JWS
 * (App Store transactions and server notifications). EC keys only, which is all Apple uses.
 */

interface Tlv {
  tag: number;
  start: number; // first byte of the tag
  body: number; // first byte of the value
  end: number; // one past the last byte of the value
}

function readTlv(buf: Uint8Array, pos: number): Tlv {
  if (pos + 2 > buf.length) throw new Error('truncated DER');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let body = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3) throw new Error('unsupported DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[body + i];
    body += n;
  }
  const end = body + len;
  if (end > buf.length) throw new Error('truncated DER');
  return { tag, start: pos, body, end };
}

function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let pos = parent.body; pos < parent.end; ) {
    const t = readTlv(buf, pos);
    out.push(t);
    pos = t.end;
  }
  return out;
}

function expect(t: Tlv | undefined, tag: number): Tlv {
  if (!t || t.tag !== tag) throw new Error(`unexpected DER tag ${t?.tag.toString(16)}, wanted ${tag.toString(16)}`);
  return t;
}

const SEQ = 0x30;
const OID = 0x06;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const INTEGER = 0x02;

export function oidString(bytes: Uint8Array): string {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

function parseTime(buf: Uint8Array, t: Tlv): number {
  const s = new TextDecoder().decode(buf.subarray(t.body, t.end));
  let m: RegExpExecArray | null;
  if (t.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  if (t.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  throw new Error('unsupported certificate time');
}

const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
};

const HASHES: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
};

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  /** Hash of the issuer's signature over tbs. */
  hash: string;
  /** DER-encoded ECDSA signature by the issuer. */
  signature: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  curve: { name: string; size: number };
  /** OIDs of all extensions. */
  extensions: Set<string>;
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = expect(readTlv(der, 0), SEQ);
  if (cert.end !== der.length) throw new Error('trailing bytes after certificate');
  const [tbsT, algT, sigT] = children(der, cert);
  expect(tbsT, SEQ);
  const alg = oidString(slice(der, expect(children(der, expect(algT, SEQ))[0], OID)));
  const hash = HASHES[alg];
  if (!hash) throw new Error(`unsupported signature algorithm ${alg}`);
  const sigBits = slice(der, expect(sigT, BIT_STRING));
  if (sigBits[0] !== 0) throw new Error('bad signature bit string');

  const f = children(der, tbsT);
  let i = f[0]?.tag === 0xa0 ? 1 : 0; // optional [0] version
  expect(f[i++], INTEGER); // serial
  expect(f[i++], SEQ); // signature algorithm
  expect(f[i++], SEQ); // issuer
  const [nb, na] = children(der, expect(f[i++], SEQ));
  expect(f[i++], SEQ); // subject
  const spkiT = expect(f[i++], SEQ);
  const [keyAlgT] = children(der, spkiT);
  const [, curveT] = children(der, expect(keyAlgT, SEQ));
  const curveOid = oidString(slice(der, expect(curveT, OID)));
  const curve = CURVES[curveOid];
  if (!curve) throw new Error(`unsupported curve ${curveOid}`);

  const extensions = new Set<string>();
  for (; i < f.length; i++) {
    if (f[i].tag !== 0xa3) continue;
    const [list] = children(der, f[i]);
    for (const ext of children(der, expect(list, SEQ))) {
      const [idT, ...rest] = children(der, expect(ext, SEQ));
      expect(rest.at(-1), OCTET_STRING);
      extensions.add(oidString(slice(der, expect(idT, OID))));
    }
  }

  return {
    der,
    tbs: der.slice(tbsT.start, tbsT.end),
    hash,
    signature: sigBits.slice(1),
    notBefore: parseTime(der, nb),
    notAfter: parseTime(der, na),
    spki: der.slice(spkiT.start, spkiT.end),
    curve,
    extensions,
  };
}

function slice(buf: Uint8Array, t: Tlv): Uint8Array {
  return buf.subarray(t.body, t.end);
}

/** DER ECDSA signature (SEQUENCE { r, s }) to the fixed-size r||s form WebCrypto verifies. */
export function derToRawSignature(sig: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const seq = expect(readTlv(sig, 0), SEQ);
  const [r, s] = children(sig, seq).map((t) => expect(t, INTEGER));
  const out = new Uint8Array(size * 2);
  for (const [k, t] of [r, s].entries()) {
    let v = slice(sig, t);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('signature integer too long');
    out.set(v, k * size + size - v.length);
  }
  return out;
}

export function importPublicKey(cert: Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', cert.spki.slice(), { name: 'ECDSA', namedCurve: cert.curve.name }, false, ['verify']);
}

/** Did `issuer` sign `cert`? */
export async function signedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  try {
    const key = await importPublicKey(issuer);
    const raw = derToRawSignature(cert.signature, issuer.curve.size);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: cert.hash }, key, raw, cert.tbs.slice());
  } catch {
    return false;
  }
}
