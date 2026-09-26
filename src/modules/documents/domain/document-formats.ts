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
  /**
   * Código SGC institucional. null = la universidad aún no lo emitió: el formato existe en el catálogo (clave
   * interna, consecutivo propio, contrato de marcadores) pero el motor no lo genera (formatNotReadyReasons).
   */
  readonly sgcCode: string | null;
  /** Versión SGC; null mientras el formato no está emitido. */
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
  /** Firmantes en orden. Vacío = no definidos: el motor no genera el formato. */
  readonly signers: ReadonlyArray<SignerSpec>;
  readonly pendingDecisions: ReadonlyArray<string>;
}

/**
 * Catálogo de formatos que usa el motor. Token de inyección para que las pruebas puedan sustituir un formato
 * (p. ej. dar código y firmantes de prueba al acta de devolución); en la aplicación es DOCUMENT_FORMATS.
 */
export const DOCUMENT_FORMAT_CATALOG = Symbol('DOCUMENT_FORMAT_CATALOG');

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
  {
    /*
     * Acta de devolución de un préstamo temporal. Formato SGC NUEVO que la universidad aún no emite: sin código,
     * sin versión y sin firmantes, el motor se niega a generarlo (DOCUMENT_FORMAT_NOT_READY) y el préstamo registra
     * la devolución igual, mostrando el acta como pendiente de formato institucional.
     *
     * Contrato de marcadores (LoansService.receiveReturn arma la solicitud; además de los comunes del motor:
     * formato.*, documento.numero/fecha, centroCosto.* = centro de ORIGEN, responsable.* = persona de contacto
     * del destino, firmante.<rol>.*, activos[] y totalElementos):
     *   campos.fechaDevolucion           fecha real de devolución (la última de los activos de esta recepción)
     *   campos.fechaRecepcion            fecha en que el origen confirmó la recepción
     *   campos.fechaEntrega              fecha de la entrega del préstamo
     *   campos.fechaEstimadaDevolucion   fecha estimada vigente
     *   campos.tiempoUsoReal             entrega → fecha real de devolución ("0 años, 8 meses, 14 días")
     *   campos.actaEntregaCodigo         OCI-01-65
     *   campos.actaEntregaNumero         consecutivo del acta de entrega firmada ('' si no hay)
     *   campos.centroDestinoCodigo / campos.centroDestinoNombre
     *   campos.observaciones             notas de la devolución
     *   campos.totalDevueltos / campos.totalPerdidos / campos.totalPendientes (quedan fuera tras esta recepción)
     *   activos[].campos.condicionDevolucion   Bueno | Dañado | Perdido
     *   activos[].campos.fechaDevolucion       fecha real de ese activo
     *   activos[].campos.estadoEntrega         condición física registrada en la entrega
     * Cada activo del acta queda enlazado a su movimiento RETURN (document_asset.movement_id).
     */
    key: 'LOAN_RETURN',
    sgcCode: null,
    version: null,
    name: 'Acta de devolución de préstamo temporal de activos fijos',
    numbering: { width: 4, perYear: true, lastIssued: 0 },
    readPermission: 'loan:read:global',
    generatePermission: 'loan:update:global',
    signers: [],
    pendingDecisions: [
      'Código SGC y versión: formato nuevo que la universidad aún no ha emitido',
      'Firmantes y orden del acta de devolución: no definidos por Control Interno',
      'Formato del consecutivo (dígitos, anual o continuo): se usa AAAA-NNNN provisional, igual que OCI-01-65',
    ],
  },
];

export const findFormat = (key: string): DocumentFormat | undefined =>
  DOCUMENT_FORMATS.find((format) => format.key === key);

/** Por qué el motor no puede generar el formato; vacío si puede. */
export const formatNotReadyReasons = (format: DocumentFormat): string[] => [
  ...(format.sgcCode ? [] : ['sin código SGC institucional']),
  ...(format.signers.length > 0 ? [] : ['sin firmantes definidos']),
];

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
