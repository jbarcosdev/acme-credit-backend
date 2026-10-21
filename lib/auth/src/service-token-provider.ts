import { importPKCS8, SignJWT } from 'jose';

export abstract class ServiceTokenProvider {
  abstract getToken(scopes: string[]): Promise<string>;
}

export interface LocalServiceTokenProviderOptions {
  privateKeyPem: string;
  issuer: string;
  audience: string;
  serviceId: string;
  algorithm?: string;
  ttlSeconds?: number;
}

export class LocalServiceTokenProvider extends ServiceTokenProvider {
  constructor(private readonly options: LocalServiceTokenProviderOptions) {
    super();
  }

  async getToken(scopes: string[]): Promise<string> {
    const algorithm = this.options.algorithm ?? 'EdDSA';
    const key = await importPKCS8(this.options.privateKeyPem, algorithm);
    return new SignJWT({ scope: scopes.join(' '), principal: 'service' })
      .setProtectedHeader({ alg: algorithm })
      .setSubject(this.options.serviceId)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.options.ttlSeconds ?? 300}s`)
      .sign(key);
  }
}
