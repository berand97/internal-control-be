import { QueryFailedError } from 'typeorm';

interface PgDriverError {
  readonly code?: string;
  readonly message?: string;
}

const driverErrorOf = (error: unknown): PgDriverError | null => {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }
  const driver: unknown = error.driverError;
  if (typeof driver !== 'object' || driver === null) {
    return null;
  }
  return driver as PgDriverError;
};

export const isUniqueViolation = (error: unknown): boolean =>
  driverErrorOf(error)?.code === '23505';

export const isCheckViolation = (error: unknown): boolean =>
  driverErrorOf(error)?.code === '23514';

export const postgresMessage = (error: unknown): string => {
  const driver = driverErrorOf(error);
  if (typeof driver?.message === 'string' && driver.message !== '') {
    return driver.message;
  }
  if (error instanceof QueryFailedError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '';
};

export const isSodViolation = (error: unknown): boolean => {
  const message = postgresMessage(error);
  return (
    driverErrorOf(error)?.code === 'P0001' &&
    message.includes('Separación de Funciones')
  );
};

export const isRoleHierarchyCycle = (error: unknown): boolean => {
  const message = postgresMessage(error);
  return (
    driverErrorOf(error)?.code === 'P0001' &&
    message.includes('Ciclo detectado en jerarquía de roles')
  );
};

export const isCategoryCycle = (error: unknown): boolean => {
  const message = postgresMessage(error);
  return (
    driverErrorOf(error)?.code === 'P0001' &&
    message.includes('Ciclo detectado') &&
    message.includes('asset_category')
  );
};

export const isOrgUnitCycle = (error: unknown): boolean => {
  const message = postgresMessage(error);
  return (
    driverErrorOf(error)?.code === 'P0001' &&
    message.includes('Ciclo detectado') &&
    message.includes('organizational_unit')
  );
};
