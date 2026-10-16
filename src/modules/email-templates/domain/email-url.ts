const TOKEN_ONLY = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

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

export const buttonUrlToken = (url: string): string | null => TOKEN_ONLY.exec(url.trim())?.[1] ?? null;

export const isAllowedDesignUrl = (url: string): boolean => buttonUrlToken(url) !== null || isHttpsLiteral(url);
