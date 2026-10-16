export enum VerificationResult {
  Pending = 'PENDING',
  Found = 'FOUND',
  Missing = 'MISSING',
  Surplus = 'SURPLUS',
  Misplaced = 'MISPLACED',
  NotVerified = 'NOT_VERIFIED',
}

export const VERIFICATION_RESULTS = [
  VerificationResult.Pending,
  VerificationResult.Found,
  VerificationResult.Missing,
  VerificationResult.Surplus,
  VerificationResult.Misplaced,
  VerificationResult.NotVerified,
] as const;

export const CORRECTABLE_RESULTS = [
  VerificationResult.Found,
  VerificationResult.Missing,
  VerificationResult.Misplaced,
  VerificationResult.Pending,
] as const;
export type CorrectableResult = (typeof CORRECTABLE_RESULTS)[number];
