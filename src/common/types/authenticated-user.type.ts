export const TOKEN_SCOPE_TYPES = ['GLOBAL', 'ORG_UNIT', 'COST_CENTER'] as const;

export type TokenScopeType = (typeof TOKEN_SCOPE_TYPES)[number];

export interface TokenScope {
  readonly type: TokenScopeType;
  readonly id: string | null;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly personId: string;
  readonly username: string;
  readonly roles: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<TokenScope>;
  readonly mustChangePassword?: boolean;
  readonly sessionId?: string | null;
}

export const isTokenScopeType = (value: unknown): value is TokenScopeType =>
  typeof value === 'string' &&
  (TOKEN_SCOPE_TYPES as ReadonlyArray<string>).includes(value);
