/**
 * Tipos de documento de identidad de una persona (person.document_type).
 *
 * Decisión de Control Interno: se guarda el tipo Y el número, y la unicidad es por el par. La abreviatura es lo
 * que imprimen las actas antes del número. «C.C.» viene del formato institucional; las demás son las usuales en
 * Colombia y están pendientes de confirmación por Control Interno.
 *
 * La única validación de formato que se aplica es la inequívoca: la cédula de ciudadanía y la tarjeta de
 * identidad son solo dígitos. No se imponen longitudes (no hay regla institucional).
 */
export const IDENTITY_DOCUMENT_TYPES = {
  CC: { label: 'Cédula de ciudadanía', abbreviation: 'C.C.', numeric: true },
  CE: { label: 'Cédula de extranjería', abbreviation: 'C.E.', numeric: false },
  PA: { label: 'Pasaporte', abbreviation: 'PA', numeric: false },
  PEP: { label: 'Permiso especial de permanencia', abbreviation: 'PEP', numeric: false },
  PPT: { label: 'Permiso por protección temporal', abbreviation: 'PPT', numeric: false },
  TI: { label: 'Tarjeta de identidad', abbreviation: 'T.I.', numeric: true },
} as const satisfies Record<string, { label: string; abbreviation: string; numeric: boolean }>;

export type IdentityDocumentType = keyof typeof IDENTITY_DOCUMENT_TYPES;

export const IDENTITY_DOCUMENT_TYPE_CODES = Object.keys(IDENTITY_DOCUMENT_TYPES) as IdentityDocumentType[];

export const isIdentityDocumentType = (value: unknown): value is IdentityDocumentType =>
  typeof value === 'string' && Object.hasOwn(IDENTITY_DOCUMENT_TYPES, value);

/** Abreviatura impresa en las actas; '' si el tipo es desconocido (se imprime solo el número). */
export const identityDocumentAbbreviation = (type: string | null | undefined): string =>
  isIdentityDocumentType(type) ? IDENTITY_DOCUMENT_TYPES[type].abbreviation : '';

/**
 * Normaliza lo que viene en una columna de tipo de documento de un Excel: acepta el código (CC) o la abreviatura
 * impresa (C.C., c.c, T.I.), sin distinguir mayúsculas, puntos ni espacios. null si no es un tipo del catálogo.
 */
export const parseIdentityDocumentType = (raw: string | null | undefined): IdentityDocumentType | null => {
  if (!raw) {
    return null;
  }
  const folded = raw.toUpperCase().replace(/[\s.]/g, '');
  return IDENTITY_DOCUMENT_TYPE_CODES.find(
    (code) => code === folded || IDENTITY_DOCUMENT_TYPES[code].abbreviation.replace(/\./g, '') === folded,
  ) ?? null;
};

/** Solo la regla inequívoca: tipos numéricos exigen dígitos. */
export const identityDocumentNumberIsValid = (type: IdentityDocumentType | null, number: string): boolean =>
  type !== null && IDENTITY_DOCUMENT_TYPES[type].numeric ? /^[0-9]+$/.test(number) : number.length > 0;
