import { isTokenScopeType } from '../../../common/types/authenticated-user.type.js';
import type { TokenScope } from '../../../common/types/authenticated-user.type.js';

export interface AccessTokenPayload {
  readonly sub: string;
  readonly personId: string;
  readonly username: string;
  readonly roles: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<TokenScope>;
  readonly mustChangePassword?: boolean;
  readonly type: 'access';
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

export interface RefreshTokenPayload {
  readonly sub: string;
  readonly type: 'refresh';
  readonly familyId: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface MfaChallengeTokenPayload {
  readonly sub: string;
  readonly username: string;
  readonly type: 'mfa_challenge';
  readonly iat: number;
  readonly exp: number;
}

export interface MfaSetupTokenPayload {
  readonly sub: string;
  readonly username: string;
  readonly type: 'mfa_setup';
  readonly iat: number;
  readonly exp: number;
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.every((item): boolean => typeof item === 'string');

const isTokenScopeArray = (
  value: unknown,
): value is ReadonlyArray<TokenScope> =>
  Array.isArray(value) &&
  value.every(
    (item): boolean =>
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      isTokenScopeType(item.type) &&
      'id' in item &&
      (typeof item.id === 'string' || item.id === null),
  );

export const isAccessTokenPayload = (
  value: unknown,
): value is AccessTokenPayload =>
  typeof value === 'object' &&
  value !== null &&
  'sub' in value &&
  typeof value.sub === 'string' &&
  'personId' in value &&
  typeof value.personId === 'string' &&
  'username' in value &&
  typeof value.username === 'string' &&
  'roles' in value &&
  isStringArray(value.roles) &&
  'scopes' in value &&
  isTokenScopeArray(value.scopes) &&
  (!('mustChangePassword' in value) ||
    typeof value.mustChangePassword === 'boolean') &&
  'type' in value &&
  value.type === 'access';

export const isRefreshTokenPayload = (
  value: unknown,
): value is RefreshTokenPayload =>
  typeof value === 'object' &&
  value !== null &&
  'sub' in value &&
  typeof value.sub === 'string' &&
  'type' in value &&
  value.type === 'refresh' &&
  'familyId' in value &&
  typeof value.familyId === 'string' &&
  'jti' in value &&
  typeof value.jti === 'string';

export const isMfaChallengeTokenPayload = (
  value: unknown,
): value is MfaChallengeTokenPayload =>
  typeof value === 'object' &&
  value !== null &&
  'sub' in value &&
  typeof value.sub === 'string' &&
  'username' in value &&
  typeof value.username === 'string' &&
  'type' in value &&
  value.type === 'mfa_challenge';

export const isMfaSetupTokenPayload = (
  value: unknown,
): value is MfaSetupTokenPayload =>
  typeof value === 'object' &&
  value !== null &&
  'sub' in value &&
  typeof value.sub === 'string' &&
  'username' in value &&
  typeof value.username === 'string' &&
  'type' in value &&
  value.type === 'mfa_setup';
