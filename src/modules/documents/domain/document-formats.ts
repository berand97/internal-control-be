import type { DocumentNumberingPolicy } from '../../../config/configuration.js';

export const SIGNER_SOURCE_VALUES = ['RESPONSIBLE', 'REQUEST'] as const;
export type SignerSource = (typeof SIGNER_SOURCE_VALUES)[number];

export interface SignerSpec {
  readonly order: number;
  readonly role: string;
  readonly label: string;
  readonly source: SignerSource;
}

export interface DocumentFormat {
  readonly key: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly effectiveFrom: string | null;
  readonly sgcCode: string | null;
  readonly version: string | null;
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

export interface ProcessFormatBinding {
  readonly formatKey: string;
  readonly process: string;
  readonly signers: Readonly<Record<string, SignerSource>> | 'ANY';
}

export const formatNotReadyReasons = (
  format: Pick<DocumentFormat, 'sgcCode' | 'signers'>,
): string[] => [
  ...(format.sgcCode ? [] : ['Falta el código SGC.']),
  ...(format.signers.length > 0 ? [] : ['Faltan los firmantes.']),
];

export const processBindingViolations = (
  binding: ProcessFormatBinding,
  signers: ReadonlyArray<Pick<SignerSpec, 'role' | 'source'>>,
): string[] => {
  if (binding.signers === 'ANY') {
    return [];
  }
  const required = binding.signers;
  const byRole = new Map(signers.map((signer) => [signer.role, signer.source]));
  return [
    ...Object.entries(required)
      .filter(([role]) => !byRole.has(role))
      .map(
        ([role]) =>
          `Falta el firmante ${role}. ${binding.process} lo necesita.`,
      ),
    ...Object.entries(required)
      .filter(
        ([role, source]) => byRole.has(role) && byRole.get(role) !== source,
      )
      .map(
        ([role, source]) =>
          `El firmante ${role} debe salir de ${source}. Así lo asigna ${binding.process}.`,
      ),
    ...signers
      .filter((signer) => !(signer.role in required))
      .map(
        (signer) =>
          `${binding.process} no asigna el firmante ${signer.role}. El acta no se podría generar.`,
      ),
  ];
};

export const periodFor = (
  format: Pick<DocumentFormat, 'numbering'>,
  date: Date,
): string => (format.numbering.perYear ? String(date.getFullYear()) : '');

export const initialSequenceValue = (
  format: Pick<DocumentFormat, 'numbering'>,
  period: string,
  policy: DocumentNumberingPolicy,
): number => {
  if (policy === 'restart') {
    return 0;
  }
  if (
    format.numbering.perYear &&
    format.numbering.lastIssuedPeriod !== period
  ) {
    return 0;
  }
  return format.numbering.lastIssued;
};

export const formatNumber = (
  format: Pick<DocumentFormat, 'numbering'>,
  period: string,
  value: number,
): string => {
  const padded = String(value).padStart(format.numbering.width, '0');
  return format.numbering.perYear ? `${period}-${padded}` : padded;
};

const INITIAL_FORMAT_NAMES: Readonly<Record<string, string>> = {
  'OCI-01-55': 'Acta de entrega y asignación de activos fijos',
  'OCI-01-65': 'Acta de préstamo temporal de activos fijos',
  'OCI-17-89': 'Acta de traslado de activos fijos',
  'OCI-17-90-BAJA': 'Acta de baja de activos fijos',
  'OCI-17-90-INFORME': 'Informe de baja a la Vicerrectoría Financiera',
  'OCI-21-37': 'Acta de toma física de inventario de activos fijos',
  LOAN_RETURN: 'Acta de devolución de préstamo temporal de activos fijos',
};

export const findFormat = (
  key: string,
): { readonly key: string; readonly name: string } | undefined =>
  INITIAL_FORMAT_NAMES[key]
    ? { key, name: INITIAL_FORMAT_NAMES[key] }
    : undefined;

export const SGC_VERSION_PATTERN = /^(?!.*\.\.)[0-9A-Za-z._-]{1,10}$/;
