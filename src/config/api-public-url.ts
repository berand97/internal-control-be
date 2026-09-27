/**
 * API_PUBLIC_URL también arma la URL de las imágenes de los correos (GET /api/v1/public/email-assets/:id), que
 * abren los clientes de correo desde fuera de la red. En producción debe ser https y de host público; si no, el
 * backend arranca igual (la variable ya existía y sirve a otras funciones) pero lo advierte al iniciar.
 */
export const apiPublicUrlWarning = (env: NodeJS.ProcessEnv): string | null => {
  if (env['NODE_ENV'] !== 'production') {
    return null;
  }
  const raw = env['API_PUBLIC_URL']?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'API_PUBLIC_URL no está configurada o no es una URL válida: las imágenes de los correos apuntarían a http://localhost:3000';
  }
  if (url.protocol !== 'https:') {
    return `API_PUBLIC_URL debe usar https en producción (${url.origin}): los clientes de correo pueden bloquear las imágenes`;
  }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.internal$/.test(url.hostname)) {
    return `API_PUBLIC_URL debe ser pública; ${url.hostname} no lo es: los clientes de correo no cargarían las imágenes`;
  }
  return null;
};
