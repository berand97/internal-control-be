export const DOCUMENT_TYPES = [
  'LOAN_DELIVERY_ACT',
  'LOAN_RETURN_ACT',
  'WRITE_OFF_ACT',
  'COST_CENTER_TRANSFER_ACT',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PLACEHOLDER_CATALOG: Record<
  DocumentType,
  { readonly required: ReadonlyArray<string>; readonly optional: ReadonlyArray<string> }
> = {
  LOAN_DELIVERY_ACT: {
    required: [
      'acta.numero',
      'acta.fecha',
      'prestamo.justificacion',
      'origen.codigo',
      'origen.nombre',
      'destino.codigo',
      'destino.nombre',
      'solicitante.nombre',
    ],
    optional: [
      'prestamo.fechaEsperadaDevolucion',
      'receptor.nombre',
      'receptor.documento',
      'aprobador.nombre',
      'activos',
    ],
  },
  LOAN_RETURN_ACT: {
    required: [
      'acta.numero',
      'acta.fecha',
      'origen.codigo',
      'destino.codigo',
    ],
    optional: ['activos', 'notas'],
  },
  WRITE_OFF_ACT: {
    required: ['acta.numero', 'acta.fecha', 'activo.codigoInterno', 'motivo'],
    optional: ['documentoReferencia'],
  },
  COST_CENTER_TRANSFER_ACT: {
    required: [
      'acta.numero',
      'acta.fecha',
      'activo.codigoInterno',
      'origen.codigo',
      'destino.codigo',
    ],
    optional: ['documentoReferencia'],
  },
};

export const extractPlaceholders = (xml: string): ReadonlyArray<string> => {
  const matches = xml.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g);
  return [...new Set([...matches].map((match) => match[1] ?? ''))].filter(
    (item) => item !== '',
  );
};

export const nestContext = (
  flat: Record<string, unknown>,
): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let cursor: Record<string, unknown> = root;
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) {
        cursor[part] = value;
        break;
      }
      const next = cursor[part];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
  }
  return root;
};
