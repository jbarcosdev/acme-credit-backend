import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { JoseTokenVerifier, InvalidTokenError } from './token-verifier.js';
import { LocalServiceTokenProvider } from './service-token-provider.js';

const issuer = 'https://idp.test';
const audience = 'acme-credit';

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    extractable: true,
  });
  return {
    publicKey,
    privateKey,
    publicPem: await exportSPKI(publicKey),
    privatePem: await exportPKCS8(privateKey),
  };
}

describe('JoseTokenVerifier', () => {
  it('accepts a valid user token', async () => {
    const k = await keys();
    const token = await new SignJWT({ scope: 'a b' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('user-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('5m')
      .sign(k.privateKey);
    const verifier = new JoseTokenVerifier({
      issuer,
      audience,
      publicKeyPem: k.publicPem,
    });
    const user = await verifier.verify(token);
    expect(user.userId).toBe('user-1');
    expect(user.isUser()).toBe(true);
    expect(user.hasScope('b')).toBe(true);
  });

  it('rejects wrong audience, wrong key and expired tokens', async () => {
    const k = await keys();
    const other = await keys();
    const sign = (key: CryptoKey, aud: string, exp: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('u')
        .setIssuer(issuer)
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(key);
    const verifier = new JoseTokenVerifier({
      issuer,
      audience,
      publicKeyPem: k.publicPem,
    });
    await expect(
      verifier.verify(await sign(k.privateKey, 'other', '5m')),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      verifier.verify(await sign(other.privateKey, audience, '5m')),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      verifier.verify(await sign(k.privateKey, audience, '-1m')),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify('garbage')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('verifies service tokens minted by the local provider', async () => {
    const k = await keys();
    const provider = new LocalServiceTokenProvider({
      privateKeyPem: k.privatePem,
      issuer,
      audience,
      serviceId: 'lending',
    });
    const verifier = new JoseTokenVerifier({
      issuer,
      audience,
      publicKeyPem: k.publicPem,
    });
    const user = await verifier.verify(
      await provider.getToken(['custody:read']),
    );
    expect(user.isService()).toBe(true);
    expect(user.userId).toBe('lending');
    expect(user.scopes).toEqual(['custody:read']);
  });
});
