const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$/i;

export const resolveSignatureVerifyUrl = (env: Readonly<Record<string, string | undefined>>): string => {
  const explicit = env['SIGNATURE_VERIFY_URL']?.trim();
  if (env['NODE_ENV'] !== 'production') {
    return (explicit || `${env['APP_PUBLIC_URL']?.trim() || 'http://localhost:4200'}/verificar-firma`).replace(/\/+$/, '');
  }
  if (!explicit) {
    throw new Error(
      'SIGNATURE_VERIFY_URL es obligatoria en producción: es la URL que queda impresa en el QR de cada acta firmada',
    );
  }
  let url: URL;
  try {
    url = new URL(explicit);
  } catch {
    throw new Error(`SIGNATURE_VERIFY_URL no es una URL válida: ${explicit}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SIGNATURE_VERIFY_URL debe usar https en producción: ${explicit}`);
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`SIGNATURE_VERIFY_URL debe ser pública; ${url.hostname} no lo es`);
  }
  if (url.search || url.hash) {
    throw new Error('SIGNATURE_VERIFY_URL no debe llevar parámetros ni fragmento: el código se agrega al final de la ruta');
  }
  return explicit.replace(/\/+$/, '');
};
