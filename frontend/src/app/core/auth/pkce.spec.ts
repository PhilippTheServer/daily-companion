import { base64Url, challengeFor, randomString } from './pkce';

describe('pkce', () => {
  it('encodes base64url without padding', () => {
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });

  it('makes a 43-character verifier from 32 bytes', () => {
    const verifier = randomString();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomString()).not.toBe(verifier);
  });

  it('computes the RFC 7636 appendix B challenge', async () => {
    await expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
