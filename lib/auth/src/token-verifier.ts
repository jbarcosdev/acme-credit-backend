import {
  createRemoteJWKSet,
  importSPKI,
  jwtVerify,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose';
import { CurrentUserInfo, type PrincipalType } from './current-user.js';

export abstract class TokenVerifier {
  abstract verify(token: string): Promise<CurrentUserInfo>;
}

export class InvalidTokenError extends Error {}

export interface JoseTokenVerifierOptions {
  issuer: string;
  audience: string;
  publicKeyPem?: string;
  jwksUrl?: string;
  algorithm?: string;
}

export class JoseTokenVerifier extends TokenVerifier {
  private key?: KeyObject | CryptoKey | JWTVerifyGetKey;

  constructor(private readonly options: JoseTokenVerifierOptions) {
    super();
    if (!options.publicKeyPem && !options.jwksUrl) {
      throw new Error('JoseTokenVerifier requires publicKeyPem or jwksUrl');
    }
  }

  async verify(token: string): Promise<CurrentUserInfo> {
    try {
      const { payload } = await jwtVerify(token, await this.resolveKey(), {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      if (!payload.sub) throw new InvalidTokenError('missing sub');
      const principal = payload['principal'];
      const type: PrincipalType = principal === 'service' ? 'service' : 'user';
      const scope =
        typeof payload['scope'] === 'string' ? payload['scope'] : '';
      return new CurrentUserInfo(
        payload.sub,
        type,
        scope.split(' ').filter(Boolean),
      );
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError('invalid token');
    }
  }

  private async resolveKey(): Promise<KeyObject | CryptoKey | JWTVerifyGetKey> {
    if (this.key) return this.key;
    if (this.options.jwksUrl) {
      this.key = createRemoteJWKSet(new URL(this.options.jwksUrl));
    } else {
      this.key = await importSPKI(
        this.options.publicKeyPem as string,
        this.options.algorithm ?? 'EdDSA',
      );
    }
    return this.key;
  }
}
