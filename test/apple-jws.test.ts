import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APPLE_ROOT_CA_G3, INTERMEDIATE_OID, LEAF_OID, setTrustedRootForTests, verifyAppleJws } from '../src/worker/lib/apple-jws';
import { parseCertificate } from '../src/worker/lib/x509';
import { makeCert, makeChain, signJws, type TestChain } from './helpers/apple-chain';

const tx = () => ({
  transactionId: '2000000123',
  originalTransactionId: '2000000123',
  bundleId: 'com.example.app',
  productId: 'pro_monthly',
  price: 9990,
  currency: 'EUR',
  environment: 'Production',
  signedDate: Date.now(),
});

describe('Apple Root CA - G3 constant', () => {
  it('is the published certificate (SHA-256 fingerprint)', async () => {
    const der = Buffer.from(APPLE_ROOT_CA_G3, 'base64');
    const hex = Buffer.from(await crypto.subtle.digest('SHA-256', der)).toString('hex').toUpperCase();
    expect(hex).toBe('63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179');
    const c = parseCertificate(der);
    expect(c.curve.name).toBe('P-384');
    expect(new Date(c.notAfter).toISOString()).toBe('2039-04-30T18:19:06.000Z');
  });
});

describe('verifyAppleJws', () => {
  let chain: TestChain;
  beforeAll(async () => {
    chain = await makeChain();
  });
  afterEach(() => setTrustedRootForTests(null));
  const trust = (c: TestChain) => setTrustedRootForTests(c.root.der);

  it('accepts a correctly signed transaction and returns its payload', async () => {
    trust(chain);
    const payload = await verifyAppleJws<{ transactionId: string; price: number }>(await signJws(tx(), chain));
    expect(payload.transactionId).toBe('2000000123');
    expect(payload.price).toBe(9990);
  });

  it('rejects a self-made chain against the real Apple root', async () => {
    await expect(verifyAppleJws(await signJws(tx(), chain))).rejects.toThrow(/Apple Root CA - G3/);
  });

  it('rejects a tampered payload', async () => {
    trust(chain);
    const [h, , s] = (await signJws(tx(), chain)).split('.');
    const forged = Buffer.from(JSON.stringify({ ...tx(), price: 1 })).toString('base64url');
    await expect(verifyAppleJws(`${h}.${forged}.${s}`)).rejects.toThrow(/signature/);
  });

  it('rejects other algorithms and short chains', async () => {
    trust(chain);
    await expect(verifyAppleJws(await signJws(tx(), chain, { alg: 'none' }))).rejects.toThrow(/ES256/);
    await expect(verifyAppleJws(await signJws(tx(), chain, { x5c: [chain.leaf.der, chain.root.der] }))).rejects.toThrow(/three/);
    await expect(verifyAppleJws('a.b')).rejects.toThrow();
    await expect(verifyAppleJws(42)).rejects.toThrow();
  });

  it('requires the leaf and intermediate marker OIDs', async () => {
    const noLeafOid = await makeChain({ leafOids: ['1.2.3.4'] });
    trust(noLeafOid);
    await expect(verifyAppleJws(await signJws(tx(), noLeafOid))).rejects.toThrow(/App Store OID/);
    const noIntOid = await makeChain({ intermediateOids: [LEAF_OID] });
    trust(noIntOid);
    await expect(verifyAppleJws(await signJws(tx(), noIntOid))).rejects.toThrow(/WWDR OID/);
  });

  it('checks certificate validity at signedDate', async () => {
    const expired = await makeChain({ leafNotAfter: Date.now() - 60_000 });
    trust(expired);
    await expect(verifyAppleJws(await signJws(tx(), expired))).rejects.toThrow(/not valid/);
    // The same chain verifies a payload signed while the leaf was still valid.
    await expect(verifyAppleJws(await signJws({ ...tx(), signedDate: Date.now() - 3_600_000 }, expired))).resolves.toBeTruthy();
  });

  it('rejects an intermediate that the trusted root did not sign', async () => {
    trust(chain);
    const otherRoot = await makeCert({ cn: 'Impostor Root', curve: 'P-384' });
    const intermediate = await makeCert({ cn: 'Impostor WWDR', curve: 'P-384', issuer: otherRoot, extOids: [INTERMEDIATE_OID] });
    const leaf = await makeCert({ cn: 'Impostor leaf', curve: 'P-256', issuer: intermediate, extOids: [LEAF_OID] });
    const forged = { root: chain.root, intermediate, leaf };
    await expect(verifyAppleJws(await signJws(tx(), forged))).rejects.toThrow(/intermediate not signed/);
  });

  it('rejects a leaf the intermediate did not sign', async () => {
    trust(chain);
    const strayLeaf = await makeCert({ cn: 'Stray leaf', curve: 'P-256', issuer: { ...chain.root }, extOids: [LEAF_OID] });
    await expect(verifyAppleJws(await signJws(tx(), { ...chain, leaf: strayLeaf }))).rejects.toThrow(/leaf not signed/);
  });
});

// Apple Worldwide Developer Relations CA - G6: the real intermediate behind App Store JWS (public certificate).
const APPLE_WWDR_G6 =
  'MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAt' +
  'IEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMC' +
  'VVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJl' +
  'bGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJBgNVBAYT' +
  'AlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWmZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT8JMEb7FDi4bBmPhCnZ3/' +
  'sq6PF/cGcKXWsL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIGA1UdEwEB/wQIMAYBAf8CAQAw' +
  'HwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rLJKswRgYIKwYBBQUHAQEEOjA4MDYGCCsGAQUFBzABhipodHRwOi8vb2NzcC5h' +
  'cHBsZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0cDovL2NybC5hcHBsZS5jb20vYXBwbGVy' +
  'b290Y2FnMy5jcmwwHQYDVR0OBBYEFD8vlCNR01DJmig97bB85c+lkGKZMA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIF' +
  'ADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXufQB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxa' +
  'rZXvNrkxU3TkUMI33yzvFVVRT4wxWJC994OsdcZ4+RGNsYDyR5gmdr0nDGg=';

describe('real Apple certificates', () => {
  it('reads the WWDR G6 intermediate and verifies it against the embedded root', async () => {
    const { signedBy } = await import('../src/worker/lib/x509');
    const root = parseCertificate(Buffer.from(APPLE_ROOT_CA_G3, 'base64'));
    const g6 = parseCertificate(Buffer.from(APPLE_WWDR_G6, 'base64'));
    expect(g6.extensions.has(INTERMEDIATE_OID)).toBe(true);
    expect(g6.curve.name).toBe('P-384');
    expect(await signedBy(g6, root)).toBe(true);
    const tampered = Buffer.from(APPLE_WWDR_G6, 'base64');
    tampered[300] ^= 1;
    expect(await signedBy(parseCertificate(tampered), root)).toBe(false);
  });
});
