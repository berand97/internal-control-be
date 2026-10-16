const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export class PublicAssetsConfigError extends Error {}

export const normalizePublicAssetsBucket = (raw: string): string => {
  const value = raw.trim();
  if (!BUCKET.test(value) || value.includes('..')) {
    throw new PublicAssetsConfigError(`publicAssetsBucket no es un nombre de bucket válido: ${value}`);
  }
  return value;
};

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

export const publicAssetUrl = (baseUrl: string, key: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
