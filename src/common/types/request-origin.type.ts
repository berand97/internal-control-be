
export interface RequestOrigin {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export const requestOrigin = (ipAddress: string | undefined, userAgent: string | undefined): RequestOrigin => ({
  ipAddress: ipAddress ?? null,
  userAgent: userAgent ?? null,
});
