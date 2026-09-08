const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

export const validateEnv = (
  rawEnv: Record<string, unknown>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Variables de entorno requeridas ausentes: ${missing.join(', ')}`,
    );
  }
  return env;
};
