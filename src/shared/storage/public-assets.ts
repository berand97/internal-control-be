/**
 * Bucket de los archivos que deben abrirse sin sesión desde fuera (hoy: las imágenes de las plantillas de correo, que
 * descargan los clientes de correo), siempre bajo images/email/ (storage-keys.ts). Mismo proveedor S3 (mismo endpoint
 * y credenciales). Puede ser un bucket aparte (recomendado en producción) o el mismo de documentos con lectura anónima
 * SOLO de images/email/*: ninguna clave de documento puede empezar por images/. Ver docs/DEPLOY.md §10.7.
 *
 * - publicAssetsBucket: nombre del bucket (p. ej. `control-interno-public`, o `control-interno-dev` si es el mismo).
 * - publicAssetsBaseUrl: URL pública base desde la que se lee un objeto: `<base>/<clave>` (p. ej.
 *   `https://minio-api.dominio/control-interno-public`). En producción, https obligatorio.
 */

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export class PublicAssetsConfigError extends Error {}

/** Nombre de bucket S3 válido, o lanza PublicAssetsConfigError. */
export const normalizePublicAssetsBucket = (raw: string): string => {
  const value = raw.trim();
  if (!BUCKET.test(value) || value.includes('..')) {
    throw new PublicAssetsConfigError(`publicAssetsBucket no es un nombre de bucket válido: ${value}`);
  }
  return value;
};

/** URL base sin barra final; https en producción, sin usuario, parámetros ni fragmento. */
export const normalizePublicAssetsBaseUrl = (raw: string, production: boolean): string => {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicAssetsConfigError(`publicAssetsBaseUrl no es una URL válida: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PublicAssetsConfigError('publicAssetsBaseUrl debe ser una URL http(s)');
  }
  if (production && url.protocol !== 'https:') {
    throw new PublicAssetsConfigError(
      'publicAssetsBaseUrl debe usar https en producción: los clientes de correo no cargan imágenes inseguras',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PublicAssetsConfigError('publicAssetsBaseUrl no debe llevar usuario, parámetros ni fragmento');
  }
  return value.replace(/\/+$/, '');
};

/** URL pública de un objeto: base + clave con cada segmento codificado. */
export const publicAssetUrl = (baseUrl: string, key: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
