export enum VerificationResult {
  Pending = 'PENDING',
  Found = 'FOUND',
  Missing = 'MISSING',
  Surplus = 'SURPLUS',
  Misplaced = 'MISPLACED',
}

export const VERIFICATION_RESULTS = [
  VerificationResult.Pending,
  VerificationResult.Found,
  VerificationResult.Missing,
  VerificationResult.Surplus,
  VerificationResult.Misplaced,
] as const;
