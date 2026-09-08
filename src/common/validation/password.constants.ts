export const PASSWORD_POLICY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;

export const PASSWORD_POLICY_MESSAGE =
  'La contraseña debe tener mínimo 12 caracteres, una mayúscula, una minúscula, un número y un símbolo';

export const INSTITUTIONAL_EMAIL_REGEX = /^[^\s@]+@unac\.edu\.co$/i;

export const INSTITUTIONAL_EMAIL_MESSAGE =
  'El correo debe pertenecer al dominio institucional @unac.edu.co';
