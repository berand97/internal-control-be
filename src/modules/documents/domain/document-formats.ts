import type { DocumentNumberingPolicy } from '../../../config/configuration.js';

/**
 * Formatos SGC: qué es administrable y qué es código.
 *
 * ADMINISTRABLE (datos en BD, DocumentFormatCatalogService, endpoints /documents/formats/**):
 * - crear un formato (clave interna estable + permisos de lectura y generación);
 * - por versión, con fecha de vigencia: código y versión SGC, nombre, firmantes (orden, rol, etiqueta, origen),
 *   forma del consecutivo (dígitos, anual o continuo) y su valor inicial, decisiones pendientes;
 * - la plantilla Word de cada formato con su fecha de vigencia (document_template_version).
 * Nada se sobrescribe: cada cambio crea una versión nueva y cada acta queda enlazada a la versión con la que se
 * emitió (document.format_version_id). Sus firmantes, etiquetas, título del sobre y verificación pública salen de
 * esa versión, no de la vigente.
 *
 * CÓDIGO (desarrollo):
 * - enchufar un formato a un proceso de negocio (que firmar el acta cambie un préstamo, una entrega...): el proceso
 *   registra su manejador en DocumentLifecycleRegistry y declara ahí mismo (formats) qué claves usa y qué firmantes
 *   necesita. Hoy: OCI-01-55 → entregas (handovers), OCI-01-65 y LOAN_RETURN → préstamos (loans).
 * - lo que significa un rol: AUDITA y CONTROL_INTERNO son turnos de Control Interno y firman siempre con sesión y
 *   MFA (signing-channel.ts); los demás roles son libres.
 * - el contrato de marcadores de cada plantilla (qué campos arma el proceso).
 *
 * Origen de cada firmante (source):
 * - RESPONSIBLE: la persona la pone quien genera el acta en responsiblePersonId (en un proceso, el propio proceso:
 *   quien recibe la entrega, la persona de contacto del préstamo). Todos los turnos RESPONSIBLE son esa persona.
 * - REQUEST: la persona se pasa al generar, en signers[ROL] (POST /documents o el proceso).
 * Un formato enchufado a un proceso fija sus roles y orígenes (ProcessFormatBinding): una versión que quite, añada
 * o cambie el origen de uno de esos roles se rechaza (DOCUMENT_FORMAT_BREAKS_PROCESS). Etiquetas, orden, código,
 * versión, nombre y numeración siguen siendo administrables.
 *
 * Contrato de marcadores del acta de devolución (LOAN_RETURN): LoansService.receiveReturn arma la solicitud; además
 * de los comunes del motor (formato.*, documento.numero/fecha, centroCosto.* = centro de ORIGEN, responsable.* =
 * persona de contacto del destino, firmante.<rol>.*, activos[] y totalElementos):
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

export const SIGNER_SOURCE_VALUES = ['RESPONSIBLE', 'REQUEST'] as const;
export type SignerSource = (typeof SIGNER_SOURCE_VALUES)[number];

export interface SignerSpec {
  readonly order: number;
  readonly role: string;
  readonly label: string;
  readonly source: SignerSource;
}

/** Una versión de un formato, resuelta desde BD (document_format + document_format_version + signers). */
export interface DocumentFormat {
  readonly key: string;
  readonly versionId: string;
  readonly versionNumber: number;
  /** null solo en la versión 1 sembrada desde el catálogo en código: vigente desde siempre. */
  readonly effectiveFrom: string | null;
  /**
   * Código SGC institucional. null = la universidad aún no lo emitió: el formato existe (clave interna, consecutivo
   * propio, contrato de marcadores) pero el motor no lo genera (formatNotReadyReasons).
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
 * Enlace en código entre un formato y el proceso que lo genera. signers: rol → origen que el código del proceso
 * necesita (exactamente esos roles); 'ANY' si el proceso acepta cualquier conjunto de roles (la devolución pide los
 * REQUEST que diga la versión vigente).
 */
export interface ProcessFormatBinding {
  readonly formatKey: string;
  /** Qué proceso lo usa, para el mensaje de error y la pantalla de administración. */
  readonly process: string;
  readonly signers: Readonly<Record<string, SignerSource>> | 'ANY';
}

/** Por qué el motor no puede generar el formato; vacío si puede. */
export const formatNotReadyReasons = (
  format: Pick<DocumentFormat, 'sgcCode' | 'signers'>,
): string[] => [
  ...(format.sgcCode ? [] : ['sin código SGC institucional']),
  ...(format.signers.length > 0 ? [] : ['sin firmantes definidos']),
];

/**
 * Qué rompe una lista de firmantes respecto al proceso que usa el formato; vacío si nada. Solo para bindings con
 * roles fijos: el código del proceso los nombra (signers[ROL], signersByRole[ROL]).
 */
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
        ([role, source]) =>
          `Falta el rol ${role} (${source}): ${binding.process} lo usa`,
      ),
    ...Object.entries(required)
      .filter(
        ([role, source]) => byRole.has(role) && byRole.get(role) !== source,
      )
      .map(
        ([role, source]) =>
          `El rol ${role} debe tener origen ${source}: ${binding.process} lo asigna así`,
      ),
    ...signers
      .filter((signer) => !(signer.role in required))
      .map(
        (signer) =>
          `El rol ${signer.role} no lo asigna ${binding.process}: el acta no se podría generar`,
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

/**
 * Nombres de la versión inicial sembrada (migración 1767225730000). NO es la fuente de verdad: solo lo usa todavía
 * assets/services/asset-timeline.service.ts (fuera del módulo de documentos) para rotular una acta en la línea de
 * tiempo del activo. Un formato renombrado o creado por administración se verá allí con este nombre o con su clave
 * hasta que la línea de tiempo lea el nombre de la versión del acta (document.format_version_id).
 * @deprecated usar DocumentFormatCatalogService.
 */
const INITIAL_FORMAT_NAMES: Readonly<Record<string, string>> = {
  'OCI-01-55': 'Acta de entrega y asignación de activos fijos',
  'OCI-01-65': 'Acta de préstamo temporal de activos fijos',
  'OCI-17-89': 'Acta de traslado de activos fijos',
  'OCI-17-90-BAJA': 'Acta de baja de activos fijos',
  'OCI-17-90-INFORME': 'Informe de baja a la Vicerrectoría Financiera',
  'OCI-21-37': 'Acta de toma física de inventario de activos fijos',
  LOAN_RETURN: 'Acta de devolución de préstamo temporal de activos fijos',
};

/** @deprecated ver INITIAL_FORMAT_NAMES. */
export const findFormat = (
  key: string,
): { readonly key: string; readonly name: string } | undefined =>
  INITIAL_FORMAT_NAMES[key]
    ? { key, name: INITIAL_FORMAT_NAMES[key] }
    : undefined;
