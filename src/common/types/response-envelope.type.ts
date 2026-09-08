export const SUCCESS_ACTIONS = [
  'CONTINUE',
  'REDIRECT',
  'POLL',
  'REFRESH_TOKEN',
] as const;
export const ERROR_ACTIONS = [
  'CANCEL',
  'RETRY',
  'REAUTH',
  'CONTACT_SUPPORT',
] as const;

export type ResponseAction =
  (typeof SUCCESS_ACTIONS)[number] | (typeof ERROR_ACTIONS)[number];

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly type: 'SUCCESS';
  readonly action: ResponseAction;
}

export interface ErrorDetail {
  readonly field: string;
  readonly message: string;
}

export interface ErrorBody {
  readonly message: string;
  readonly code: string;
  readonly details?: ReadonlyArray<ErrorDetail>;
}

export interface ErrorEnvelope {
  readonly error: ErrorBody;
  readonly type: 'ERROR';
  readonly action: ResponseAction;
}

export type ResponseEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
