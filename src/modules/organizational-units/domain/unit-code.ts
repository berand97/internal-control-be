export const UNIT_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const UNIT_CODE_MAX = 20;
export const UNIT_CODE_MESSAGE =
  'El código interno debe empezar por una letra mayúscula y llevar solo letras mayúsculas sin tildes, dígitos y guion bajo (p. ej. OFICINA_CALIDAD)';
export const UNIT_CODE_LENGTH_MESSAGE = `El código interno admite hasta ${UNIT_CODE_MAX} caracteres`;
export const UNIT_CODE_REQUIRED_MESSAGE = 'Escriba el código interno de la unidad';
export const UNIT_CODE_TEXT_MESSAGE = 'El código interno debe ser texto';

export const HEAD_CENTER_CODE_PATTERN = /^[0-9]{1,20}$/;
export const HEAD_CENTER_CODE_MESSAGE = 'El código del centro propio debe tener de 1 a 20 dígitos, sin letras ni espacios';
