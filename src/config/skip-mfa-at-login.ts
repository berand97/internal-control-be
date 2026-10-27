export const readSkipMfaAtLogin = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const raw = env['AUTH_SKIP_MFA'];
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') {
    return false;
  }
  if (raw !== 'true' && raw !== '1') {
    throw new Error(`AUTH_SKIP_MFA inválido: ${raw}. Use true o false.`);
  }
  if (env['NODE_ENV'] !== 'development') {
    throw new Error(
      `AUTH_SKIP_MFA solo se permite con NODE_ENV=development (recibido: ${env['NODE_ENV'] ?? 'sin definir'}).`,
    );
  }
  return true;
};
