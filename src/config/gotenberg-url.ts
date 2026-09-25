// En producción la conversión DOCX→PDF es parte de toda acta: un servidor que arranca
// sin Gotenberg acepta generar documentos y falla cada uno con 502. Mejor no arrancar.
export const resolveGotenbergUrl = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const raw = env['GOTENBERG_URL']?.trim();
  if (!raw) {
    if (env['NODE_ENV'] === 'production') {
      throw new Error(
        'GOTENBERG_URL es obligatoria en producción: sin ella ninguna acta se puede convertir a PDF (ej. http://gotenberg:3000)',
      );
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GOTENBERG_URL no es una URL válida: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`GOTENBERG_URL debe usar http o https: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error('GOTENBERG_URL no debe llevar credenciales en la URL');
  }
  return raw.replace(/\/+$/, '');
};
