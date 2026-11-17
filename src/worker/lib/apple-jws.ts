import { importPublicKey, parseCertificate, signedBy } from './x509';

/**
 * Apple Root CA - G3 (DER, base64), from https://www.apple.com/certificateauthority/.
 * SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79.
 * Valid until 2039-04-30.
 */
export const APPLE_ROOT_CA_G3 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQL' +
  'DB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMw' +
  'MTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRp' +
  'ZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IA' +
  'BJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqX' +
  'l5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8w' +
  'DgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWT' +
  'xnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

/** Marks the leaf certificate as Apple's App Store receipt signing certificate. */
export const LEAF_OID = '1.2.840.113635.100.6.11.1';
/** Marks the intermediate as the Apple Worldwide Developer Relations CA. */
export const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

let trustedRoot = b64ToBytes(APPLE_ROOT_CA_G3);

/**
 * Tests only: trust a locally generated root instead of Apple's. Pass null to restore Apple's.
 * Nothing in the Worker calls this; there is no setting or env var that reaches it.
 */
export function setTrustedRootForTests(der: Uint8Array | null) {
  trustedRoot = der ? new Uint8Array(der) : b64ToBytes(APPLE_ROOT_CA_G3);
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export class JwsError extends Error {}

/**
 * Verify an Apple-signed JWS (StoreKit 2 transaction, renewal info or App Store Server Notification V2)
 * and return its payload. Checks, as Apple's own server library does:
 *  - alg ES256 and an x5c chain of three certificates whose last one is Apple Root CA - G3
 *  - the leaf and intermediate carry Apple's marker OIDs
 *  - every certificate was valid at the payload's signedDate
 *  - root signed the intermediate, the intermediate signed the leaf, the leaf signed the JWS
 * Throws JwsError when anything is off.
 */
export async function verifyAppleJws<T = Record<string, unknown>>(jws: unknown): Promise<T> {
  if (typeof jws !== 'string' || jws.length > 20_000) throw new JwsError('not a JWS');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new JwsError('not a compact JWS');
  let header: { alg?: string; x5c?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    throw new JwsError('undecodable JWS');
  }
  if (header.alg !== 'ES256') throw new JwsError('alg must be ES256');
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string')) {
    throw new JwsError('x5c must hold three certificates');
  }
  let certs;
  try {
    certs = x5c.map((c: string) => parseCertificate(b64ToBytes(c)));
  } catch (e) {
    throw new JwsError(`bad certificate: ${(e as Error).message}`);
  }
  const [leaf, intermediate, root] = certs;
  if (!sameBytes(root.der, trustedRoot)) throw new JwsError('chain does not end at Apple Root CA - G3');
  if (!leaf.extensions.has(LEAF_OID)) throw new JwsError('leaf certificate lacks the App Store OID');
  if (!intermediate.extensions.has(INTERMEDIATE_OID)) throw new JwsError('intermediate certificate lacks the Apple WWDR OID');

  const at = typeof payload.signedDate === 'number' ? payload.signedDate : Date.now();
  for (const c of certs) {
    if (at < c.notBefore || at > c.notAfter) throw new JwsError('certificate not valid at signedDate');
  }
  if (!(await signedBy(intermediate, root))) throw new JwsError('intermediate not signed by the root');
  if (!(await signedBy(leaf, intermediate))) throw new JwsError('leaf not signed by the intermediate');
  if (leaf.curve.name !== 'P-256') throw new JwsError('ES256 needs a P-256 leaf key');

  const sig = b64urlToBytes(parts[2]);
  let ok = false;
  try {
    ok = sig.length === 64 &&
      (await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await importPublicKey(leaf),
        sig,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ));
  } catch {
    ok = false;
  }
  if (!ok) throw new JwsError('bad JWS signature');
  return payload as T;
}
