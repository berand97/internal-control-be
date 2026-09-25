import type { DocumentNumberingPolicy } from '../../../config/configuration.js';

export type SignerSource = 'RESPONSIBLE' | 'REQUEST';

export interface SignerSpec {
  readonly order: number;
  readonly role: string;
  readonly label: string;
  readonly source: SignerSource;
}

export interface DocumentFormat {
  readonly key: string;
  readonly sgcCode: string;
  readonly version: string;
  readonly name: string;
  readonly numbering: {
    readonly width: number;
    readonly perYear: boolean;
    readonly lastIssued: number;
    readonly lastIssuedPeriod?: string;
  };
  readonly readPermission: string;
  readonly generatePermission: string;
  readonly signers: ReadonlyArray<SignerSpec>;
  readonly pendingDecisions: ReadonlyArray<string>;
}

const CONTROL_INTERNO: SignerSpec = { order: 0, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' };

export const DOCUMENT_FORMATS: ReadonlyArray<DocumentFormat> = [
  {
    key: 'OCI-01-55',
    sgcCode: 'OCI-01-55',
    version: '2',
    name: 'Acta de entrega y asignación de activos fijos',
    numbering: { width: 4, perYear: false, lastIssued: 92 },
    readPermission: 'asset:read:global',
    generatePermission: 'asset:update:global',
    signers: [
      { order: 1, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { ...CONTROL_INTERNO, order: 2 },
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-01-65',
    sgcCode: 'OCI-01-65',
    version: '2',
    name: 'Acta de préstamo temporal de activos fijos',
    numbering: { width: 4, perYear: true, lastIssued: 1, lastIssuedPeriod: '2026' },
    readPermission: 'loan:read:global',
    generatePermission: 'loan:update:global',
    signers: [
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { ...CONTROL_INTERNO, order: 3 },
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-17-89',
    sgcCode: 'OCI-17-89',
    version: '1',
    name: 'Acta de traslado de activos fijos',
    numbering: { width: 5, perYear: false, lastIssued: 143 },
    readPermission: 'asset:read:global',
    generatePermission: 'asset:update:global',
    signers: [
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { order: 3, role: 'CONTROL_INTERNO', label: 'Control Interno', source: 'REQUEST' },
      { order: 4, role: 'CONTABILIDAD', label: 'Contabilidad', source: 'REQUEST' },
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-17-90-BAJA',
    sgcCode: 'OCI-17-90',
    version: '1',
    name: 'Acta de baja de activos fijos',
    numbering: { width: 5, perYear: false, lastIssued: 19 },
    readPermission: 'asset:read:global',
    generatePermission: 'asset:write_off:global',
    signers: [
      { order: 1, role: 'RESPONSABLE', label: 'Responsable', source: 'RESPONSIBLE' },
      { ...CONTROL_INTERNO, order: 2 },
    ],
    pendingDecisions: [
      'Comparte el código OCI-17-90 con el informe a Vicefinanciera: Control Interno debe resolver la duplicación',
      'Firmantes y orden por confirmar con Control Interno',
    ],
  },
  {
    key: 'OCI-17-90-INFORME',
    sgcCode: 'OCI-17-90',
    version: '1',
    name: 'Informe de baja a la Vicerrectoría Financiera',
    numbering: { width: 5, perYear: false, lastIssued: 17 },
    readPermission: 'asset:read:global',
    generatePermission: 'asset:write_off:global',
    signers: [{ ...CONTROL_INTERNO, order: 1 }],
    pendingDecisions: [
      'Comparte el código OCI-17-90 con el acta de baja: Control Interno debe resolver la duplicación',
      'Firmantes y orden por confirmar con Control Interno',
    ],
  },
  {
    key: 'OCI-21-37',
    sgcCode: 'OCI-21-37',
    version: '2',
    name: 'Acta de toma física de inventario de activos fijos',
    numbering: { width: 5, perYear: false, lastIssued: 5 },
    readPermission: 'inventory:read:global',
    generatePermission: 'inventory:execute:global',
    signers: [
      { order: 1, role: 'RESPONSABLE', label: 'Responsable', source: 'RESPONSIBLE' },
      { ...CONTROL_INTERNO, order: 2 },
    ],
    pendingDecisions: ['Firmantes y orden por confirmar con Control Interno'],
  },
];

export const findFormat = (key: string): DocumentFormat | undefined =>
  DOCUMENT_FORMATS.find((format) => format.key === key);

export const periodFor = (format: DocumentFormat, date: Date): string =>
  format.numbering.perYear ? String(date.getFullYear()) : '';

export const initialSequenceValue = (
  format: DocumentFormat,
  period: string,
  policy: DocumentNumberingPolicy,
): number => {
  if (policy === 'restart') {
    return 0;
  }
  if (format.numbering.perYear && format.numbering.lastIssuedPeriod !== period) {
    return 0;
  }
  return format.numbering.lastIssued;
};

export const formatNumber = (format: DocumentFormat, period: string, value: number): string => {
  const padded = String(value).padStart(format.numbering.width, '0');
  return format.numbering.perYear ? `${period}-${padded}` : padded;
};
