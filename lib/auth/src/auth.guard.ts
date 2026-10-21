import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import {
  IS_PUBLIC,
  REQUIRED_PRINCIPAL,
  REQUIRED_SCOPES,
} from './decorators.js';
import { InvalidTokenError, TokenVerifier } from './token-verifier.js';
import type { PrincipalType } from './current-user.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token)
      throw new UnauthorizedException();

    let user;
    try {
      user = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw new UnauthorizedException();
      throw error;
    }

    const principal = this.reflector.getAllAndOverride<
      PrincipalType | undefined
    >(REQUIRED_PRINCIPAL, targets);
    if (principal && user.type !== principal) throw new ForbiddenException();

    const scopes =
      this.reflector.getAllAndOverride<string[] | undefined>(
        REQUIRED_SCOPES,
        targets,
      ) ?? [];
    if (!scopes.every((scope) => user.hasScope(scope)))
      throw new ForbiddenException();

    request.currentUser = user;
    this.cls.set('actor', { id: user.userId, type: user.type });
    return true;
  }
}
