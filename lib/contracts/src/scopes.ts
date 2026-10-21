export const SCOPES = {
  authorizationsWrite: 'authorizations:write',
  depositsConfirm: 'deposits:confirm',
  custodyRead: 'custody:read',
  custodySettle: 'custody:settle',
  jobsRun: 'jobs:run',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];
