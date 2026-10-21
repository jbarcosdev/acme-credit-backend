export type PrincipalType = 'user' | 'service';

export interface CurrentUserData {
  userId: string;
  type: PrincipalType;
  scopes: string[];
}

export class CurrentUserInfo implements CurrentUserData {
  constructor(
    public readonly userId: string,
    public readonly type: PrincipalType,
    public readonly scopes: string[],
  ) {}

  isUser(): boolean {
    return this.type === 'user';
  }

  isService(): boolean {
    return this.type === 'service';
  }

  hasScope(scope: string): boolean {
    return this.scopes.includes(scope);
  }
}
