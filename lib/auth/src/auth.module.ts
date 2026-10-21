import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessPolicy, LocalAccessPolicy } from './access-policy.js';
import { AuthGuard } from './auth.guard.js';
import { JoseTokenVerifier, TokenVerifier } from './token-verifier.js';

export function tokenVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenVerifier {
  return new JoseTokenVerifier({
    issuer: env.AUTH_ISSUER ?? '',
    audience: env.AUTH_AUDIENCE ?? '',
    publicKeyPem: env.AUTH_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    jwksUrl: env.AUTH_JWKS_URL,
  });
}

@Module({})
export class AuthModule {
  static register(
    options: { verifier?: () => TokenVerifier } = {},
  ): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        {
          provide: TokenVerifier,
          useFactory: options.verifier ?? (() => tokenVerifierFromEnv()),
        },
        { provide: AccessPolicy, useClass: LocalAccessPolicy },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [TokenVerifier, AccessPolicy],
    };
  }
}
