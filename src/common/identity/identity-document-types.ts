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

export const identityDocumentAbbreviation = (type: string | null | undefined): string =>
  isIdentityDocumentType(type) ? IDENTITY_DOCUMENT_TYPES[type].abbreviation : '';

export const parseIdentityDocumentType = (raw: string | null | undefined): IdentityDocumentType | null => {
  if (!raw) {
    return null;
  }
  const folded = raw.toUpperCase().replace(/[\s.]/g, '');
  return IDENTITY_DOCUMENT_TYPE_CODES.find(
    (code) => code === folded || IDENTITY_DOCUMENT_TYPES[code].abbreviation.replace(/\./g, '') === folded,
  ) ?? null;
};

export const identityDocumentNumberIsValid = (type: IdentityDocumentType | null, number: string): boolean =>
  type !== null && IDENTITY_DOCUMENT_TYPES[type].numeric ? /^[0-9]+$/.test(number) : number.length > 0;
