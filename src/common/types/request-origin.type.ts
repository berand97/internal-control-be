/** Desde dónde llegó un cambio auditado: IP (`@Ip()`, respeta trust proxy) y user-agent del request. */
export interface RequestOrigin {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export const requestOrigin = (ipAddress: string | undefined, userAgent: string | undefined): RequestOrigin => ({
  ipAddress: ipAddress ?? null,
  userAgent: userAgent ?? null,
});
