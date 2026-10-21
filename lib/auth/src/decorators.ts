import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { CurrentUserInfo, PrincipalType } from './current-user.js';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_SCOPES = 'auth:scopes';
export const REQUIRED_PRINCIPAL = 'auth:principal';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequireScopes = (...scopes: string[]) =>
  SetMetadata(REQUIRED_SCOPES, scopes);
export const RequirePrincipal = (type: PrincipalType) =>
  SetMetadata(REQUIRED_PRINCIPAL, type);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserInfo => {
    return context.switchToHttp().getRequest().currentUser;
  },
);
