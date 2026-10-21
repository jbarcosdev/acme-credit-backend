export const SCOPES = {
  authorizationsWrite: 'authorizations:write',
  depositsConfirm: 'deposits:confirm',
  custodyRead: 'custody:read',
  custodySettle: 'custody:settle',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];
