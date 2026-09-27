/**
 * Regla única de enlaces en el diseño de un correo (URL del botón, enlaces del párrafo enriquecido, enlace de una
 * imagen): o exactamente una variable del catálogo (`{{auth.resetUrl}}`) o un literal `https://`. El valor de la
 * variable se valida como http(s) absoluto al renderizar (resolveButtonUrl en email-renderer.ts).
 */

const TOKEN_ONLY = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** Literal https:// sin espacios ni variables, que el analizador de URL acepte tal cual. */
export const isHttpsLiteral = (value: string): boolean => {
  if (!value.startsWith('https://') || /\s|\{\{|\}\}/.test(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Token si el URL es exactamente una variable `{{token}}`; null si no. */
export const buttonUrlToken = (url: string): string | null => TOKEN_ONLY.exec(url.trim())?.[1] ?? null;

/** URL aceptable al guardar: una sola variable o un literal https://. */
export const isAllowedDesignUrl = (url: string): boolean => buttonUrlToken(url) !== null || isHttpsLiteral(url);
