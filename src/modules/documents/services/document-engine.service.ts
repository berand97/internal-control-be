import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { identityDocumentAbbreviation } from '../../../common/identity/identity-document-types.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig, StorageDriver } from '../../../config/configuration.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import { documentFileKey, documentTemplateKey, signedDocumentKey } from '../../../shared/storage/storage-keys.js';
import { readDocxPlaceholders, renderDocx } from '../../document-templates/domain/docx-template.js';
import { MfaAccountService } from '../../auth/services/mfa-account.service.js';
import { unitAt } from '../../cost-centers/domain/placement-at.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  type DocumentFormat,
  formatNotReadyReasons,
  formatNumber,
  initialSequenceValue,
  periodFor,
  SGC_VERSION_PATTERN,
} from '../domain/document-formats.js';
import {
  IDENTITY_AUTHORIZATION_MINUTES,
  lastFourDigits,
  MAX_IDENTITY_ATTEMPTS,
  methodLabel,
  requiresMfa,
  type SignatureMethod,
} from '../domain/signing-channel.js';
import { DocumentLifecycleRegistry } from '../lifecycle/document-lifecycle.registry.js';
import {
  type ResolvedSigner,
  resolveSigners,
  CONTROL_SIGNER_PERMISSION,
  designatedSigners,
  normalizeSubstitutions,
  requiresControlSigner,
  type SignerSubstitution,
} from '../domain/signer-separation.js';
import { PDF_CONVERTER, type PdfConverter } from '../pdf/pdf-converter.js';
import { SIGNATURE_PROVIDER, type SignatureProvider, type SignatureRequest } from '../signature/signature-provider.js';
import { bogotaToday, DocumentFormatCatalogService } from './document-format-catalog.service.js';
import { linkState, newSecret, sha256Hex, SigningLinkService, type SigningLinkRow } from './signing-link.service.js';

export interface VoidForEntityInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly reason: string;
  readonly actorId: string | null;
}

export interface VoidForEntityResult {
  readonly cancelledRequestIds: ReadonlyArray<string>;
  readonly voidedDocumentIds: ReadonlyArray<string>;
}

/** Estado público de un enlace de firma (GET /public/signing-links/:token). */
export type PublicLinkStatus = 'ACTIVE' | 'EXPIRED' | 'CONSUMED' | 'INVALIDATED';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const CONDITION_LABELS: Record<string, string> = {
  NEW: 'Nuevo',
  GOOD: 'Bueno',
  FAIR: 'Regular',
  POOR: 'Malo',
  OBSOLETE: 'Obsoleto',
};

export const UNVERIFIED_CONDITION = 'Sin verificar';

/** Reintentos automáticos (job) de la transición de un acta cuyo proceso falló; el sync manual no tiene tope. */
export const MAX_AUTOMATIC_LIFECYCLE_ATTEMPTS = 5;

const conditionLabel = (condition: string | null, flags: ReadonlyArray<string>): string =>
  condition === null || flags.includes('PHYSICAL_CONDITION_UNKNOWN')
    ? UNVERIFIED_CONDITION
    : (CONDITION_LABELS[condition] ?? condition);

export interface DocumentRequestPayload {
  readonly formatKey: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly costCenterId?: string;
  readonly responsiblePersonId?: string;
  readonly assetIds?: ReadonlyArray<string>;
  readonly movementIds?: Record<string, string>;
  readonly signers?: Record<string, string>;
  readonly assetNotes?: Record<string, string>;
  readonly fields?: Record<string, string>;
  /** Campos por activo: la plantilla los lee como activos[].campos.<nombre> ({} si el activo no trae). */
  readonly assetFields?: Record<string, Record<string, string>>;
  /**
   * Tablas adicionales: la plantilla las recorre como {{#tablas.<nombre>}}…{{/tablas.<nombre>}} y lee cada columna
   * por su nombre. Solo texto; nombres de tabla y columna como identificadores (assertPayloadTables acota la forma).
   */
  readonly tables?: Record<string, ReadonlyArray<Record<string, string>>>;
  /**
   * Sustitutos de turnos de Control Interno cuando el designado ocupa otra firma del acta o no tiene el permiso
   * act:sign_control:global vigente (domain/signer-separation.ts): rol → { personId, reason }. Solo AUDITA y
   * CONTROL_INTERNO.
   */
  readonly signerSubstitutions?: Record<string, SignerSubstitution>;
}

const TABLE_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export const MAX_PAYLOAD_TABLES = 10;
export const MAX_PAYLOAD_TABLE_ROWS = 20_000;
const MAX_PAYLOAD_TABLE_COLUMNS = 30;
const MAX_PAYLOAD_CELL_LENGTH = 2_000;

/** Forma de payload.tables; lanza VALIDATION_FAILED con el primer problema. */
export const assertPayloadTables = (tables: unknown): void => {
  if (tables === undefined) {
    return;
  }
  const fail = (message: string): never => {
    throw new ApiException(ErrorCode.ValidationFailed, `Tablas del acta: ${message}`);
  };
  if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) {
    return fail('deben ser un objeto nombre → filas');
  }
  const entries = Object.entries(tables as Record<string, unknown>);
  if (entries.length > MAX_PAYLOAD_TABLES) {
    fail(`a lo sumo ${MAX_PAYLOAD_TABLES} tablas`);
  }
  for (const [name, rows] of entries) {
    if (!TABLE_IDENTIFIER.test(name)) {
      fail(`nombre de tabla inválido (${name.slice(0, 40)})`);
    }
    if (!Array.isArray(rows)) {
      return fail(`${name} debe ser una lista de filas`);
    }
    if (rows.length > MAX_PAYLOAD_TABLE_ROWS) {
      fail(`${name} supera ${MAX_PAYLOAD_TABLE_ROWS} filas`);
    }
    for (const row of rows as unknown[]) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        return fail(`${name}: cada fila es un objeto columna → texto`);
      }
      const cells = Object.entries(row as Record<string, unknown>);
      if (cells.length > MAX_PAYLOAD_TABLE_COLUMNS) {
        fail(`${name}: a lo sumo ${MAX_PAYLOAD_TABLE_COLUMNS} columnas`);
      }
      for (const [column, value] of cells) {
        if (!TABLE_IDENTIFIER.test(column)) {
          fail(`${name}: columna inválida (${column.slice(0, 40)})`);
        }
        if (typeof value !== 'string' || value.length > MAX_PAYLOAD_CELL_LENGTH) {
          fail(`${name}.${column}: texto de hasta ${MAX_PAYLOAD_CELL_LENGTH} caracteres`);
        }
      }
    }
  }
};

export interface GeneratedDocument {
  readonly id: string;
  readonly formatKey: string;
  readonly number: string;
  readonly status: string;
  readonly pdfDriver: string;
  readonly pdfKey: string;
}

interface TemplateRow {
  id: string;
  sgc_version: string;
  effective_date: string;
  storage_driver: StorageDriver;
  storage_key: string;
}

interface ActParty {
  nombre: string;
  documento: string;
  cargo: string;
}

interface ActSigner extends ActParty {
  orden: number;
  rol: string;
  etiqueta: string;
  personId: string | null;
  /** Solo en un turno sustituido al emitir (separación de funciones): a quién reemplaza el firmante y en qué turno. */
  sustituye?: { nombre: string; rol: string };
  motivoSustitucion?: string;
}

interface ActContext {
  firmantes: ActSigner[];
  firmante: Record<string, ActParty>;
  responsable: ActParty;
  auditor: ActParty;
  [key: string]: unknown;
}

interface SlotRow {
  sign_order: number;
  role: string;
  signer_person_id: string | null;
  signer_name: string | null;
  status: string;
  signed_at: Date | null;
  method: SignatureMethod | null;
}

interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  document_number: string | null;
  position_title: string | null;
  email: string | null;
}

/**
 * Cada firmante por su rol, para que la plantilla lo nombre donde corresponde: {{firmante.recibe.nombre}},
 * {{firmante.entrega.cargo}}, {{firmante.audita.documento}}, {{firmante.recibe.tipoDocumento}}... (rol en
 * minúsculas: recibe, entrega, audita, responsable, control_interno, contabilidad). Contrato fijo con las
 * plantillas. tipoDocumento es la abreviatura del catálogo (C.C., C.E., …) o '' si el tipo se desconoce: el acta
 * imprime entonces solo el número, nunca un tipo supuesto.
 *
 * Turno sustituido al emitir (separación de funciones, domain/signer-separation.ts): además
 *   firmante.<rol>.sustitucion.nombre   persona designada a la que reemplaza el firmante
 *   firmante.<rol>.sustitucion.rol      turno en que la reemplaza (etiqueta del formato)
 *   firmante.<rol>.sustitucion.motivo   motivo de la sustitución
 * y la tabla {{#tablas.sustituciones}}{{rol}} {{sustituto}} {{sustituido}} {{conflicto}} {{motivo}}{{/tablas.sustituciones}}
 * (conflicto: las otras firmas que ocupa el sustituido). Sin sustitución, firmante.<rol>.sustitucion no existe y la
 * tabla no se imprime (el renderizador deja '' en lo que falta).
 */
const signersByRole = (
  signers: ReadonlyArray<ActSigner & { readonly tipoDocumento?: string }>,
): Record<string, ActParty & { tipoDocumento: string; sustitucion?: { nombre: string; rol: string; motivo: string } }> =>
  Object.fromEntries(
    signers.map((signer) => [
      signer.rol.toLowerCase(),
      {
        nombre: signer.nombre,
        tipoDocumento: signer.tipoDocumento ?? '',
        documento: signer.documento,
        cargo: signer.cargo,
        ...(signer.sustituye
          ? { sustitucion: { nombre: signer.sustituye.nombre, rol: signer.sustituye.rol, motivo: signer.motivoSustitucion ?? '' } }
          : {}),
      },
    ]),
  );

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

const longDate = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
    .format(date)
    .replaceAll(' de ', ' DE ')
    .toUpperCase();

const personName = (person: PersonRow | undefined): string =>
  person ? `${person.first_name} ${person.last_name}`.trim() : '';

@Injectable()
export class DocumentEngineService {
  private readonly logger = new Logger(DocumentEngineService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(PDF_CONVERTER) private readonly pdf: PdfConverter,
    @Inject(SIGNATURE_PROVIDER) private readonly signatures: SignatureProvider,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly links: SigningLinkService,
    private readonly mfaAccount: MfaAccountService,
    private readonly catalog: DocumentFormatCatalogService,
  ) {}

  /**
   * Si el motor puede generar el formato hoy: su versión vigente tiene código SGC y firmantes. Los procesos lo
   * consultan antes de encolar para no romperse cuando el formato institucional aún no existe (acta de devolución).
   */
  async formatReadiness(
    formatKey: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<{ readonly format: DocumentFormat; readonly ready: boolean; readonly reasons: string[] }> {
    const format = await this.catalog.current(formatKey, manager);
    const reasons = formatNotReadyReasons(format);
    return { format, ready: reasons.length === 0, reasons };
  }

  private assertReady(format: DocumentFormat): void {
    const reasons = formatNotReadyReasons(format);
    if (reasons.length > 0) {
      throw new ApiException(
        ErrorCode.DocumentFormatNotReady,
        `El formato ${format.key} no se puede generar: ${reasons.join('; ')}`,
      );
    }
  }

  /** Versión vigente de cada formato, ordenados por código SGC (sin código al final), con plantilla y consecutivo. */
  async formats() {
    const formats = (await this.catalog.currentAll()).sort(
      (a, b) =>
        Number(a.sgcCode === null) - Number(b.sgcCode === null) ||
        (a.sgcCode ?? '').localeCompare(b.sgcCode ?? '') ||
        a.key.localeCompare(b.key),
    );
    const result = [];
    for (const format of formats) {
      result.push(await this.formatSummary(format));
    }
    return result;
  }

  /** Un formato con su versión vigente, como en GET /documents/formats. */
  async formatSummary(format: DocumentFormat) {
    const today = new Date().toISOString().slice(0, 10);
    const template = await this.activeTemplate(format.key, today, this.dataSource.manager);
    const [sequence] = (await this.dataSource.query(
      'SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = $2',
      [format.key, periodFor(format, new Date())],
    )) as Array<{ current_value: string }>;
    const binding = this.catalog.bindingFor(format.key);
    const scheduled = await this.catalog.scheduled(format.key);
    return {
      key: format.key,
      sgcCode: format.sgcCode,
      version: format.version,
      name: format.name,
      numbering: format.numbering,
      readPermission: format.readPermission,
      generatePermission: format.generatePermission,
      signers: format.signers,
      pendingDecisions: format.pendingDecisions,
      ready: formatNotReadyReasons(format).length === 0,
      activeTemplate: template ? { id: template.id, version: template.sgc_version, effectiveDate: template.effective_date } : null,
      lastIssuedNumber: sequence ? Number(sequence.current_value) : null,
      versionId: format.versionId,
      versionNumber: format.versionNumber,
      effectiveFrom: format.effectiveFrom,
      scheduledVersion: scheduled
        ? { versionId: scheduled.versionId, versionNumber: scheduled.versionNumber, effectiveFrom: scheduled.effectiveFrom ?? '' }
        : null,
      process: binding
        ? {
            name: binding.process,
            requiredSigners:
              binding.signers === 'ANY'
                ? null
                : Object.entries(binding.signers).map(([role, source]) => ({ role, source })),
          }
        : null,
    };
  }

  /**
   * Plantilla Word del formato con su fecha de vigencia. Se registra con el código SGC de la versión del formato que
   * regirá cuando la plantilla empiece a usarse (la de su fecha de vigencia, o la vigente hoy si la fecha ya pasó).
   * sgcVersion (versión impresa en formato.version) por defecto es la de esa versión del formato.
   */
  async uploadTemplate(
    formatKey: string,
    file: { readonly buffer: Buffer; readonly originalname: string },
    meta: { readonly sgcVersion?: string; readonly effectiveDate: string },
    actorId: string | null,
  ) {
    const today = bogotaToday();
    const format = await this.catalog.current(formatKey, this.dataSource.manager, meta.effectiveDate > today ? meta.effectiveDate : today);
    if (!format.sgcCode) {
      // La plantilla se registra con su código SGC (document_template_version.sgc_code NOT NULL).
      throw new ApiException(ErrorCode.DocumentFormatNotReady, `El formato ${format.key} aún no tiene código SGC institucional`);
    }
    const sgcVersion = meta.sgcVersion?.trim() || format.version || '';
    // BE-17: la versión va en la clave; se valida aunque venga del catálogo (filas anteriores a la regla).
    if (!SGC_VERSION_PATTERN.test(sgcVersion)) {
      throw new ApiException(ErrorCode.ValidationFailed, undefined, [
        {
          field: 'sgcVersion',
          message: 'Versión SGC de 1 a 10 caracteres (letras, dígitos, punto, guion), sin "/" ni ".."',
        },
      ]);
    }
    const placeholders = readDocxPlaceholders(file.buffer);
    const stored = await this.storage.put({
      // El sufijo lo genera el servidor: dos cargas con la misma fecha y versión ya no se pisan el archivo.
      key: documentTemplateKey({ formatKey: format.key, effectiveDate: meta.effectiveDate, version: sgcVersion, id: randomUUID() }),
      body: file.buffer,
      contentType: DOCX_MIME,
    });
    const [row] = (await this.dataSource.query(
      `INSERT INTO document_template_version (format_key, sgc_code, sgc_version, effective_date, storage_driver,
         storage_key, file_hash, original_filename, placeholders, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        format.key,
        format.sgcCode,
        sgcVersion,
        meta.effectiveDate,
        stored.driver,
        stored.key,
        stored.checksumSha256,
        file.originalname,
        JSON.stringify(placeholders),
        actorId,
      ],
    )) as Array<{ id: string }>;
    return { id: row?.id, formatKey: format.key, placeholders };
  }

  /**
   * Firmantes del acta con la regla del firmante de Control Interno y la separación de funciones aplicadas
   * (domain/signer-separation.ts): todo turno AUDITA/CONTROL_INTERNO lo ocupa alguien con act:sign_control:global
   * vigente, y nadie ocupa dos firmas salvo sustituto de Control Interno. Lo usan assertSigners (cada proceso, antes de
   * tocar nada), enqueue (el proceso recibe el error al crear, no el outbox después) y generateWithin (autoridad: el
   * permiso se vuelve a comprobar al generar).
   */
  private async signersFor(
    manager: EntityManager,
    format: DocumentFormat,
    payload: DocumentRequestPayload,
    actorId: string | null,
  ): Promise<ResolvedSigner[]> {
    const designated = designatedSigners(format.signers, payload).filter(
      (signer): signer is { spec: ResolvedSigner['spec']; personId: string } =>
        requiresControlSigner(signer.spec.role) && Boolean(signer.personId),
    );
    const substituteIds = Object.values(normalizeSubstitutions(payload.signerSubstitutions)).map((item) => item.personId);
    const allowed = await this.controlSignersAmong(manager, [...designated.map((signer) => signer.personId), ...substituteIds]);
    const ineligible = designated.filter((signer) => !allowed.has(signer.personId));
    const resolved = resolveSigners(format.signers, payload, new Set(ineligible.map((signer) => signer.spec.role)));
    const substitutes = resolved.filter((signer) => signer.substitution);
    // Designado de Control Interno sin el permiso y sin sustituto: el turno no se puede emitir así.
    const unresolved = ineligible.filter((signer) => !substitutes.some((item) => item.spec.role === signer.spec.role));
    if (unresolved.length > 0) {
      throw new ApiException(
        ErrorCode.DocumentSignerNotEligible,
        `La persona designada para ${unresolved.map((signer) => `${signer.spec.label} (${signer.spec.role})`).join(', ')} no tiene usuario activo con el permiso «Firmar actas por Control Interno» vigente: elija a quien lo tenga o indique un sustituto con motivo`,
        unresolved.map((signer) => ({
          field: `signers.${signer.spec.role}`,
          message: `El turno ${signer.spec.role} exige el permiso vigente ${CONTROL_SIGNER_PERMISSION}`,
        })),
      );
    }
    if (substitutes.length === 0) {
      return resolved;
    }
    if (!actorId) {
      throw new ApiException(ErrorCode.DocumentSignerSubstituteInvalid, 'Una sustitución de firmante necesita un usuario que la haga');
    }
    const rejected = substitutes.filter((signer) => !allowed.has(signer.personId ?? ''));
    if (rejected.length > 0) {
      throw new ApiException(
        ErrorCode.DocumentSignerSubstituteInvalid,
        `El sustituto de ${rejected.map((signer) => signer.spec.label).join(', ')} no tiene usuario activo con el permiso «Firmar actas por Control Interno» vigente`,
        rejected.map((signer) => ({
          field: `signerSubstitutions.${signer.spec.role}.personId`,
          message: `Sin el permiso vigente ${CONTROL_SIGNER_PERMISSION}`,
        })),
      );
    }
    return resolved;
  }

  /**
   * De las personas dadas, las que hoy pueden firmar por Control Interno: persona activa con usuario ACTIVE y el
   * permiso vigente act:sign_control:global (v_user_effective_permissions: asignaciones sin revocar, dentro de su
   * vigencia, roles no borrados, con herencia), en cualquier alcance. Mismo criterio que ControlSignersService.holders.
   * Decide el permiso, no el nombre del rol.
   */
  private async controlSignersAmong(manager: EntityManager, personIds: ReadonlyArray<string>): Promise<Set<string>> {
    const ids = [...new Set(personIds)];
    if (ids.length === 0) {
      return new Set();
    }
    const rows = (await manager.query(
      `SELECT DISTINCT u.person_id FROM app_user u
       JOIN person p ON p.id = u.person_id AND p.is_active
       JOIN v_user_effective_permissions v ON v.user_id = u.id AND v.permission_code = $2
       WHERE u.person_id = ANY($1::uuid[]) AND u.status = 'ACTIVE'`,
      [ids, CONTROL_SIGNER_PERMISSION],
    )) as Array<{ person_id: string }>;
    return new Set(rows.map((row) => row.person_id));
  }

  /**
   * Validación temprana de los firmantes de un proceso (préstamo, entrega, …) ANTES de tocar activos o estados:
   * misma regla que enqueue, para que el error claro (DOCUMENT_SIGNER_NOT_ELIGIBLE, DOCUMENT_SIGNER_DUPLICATED,
   * DOCUMENT_SIGNER_SUBSTITUTE_INVALID) salga antes de encolar. enqueue lo vuelve a comprobar.
   */
  async assertSigners(
    manager: EntityManager,
    payload: Pick<DocumentRequestPayload, 'formatKey' | 'responsiblePersonId' | 'signers' | 'signerSubstitutions'>,
    actorId: string | null,
  ): Promise<void> {
    const format = await this.catalog.current(payload.formatKey, manager);
    await this.signersFor(manager, format, payload, actorId);
  }

  async enqueue(manager: EntityManager, payload: DocumentRequestPayload, requestedBy: string | null): Promise<string> {
    const format = await this.catalog.current(payload.formatKey, manager);
    this.assertReady(format);
    await this.signersFor(manager, format, payload, requestedBy);
    assertPayloadTables(payload.tables);
    const rows = (await manager.query(
      `INSERT INTO document_request (format_key, payload, requested_by) VALUES ($1, $2, $3) RETURNING id`,
      [payload.formatKey, JSON.stringify(payload), requestedBy],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async processPending(limit = 20): Promise<{ generated: number; failed: number }> {
    const pending = (await this.dataSource.query(
      `SELECT id FROM document_request
       WHERE status = 'PENDING' OR (status = 'FAILED' AND attempts < 5)
       ORDER BY created_at LIMIT $1`,
      [limit],
    )) as Array<{ id: string }>;
    let generated = 0;
    let failed = 0;
    for (const { id } of pending) {
      try {
        const document = await this.dataSource.transaction(async (manager) => {
          // CANCELLED (voidForEntity) y GENERATED quedan fuera: nunca se generan.
          const [request] = (await manager.query(
            `SELECT payload, requested_by, created_at FROM document_request
             WHERE id = $1 AND status IN ('PENDING', 'FAILED') FOR UPDATE SKIP LOCKED`,
            [id],
          )) as Array<{ payload: DocumentRequestPayload; requested_by: string | null; created_at: Date }>;
          if (!request) {
            return null;
          }
          // El acta lleva la fecha del proceso (la de la solicitud), no la del intento que por fin la genera.
          const created = await this.generateWithin(manager, request.payload, request.requested_by, {
            documentDate: new Date(request.created_at),
          });
          await manager.query(
            `UPDATE document_request SET status = 'GENERATED', document_id = $2, processed_at = NOW(),
               attempts = attempts + 1, last_error = NULL WHERE id = $1`,
            [id, created.id],
          );
          return created;
        });
        if (document) {
          generated += 1;
          await this.afterGeneration(document.id);
        }
      } catch (error) {
        failed += 1;
        await this.dataSource.query(
          `UPDATE document_request SET status = 'FAILED', attempts = attempts + 1, last_error = $2, processed_at = NOW()
           WHERE id = $1 AND status IN ('PENDING', 'FAILED')`,
          [id, error instanceof Error ? error.message.slice(0, 1000) : String(error)],
        );
      }
    }
    return { generated, failed };
  }

  async generate(payload: DocumentRequestPayload, actorId: string): Promise<GeneratedDocument> {
    const format = await this.catalog.current(payload.formatKey);
    await this.assertPermission(actorId, format.generatePermission);
    const document = await this.dataSource.transaction((manager) => this.generateWithin(manager, payload, actorId));
    await this.afterGeneration(document.id);
    return document;
  }

  /** Pide las firmas y, si el primer turno se firma por enlace, lo emite. Nada de esto deshace el acta. */
  private async afterGeneration(documentId: string): Promise<void> {
    await this.requestSignatures(documentId).catch((error: unknown) => {
      this.logger.error(`No se pudo pedir las firmas del acta ${documentId}`, error instanceof Error ? error.stack : String(error));
    });
    await this.refreshSigningLink(documentId);
  }

  private async refreshSigningLink(documentId: string): Promise<void> {
    await this.links.refresh(documentId).catch((error: unknown) => {
      this.logger.error(
        `No se pudo preparar el enlace de firma del acta ${documentId}`,
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  /**
   * options.documentDate: fecha del acta (documento.fecha). Por defecto hoy; el outbox pasa la fecha de la solicitud
   * para que un reintento días después no separe el acta de la fecha real del proceso. El consecutivo (periodo) y la
   * plantilla vigente se toman del momento de generar.
   */
  async generateWithin(
    manager: EntityManager,
    payload: DocumentRequestPayload,
    actorId: string | null,
    options: { readonly documentDate?: Date } = {},
  ): Promise<GeneratedDocument> {
    // La versión vigente al generar queda enlazada al acta (format_version_id): firmantes y etiquetas salen de ella.
    const format = await this.catalog.current(payload.formatKey, manager);
    this.assertReady(format);
    assertPayloadTables(payload.tables);
    const resolved = await this.signersFor(manager, format, payload, actorId);
    const now = new Date();
    const template = await this.activeTemplate(format.key, now.toISOString().slice(0, 10), manager);
    if (!template) {
      throw new ApiException(ErrorCode.TemplateNotActive, `No hay plantilla vigente para ${format.key}`);
    }
    const source = await this.storage.getFrom(template.storage_driver, template.storage_key);
    const context = await this.buildContext(manager, format, template, payload, resolved, options.documentDate ?? now);

    const period = periodFor(format, now);
    const value = await this.reserve(manager, format, period);
    const number = formatNumber(format, period, value);
    const data = { ...context, documento: { ...context.documento, numero: number } };

    const docx = renderDocx(source, data);
    const pdf = await this.pdf.toPdf(docx, `${format.key}-${number}.docx`);
    // created_at explícito (no el NOW() de la transacción): la carpeta del acta es el año de este instante.
    const keyInput = { createdAt: now, formatKey: format.key, number };
    const storedDocx = await this.storage.put({
      key: documentFileKey({ ...keyInput, extension: 'docx' }),
      body: docx,
      contentType: DOCX_MIME,
    });
    const storedPdf = await this.storage.put({
      key: documentFileKey({ ...keyInput, extension: 'pdf' }),
      body: pdf,
      contentType: 'application/pdf',
    });

    const [row] = (await manager.query(
      `INSERT INTO document (format_key, number, period, sequence_value, template_version_id, status, entity_type,
         entity_id, data, docx_driver, docx_key, docx_hash, pdf_driver, pdf_key, pdf_hash, created_by, format_version_id,
         created_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_SIGNATURE', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        format.key,
        number,
        period,
        value,
        template.id,
        payload.entityType ?? null,
        payload.entityId ?? null,
        JSON.stringify(data),
        storedDocx.driver,
        storedDocx.key,
        storedDocx.checksumSha256,
        storedPdf.driver,
        storedPdf.key,
        storedPdf.checksumSha256,
        actorId,
        format.versionId,
        now,
      ],
    )) as Array<{ id: string }>;
    const documentId = row?.id ?? '';
    await this.linkAssets(manager, documentId, payload);
    const signers = context.firmantes as Array<{
      orden: number;
      rol: string;
      personId: string | null;
      nombre: string;
      documento: string;
    }>;
    for (const signer of signers) {
      await manager.query(
        `INSERT INTO document_signature (document_id, sign_order, role, signer_person_id, signer_name, signer_document)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [documentId, signer.orden, signer.rol, signer.personId, signer.nombre || null, signer.documento || null],
      );
    }
    // Sustituciones al emitir: misma bitácora que las reasignaciones posteriores (source = 'AT_ISSUE'), con el PDF que
    // ya las imprime. reassigned_by es quien generó el acta (signersFor exige usuario si hay sustitución).
    for (const signer of resolved.filter((item) => item.substitution)) {
      await manager.query(
        `INSERT INTO document_signature_reassignment (document_id, sign_order, role, from_person_id, to_person_id, reason,
           reassigned_by, source, new_pdf_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'AT_ISSUE', $8)`,
        [
          documentId,
          signer.spec.order,
          signer.spec.role,
          signer.substitution?.replacedPersonId,
          signer.personId,
          signer.substitution?.reason,
          actorId,
          storedPdf.checksumSha256,
        ],
      );
    }
    // Dentro de la transacción del llamador: si el proceso no acepta el acta, no queda documento (ni consecutivo).
    await this.lifecycle.dispatch(manager, 'onGenerated', documentId);
    return {
      id: documentId,
      formatKey: format.key,
      number,
      status: 'PENDING_SIGNATURE',
      pdfDriver: storedPdf.driver,
      pdfKey: storedPdf.key,
    };
  }

  async requestSignatures(documentId: string): Promise<void> {
    const document = await this.documentRow(documentId);
    if (document.signature_reference) {
      return;
    }
    const pdf = await this.storage.getFrom(document.pdf_driver, document.pdf_key);
    const { externalReference } = await this.signatures.request(
      await this.signatureRequestFor(this.dataSource.manager, document, pdf),
    );
    await this.dataSource.query(
      'UPDATE document SET signature_provider = $2, signature_reference = $3 WHERE id = $1',
      [documentId, this.signatures.name, externalReference],
    );
  }

  private async signatureRequestFor(
    manager: EntityManager,
    document: { readonly id: string; readonly number: string; readonly format_key: string; readonly created_at: Date },
    pdf: Buffer,
  ): Promise<SignatureRequest> {
    const signers = (await manager.query(
      `SELECT s.sign_order, s.role, s.signer_person_id, s.signer_name, s.signer_document, p.email
       FROM document_signature s LEFT JOIN person p ON p.id = s.signer_person_id
       WHERE s.document_id = $1 ORDER BY s.sign_order`,
      [document.id],
    )) as Array<{
      sign_order: number;
      role: string;
      signer_person_id: string | null;
      signer_name: string | null;
      signer_document: string | null;
      email: string | null;
    }>;
    // La versión con que se emitió el acta, no la vigente: el sobre y la hoja de firmas describen sus reglas.
    const format = await this.catalog.forDocument(document.id, manager);
    return {
      documentId: document.id,
      documentCreatedAt: document.created_at,
      documentNumber: document.number,
      formatKey: document.format_key,
      title: `${format.sgcCode ?? format.key} · ${format.name} · ${document.number}`,
      pdf,
      pdfSha256: sha256(pdf),
      signers: signers.map((signer) => ({
        order: signer.sign_order,
        role: signer.role,
        roleLabel: format.signers.find((spec) => spec.role === signer.role)?.label ?? signer.role,
        personId: signer.signer_person_id,
        name: signer.signer_name,
        documentNumber: signer.signer_document,
        email: signer.email,
      })),
    };
  }

  async syncSignatures(documentId: string) {
    const document = await this.documentRow(documentId);
    if (!document.signature_reference) {
      await this.requestSignatures(documentId);
      await this.refreshSigningLink(documentId);
      return this.detail(documentId);
    }
    const statuses = await this.signatures.status(document.signature_reference);
    const failure = await this.dataSource.transaction(async (manager) => {
      const [locked] = (await manager.query('SELECT status FROM document WHERE id = $1 FOR UPDATE', [documentId])) as Array<{
        status: string;
      }>;
      for (const status of statuses) {
        await manager.query(
          `UPDATE document_signature SET status = $3, signed_at = $4, evidence = $5
           WHERE document_id = $1 AND sign_order = $2`,
          [documentId, status.order, status.status, status.signedAt ?? null, JSON.stringify(status.evidence ?? null)],
        );
      }
      const [counts] = (await manager.query(
        `SELECT count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE status <> 'SIGNED')::int AS unsigned
         FROM document_signature WHERE document_id = $1`,
        [documentId],
      )) as Array<{ rejected: number; unsigned: number }>;
      const target = (counts?.rejected ?? 0) > 0 ? 'REJECTED' : counts?.unsigned === 0 ? 'SIGNED' : 'PENDING_SIGNATURE';
      if (locked?.status !== 'PENDING_SIGNATURE' || target === 'PENDING_SIGNATURE') {
        return null;
      }
      // La transición y el efecto del proceso van juntos: si el manejador falla se deshacen ambos (savepoint) y
      // quedan confirmadas solo las firmas y el error. El acta sigue PENDING_SIGNATURE y un sync posterior reintenta.
      await manager.query('SAVEPOINT document_lifecycle');
      try {
        await manager.query(
          `UPDATE document SET status = $2::text, signed_at = CASE WHEN $2::text = 'SIGNED' THEN coalesce(signed_at, NOW()) END,
             lifecycle_error = NULL, lifecycle_failed_at = NULL
           WHERE id = $1`,
          [documentId, target],
        );
        await this.lifecycle.dispatch(manager, target === 'SIGNED' ? 'onSigned' : 'onRejected', documentId);
        await manager.query('RELEASE SAVEPOINT document_lifecycle');
        return null;
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT document_lifecycle');
        const message = error instanceof Error ? error.message : String(error);
        await manager.query(
          `UPDATE document SET lifecycle_error = $2, lifecycle_failed_at = NOW(), lifecycle_attempts = lifecycle_attempts + 1
           WHERE id = $1`,
          [documentId, message.slice(0, 1000)],
        );
        return { target, error };
      }
    });
    if (failure) {
      this.logger.error(
        `El acta ${documentId} no pasó a ${failure.target}: el proceso que la originó falló y se reintentará`,
        failure.error instanceof Error ? failure.error.stack : String(failure.error),
      );
    }
    // Un fallo al guardar el PDF firmado no deshace la firma ya capturada: el job lo reintenta (retrySignedPdfs).
    await this.storeSignedPdf(documentId).catch((error: unknown) => {
      this.logger.error(
        `No se pudo guardar el PDF firmado del acta ${documentId}; se reintentará`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    // El turno pudo avanzar: si el siguiente firma por enlace, se emite (y se invalidan los de turnos pasados).
    await this.refreshSigningLink(documentId);
    return this.detail(documentId);
  }

  /** Actas SIGNED sin PDF firmado guardado (falló storeSignedPdf): el job las reintenta. */
  async retrySignedPdfs(limit = 20): Promise<{ retried: number; stillMissing: number }> {
    if (!this.signatures.signedDocument) {
      return { retried: 0, stillMissing: 0 };
    }
    const missing = (await this.dataSource.query(
      `SELECT id FROM document
       WHERE status = 'SIGNED' AND signed_pdf_key IS NULL AND signature_reference IS NOT NULL AND signature_provider = $2
       ORDER BY signed_at NULLS FIRST LIMIT $1`,
      [limit, this.signatures.name],
    )) as Array<{ id: string }>;
    let stillMissing = 0;
    for (const { id } of missing) {
      try {
        await this.storeSignedPdf(id);
      } catch (error) {
        stillMissing += 1;
        this.logger.error(`No se pudo guardar el PDF firmado del acta ${id}`, error instanceof Error ? error.stack : String(error));
      }
    }
    return { retried: missing.length, stillMissing };
  }

  /** Reintenta la transición de las actas cuyo proceso falló al completarlas (lo llama el job). */
  async retryLifecycle(limit = 20): Promise<{ retried: number; stillFailing: number }> {
    const stalled = (await this.dataSource.query(
      `SELECT id FROM document
       WHERE lifecycle_error IS NOT NULL AND status = 'PENDING_SIGNATURE' AND lifecycle_attempts < $2
       ORDER BY lifecycle_failed_at LIMIT $1`,
      [limit, MAX_AUTOMATIC_LIFECYCLE_ATTEMPTS],
    )) as Array<{ id: string }>;
    let stillFailing = 0;
    for (const { id } of stalled) {
      try {
        const detail = await this.syncSignatures(id);
        stillFailing += detail.lifecycleError ? 1 : 0;
      } catch (error) {
        stillFailing += 1;
        this.logger.error(`No se pudo reintentar el acta ${id}`, error instanceof Error ? error.stack : String(error));
      }
    }
    return { retried: stalled.length, stillFailing };
  }

  async sign(
    documentId: string,
    order: number,
    actor: AuthenticatedUser,
    rubricPng: Buffer,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const { reference, sessionId, method } = await this.prepareSignerAction(documentId, order, actor);
    if (!this.signatures.capture) {
      throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no captura firmas en el sistema`);
    }
    await this.signatures.capture(reference, {
      order,
      method,
      signerUserId: actor.id,
      signerPersonId: actor.personId,
      sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      rubricPng,
    });
    await this.syncSignatures(documentId);
    return this.detail(documentId, actor);
  }

  async rejectSignature(
    documentId: string,
    order: number,
    actor: AuthenticatedUser,
    reason: string,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const { reference, sessionId, method } = await this.prepareSignerAction(documentId, order, actor);
    if (!this.signatures.reject) {
      throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no recibe rechazos en el sistema`);
    }
    await this.signatures.reject(reference, {
      order,
      method,
      signerUserId: actor.id,
      signerPersonId: actor.personId,
      sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      reason,
    });
    await this.syncSignatures(documentId);
    return this.detail(documentId, actor);
  }

  async attestation(verificationCode: string) {
    const attestation = this.signatures.attestation ? await this.signatures.attestation(verificationCode) : null;
    if (!attestation) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe una firma con ese código');
    }
    return attestation;
  }

  /** Reenvía el enlace de firma del turno actual (invalida el anterior). Permiso de generación del formato. */
  async resendSigningLink(documentId: string, order: number, actor: AuthenticatedUser) {
    await this.assertPermission(actor.id, (await this.catalog.forDocument(documentId)).generatePermission);
    await this.links.resend(documentId, order, actor.id);
    return this.detail(documentId, actor);
  }

  /**
   * Anula las actas de una entidad cuyo proceso se canceló, dentro de la transacción del proceso (manager):
   * - solicitudes PENDING/FAILED del outbox → CANCELLED (el job ya no las genera);
   * - actas PENDING_SIGNATURE → VOIDED con motivo, quién y cuándo; su sobre queda cerrado y sus enlaces invalidados;
   *   nadie puede firmarlas después;
   * - un acta SIGNED no se anula: DOCUMENT_ALREADY_SIGNED y el llamador revierte su transacción;
   * - REJECTED y VOIDED se dejan como están.
   * No dispara onRejected: quien anula es el propio proceso, que ya sabe por qué. El llamador debe tener bloqueada su
   * entidad; si el job está generando el acta en ese momento, este UPDATE espera y luego la encuentra como documento.
   */
  async voidForEntity(manager: EntityManager, input: VoidForEntityInput): Promise<VoidForEntityResult> {
    const reason = input.reason.trim();
    if (!input.entityType.trim() || !input.entityId.trim() || !reason) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Anular exige entityType, entityId y motivo');
    }
    // Primero el outbox: si el job está generando una solicitud (fila bloqueada) se espera a que termine, y el SELECT
    // de documentos que sigue (nueva instantánea en READ COMMITTED) ya ve el acta que produjo.
    const cancelled = (await manager.query(
      `WITH cancelled AS (
         UPDATE document_request SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $3, cancel_reason = $4
         WHERE payload->>'entityType' = $1 AND payload->>'entityId' = $2 AND status IN ('PENDING', 'FAILED')
         RETURNING id
       ) SELECT id FROM cancelled`,
      [input.entityType, input.entityId, input.actorId, reason],
    )) as Array<{ id: string }>;
    const documents = UUID_PATTERN.test(input.entityId)
      ? ((await manager.query(
          `SELECT id, number, status, signature_reference FROM document
           WHERE entity_type = $1 AND entity_id = $2::uuid ORDER BY created_at FOR UPDATE`,
          [input.entityType, input.entityId],
        )) as Array<{ id: string; number: string; status: string; signature_reference: string | null }>)
      : [];
    const signed = documents.filter((document) => document.status === 'SIGNED');
    if (signed.length > 0) {
      throw new ApiException(
        ErrorCode.DocumentAlreadySigned,
        `El acta ${signed.map((document) => document.number).join(', ')} ya está firmada y no se puede anular`,
      );
    }
    const voided: string[] = [];
    for (const document of documents.filter((item) => item.status === 'PENDING_SIGNATURE')) {
      await manager.query(
        `UPDATE document SET status = 'VOIDED', voided_at = NOW(), voided_by = $2, void_reason = $3,
           lifecycle_error = NULL, lifecycle_failed_at = NULL
         WHERE id = $1`,
        [document.id, input.actorId, reason],
      );
      if (document.signature_reference && this.signatures.void) {
        await this.signatures.void(document.signature_reference, manager);
      }
      await this.links.invalidate(manager, document.id, 'VOIDED');
      voided.push(document.id);
    }
    return { cancelledRequestIds: cancelled.map((row) => row.id), voidedDocumentIds: voided };
  }

  // ---------- Firma por enlace de un solo uso (páginas públicas /firmar/:token) ----------

  /**
   * Enlace utilizable: existe, no se consumió ni invalidó, no venció, y sigue siendo el turno actual de esa persona
   * en un acta pendiente (y no es un turno de Control Interno, que siempre firma con sesión y MFA).
   */
  private async linkContext(manager: EntityManager, token: string, lock: boolean) {
    const link = await this.links.findByToken(manager, token, lock);
    if (!link) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el enlace de firma');
    }
    const document = await this.documentRow(link.document_id);
    const current = await this.links.currentTurn(manager, link.document_id);
    const state = linkState(link);
    const status: PublicLinkStatus =
      state === 'CONSUMED' || state === 'INVALIDATED' || state === 'EXPIRED'
        ? state
        : current?.sign_order === link.sign_order &&
            current.signer_person_id === link.person_id &&
            !requiresMfa(current.role) &&
            link.expires_at !== null
          ? 'ACTIVE'
          : 'INVALIDATED';
    return { link, document, current, status };
  }

  private async activeLink(manager: EntityManager, token: string) {
    const context = await this.linkContext(manager, token, true);
    if (context.status !== 'ACTIVE' || !context.current) {
      throw new ApiException(ErrorCode.SignatureLinkUnavailable);
    }
    return { ...context, current: context.current };
  }

  /**
   * Vista pública del enlace (Ley 1581, dato mínimo): solo lo que la pantalla necesita para firmar ESTE turno —estado
   * del enlace, vencimiento, intentos, formato y número del acta y el rol del propio turno—. Nada de firmantes (ni
   * nombres, ni siquiera enmascarados, ni el propio), nada de otros turnos y ningún enlace o ruta del sistema.
   */
  async signingLinkView(token: string) {
    const { link, document, current, status } = await this.linkContext(this.dataSource.manager, token, false);
    const active = status === 'ACTIVE';
    const format = await this.catalog.forDocument(document.id);
    return {
      status,
      expiresAt: link.expires_at ? new Date(link.expires_at).toISOString() : null,
      consumedAction: link.consumed_action,
      identityAttemptsRemaining: Math.max(0, MAX_IDENTITY_ATTEMPTS - link.identity_attempts),
      document: active ? { sgcCode: format.sgcCode ?? format.key, formatName: format.name, number: document.number } : null,
      turn:
        active && current
          ? {
              order: current.sign_order,
              roleLabel: format.signers.find((spec) => spec.role === current.role)?.label ?? current.role,
            }
          : null,
    };
  }

  async signingLinkPdf(token: string): Promise<{ readonly body: Buffer; readonly fileName: string }> {
    const { document } = await this.activeLink(this.dataSource.manager, token);
    if (!document.signature_reference || !this.signatures.currentDocument) {
      throw new ApiException(ErrorCode.InvalidState, 'El acta todavía no tiene solicitud de firma');
    }
    return {
      body: await this.signatures.currentDocument(document.signature_reference),
      fileName: `${document.format_key}-${document.number}.pdf`,
    };
  }

  /**
   * Confirma la identidad con los últimos 4 dígitos del documento de la persona designada. Devuelve una autorización
   * de pocos minutos para firmar o rechazar. Cada fallo cuenta; al quinto el enlace queda invalidado.
   */
  async confirmSigningLinkIdentity(token: string, last4: string) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const { link } = await this.activeLink(manager, token);
      const [person] = (await manager.query('SELECT document_number FROM person WHERE id = $1', [link.person_id])) as Array<{
        document_number: string | null;
      }>;
      const expected = lastFourDigits(person?.document_number);
      if (!expected) {
        return { kind: 'NO_IDENTITY' as const };
      }
      if (!timingSafeEqual(Buffer.from(last4.padEnd(4).slice(0, 4)), Buffer.from(expected))) {
        const attempts = link.identity_attempts + 1;
        const locked = attempts >= MAX_IDENTITY_ATTEMPTS;
        await manager.query(
          `UPDATE signature_signing_link SET identity_attempts = $2,
             invalidated_at = CASE WHEN $3::boolean THEN NOW() END,
             invalidated_reason = CASE WHEN $3::boolean THEN 'ATTEMPTS_EXCEEDED' END,
             authorization_hash = NULL, authorization_expires_at = NULL
           WHERE id = $1`,
          [link.id, attempts, locked],
        );
        return locked ? { kind: 'LOCKED' as const } : { kind: 'MISMATCH' as const, remaining: MAX_IDENTITY_ATTEMPTS - attempts };
      }
      const identityToken = newSecret();
      const [row] = (await manager.query(
        `UPDATE signature_signing_link SET identity_confirmed_at = NOW(), authorization_hash = $2,
           authorization_expires_at = NOW() + make_interval(mins => $3)
         WHERE id = $1 RETURNING authorization_expires_at`,
        [link.id, sha256Hex(identityToken), IDENTITY_AUTHORIZATION_MINUTES],
      )) as Array<{ authorization_expires_at: Date }>;
      return { kind: 'CONFIRMED' as const, identityToken, expiresAt: row?.authorization_expires_at ?? new Date() };
    });
    // Los errores se lanzan fuera de la transacción: el intento fallido queda contado.
    switch (outcome.kind) {
      case 'NO_IDENTITY':
        throw new ApiException(ErrorCode.SignatureNoIdentityCheck);
      case 'LOCKED':
        throw new ApiException(ErrorCode.SignatureIdentityLocked);
      case 'MISMATCH':
        throw new ApiException(ErrorCode.SignatureIdentityMismatch, undefined, [
          { field: 'last4', message: `Quedan ${outcome.remaining} intentos` },
        ]);
      default:
        return { identityToken: outcome.identityToken, expiresAt: new Date(outcome.expiresAt).toISOString() };
    }
  }

  async signByLink(
    token: string,
    identityToken: string,
    rubricPng: Buffer,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    return this.actByLink(token, identityToken, 'SIGNED', async (manager, link, reference) => {
      if (!this.signatures.capture) {
        throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no captura firmas en el sistema`);
      }
      await this.signatures.capture(
        reference,
        {
          order: link.sign_order,
          signerPersonId: link.person_id,
          ...this.linkEvidence(link),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          rubricPng,
        },
        manager,
      );
    });
  }

  async rejectByLink(
    token: string,
    identityToken: string,
    reason: string,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    return this.actByLink(token, identityToken, 'REJECTED', async (manager, link, reference) => {
      if (!this.signatures.reject) {
        throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no recibe rechazos en el sistema`);
      }
      await this.signatures.reject(
        reference,
        {
          order: link.sign_order,
          signerPersonId: link.person_id,
          ...this.linkEvidence(link),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          reason,
        },
        manager,
      );
    });
  }

  private linkEvidence(link: SigningLinkRow) {
    return {
      method: 'EMAIL_LINK' as const,
      signingLinkId: link.id,
      linkEmail: link.email,
      linkSentAt: link.sent_at,
      identityConfirmedAt: link.identity_confirmed_at ?? new Date(),
    };
  }

  /** Firma o rechazo por enlace: la acción y el consumo del enlace van en la misma transacción (un solo uso). */
  private async actByLink(
    token: string,
    identityToken: string,
    action: 'SIGNED' | 'REJECTED',
    perform: (manager: EntityManager, link: SigningLinkRow, reference: string) => Promise<void>,
  ) {
    const documentId = await this.dataSource.transaction(async (manager) => {
      const { link, document } = await this.activeLink(manager, token);
      const authorized =
        link.identity_confirmed_at !== null &&
        link.authorization_hash !== null &&
        link.authorization_expires_at !== null &&
        new Date(link.authorization_expires_at) > new Date() &&
        link.authorization_hash === sha256Hex(identityToken);
      if (!authorized) {
        throw new ApiException(ErrorCode.SignatureIdentityRequired);
      }
      if (!document.signature_reference) {
        throw new ApiException(ErrorCode.InvalidState, 'El acta todavía no tiene solicitud de firma');
      }
      await perform(manager, link, document.signature_reference);
      await manager.query(
        `UPDATE signature_signing_link SET consumed_at = NOW(), consumed_action = $2,
           authorization_hash = NULL, authorization_expires_at = NULL
         WHERE id = $1`,
        [link.id, action],
      );
      return document.id;
    });
    await this.syncSignatures(documentId);
    const document = await this.documentRow(documentId);
    const verification =
      document.signature_reference && this.signatures.verification
        ? await this.signatures.verification(document.signature_reference)
        : null;
    return { action, at: new Date().toISOString(), verificationUrl: verification?.url ?? null };
  }

  async reassignSigner(
    documentId: string,
    order: number,
    personId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const document = await this.documentRow(documentId);
    const format = await this.catalog.forDocument(document.id);
    await this.assertPermission(actor.id, format.generatePermission);
    const [person] = (await this.dataSource.query(
      'SELECT id, first_name, last_name, document_number, position_title, email FROM person WHERE id = $1',
      [personId],
    )) as PersonRow[];
    if (!person) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la persona indicada');
    }
    await this.dataSource.transaction(async (manager) => {
      const [targetSlot] = (await manager.query(
        'SELECT role FROM document_signature WHERE document_id = $1 AND sign_order = $2',
        [documentId, order],
      )) as Array<{ role: string }>;
      if (targetSlot) {
        // La persona debe poder firmar este turno por algún camino (ver domain/signing-channel.ts).
        const channel = await this.links.channel(manager, targetSlot.role, personId);
        if (channel.blockedBy) {
          throw new ApiException(
            ErrorCode.SignatureSignerCannotSign,
            requiresMfa(targetSlot.role)
              ? 'El turno de Control Interno exige una persona activa con usuario activo y verificación en dos pasos'
              : 'La persona debe estar activa y tener usuario activo, o correo y número de documento para firmar por enlace',
            [{ field: 'personId', message: channel.blockedBy }],
          );
        }
        // Regla del firmante de Control Interno (domain/signer-separation.ts): la misma que al emitir.
        if (requiresControlSigner(targetSlot.role) && !(await this.controlSignersAmong(manager, [personId])).has(personId)) {
          throw new ApiException(
            ErrorCode.DocumentSignerNotEligible,
            `El turno ${targetSlot.role} es de Control Interno: la persona debe tener usuario activo con el permiso «Firmar actas por Control Interno» vigente`,
            [{ field: 'personId', message: `El turno ${targetSlot.role} exige el permiso vigente ${CONTROL_SIGNER_PERMISSION}` }],
          );
        }
      }
      const [locked] = (await manager.query(
        `SELECT id, number, period, format_key, status, data, template_version_id, pdf_hash, signature_reference,
           created_at
         FROM document WHERE id = $1 FOR UPDATE`,
        [documentId],
      )) as Array<{
        id: string;
        number: string;
        period: string;
        format_key: string;
        status: string;
        data: ActContext;
        template_version_id: string;
        pdf_hash: string;
        signature_reference: string | null;
        created_at: Date;
      }>;
      if (locked?.status !== 'PENDING_SIGNATURE') {
        throw new ApiException(ErrorCode.InvalidState, 'El documento no está pendiente de firma');
      }
      const slots = (await manager.query(
        'SELECT sign_order, role, signer_person_id, status FROM document_signature WHERE document_id = $1 ORDER BY sign_order FOR UPDATE',
        [documentId],
      )) as Array<{ sign_order: number; role: string; signer_person_id: string | null; status: string }>;
      const slot = slots.find((item) => item.sign_order === order);
      if (!slot) {
        throw new ApiException(ErrorCode.ResourceNotFound, `El documento no tiene el firmante ${order}`);
      }
      if (slots.some((item) => item.status !== 'PENDING')) {
        throw new ApiException(ErrorCode.SignatureReassignAfterSigning);
      }
      if (slot.signer_person_id === personId) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La persona ya está asignada a ese turno');
      }
      // Separación de funciones: la reasignación no puede dejar a una persona en dos firmas del acta.
      const taken = slots.filter((item) => item.sign_order !== order && item.signer_person_id === personId);
      if (taken.length > 0) {
        const label = (role: string) => format.signers.find((spec) => spec.role === role)?.label ?? role;
        throw new ApiException(
          ErrorCode.DocumentSignerDuplicated,
          `Separación de funciones: la persona ya firma el acta como ${taken.map((item) => `${label(item.role)} (${item.role})`).join(', ')}`,
          [
            { field: 'personId', message: `Ya firma como ${taken.map((item) => item.role).join(', ')}` },
            ...taken.map((item) => ({ field: `signers.${item.role}`, message: `Misma persona que ${label(slot.role)} (${slot.role})` })),
            // Conflicto con un turno de Control Interno: se resuelve reasignando ese turno a un sustituto con el permiso.
            ...[slot, ...taken]
              .filter((item) => requiresControlSigner(item.role))
              .map((item) => ({
                field: `signers.${item.role}`,
                message: `Reasigne el turno ${item.role} a otra persona con el permiso vigente ${CONTROL_SIGNER_PERMISSION}, con el motivo`,
              })),
          ],
        );
      }
      await manager.query(
        `UPDATE document_signature SET signer_person_id = $3, signer_name = $4, signer_document = $5
         WHERE document_id = $1 AND sign_order = $2`,
        [documentId, order, personId, personName(person) || null, person.document_number],
      );
      await this.links.invalidate(manager, documentId, 'REASSIGNED', order);
      const reissued = await this.rerender(manager, locked, format, order, person);
      await manager.query(
        `INSERT INTO document_signature_reassignment (document_id, sign_order, role, from_person_id, to_person_id, reason,
           reassigned_by, session_id, ip_address, user_agent, previous_pdf_hash, new_pdf_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          documentId,
          order,
          slot.role,
          slot.signer_person_id,
          personId,
          reason,
          actor.id,
          actor.sessionId ?? null,
          context.ipAddress,
          context.userAgent,
          locked.pdf_hash,
          reissued.pdfHash,
        ],
      );
      if (locked.signature_reference) {
        if (!this.signatures.reissue) {
          throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no permite reemitir el acta`);
        }
        await this.signatures.reissue(
          locked.signature_reference,
          await this.signatureRequestFor(manager, locked, reissued.pdf),
          manager,
        );
      }
    });
    await this.refreshSigningLink(documentId);
    return this.detail(documentId, actor);
  }

  private async rerender(
    manager: EntityManager,
    document: {
      readonly id: string;
      readonly number: string;
      readonly period: string;
      readonly format_key: string;
      readonly data: ActContext;
      readonly template_version_id: string;
      readonly created_at: Date;
    },
    format: DocumentFormat,
    order: number,
    person: PersonRow,
  ): Promise<{ readonly pdf: Buffer; readonly pdfHash: string }> {
    const spec = format.signers.find((item) => item.order === order);
    const [identity] = (await manager.query('SELECT document_type FROM person WHERE id = $1', [person.id])) as Array<{
      document_type: string | null;
    }>;
    const signer = {
      nombre: personName(person),
      tipoDocumento: person.document_number ? identityDocumentAbbreviation(identity?.document_type) : '',
      documento: person.document_number ?? '',
      cargo: person.position_title ?? spec?.label ?? '',
    };
    const firmantes: Array<ActSigner & { tipoDocumento?: string }> = document.data.firmantes.map((item) =>
      item.orden === order ? { ...item, personId: person.id, ...signer } : item,
    );
    const auditor = firmantes.find((item) => item.rol === 'AUDITA' || item.rol === 'CONTROL_INTERNO');
    const auditorParty = auditor
      ? { nombre: auditor.nombre, tipoDocumento: auditor.tipoDocumento ?? '', documento: auditor.documento, cargo: auditor.cargo }
      : document.data.auditor;
    const data: ActContext = {
      ...document.data,
      firmantes,
      firmante: signersByRole(firmantes),
      ...(spec?.source === 'RESPONSIBLE' ? { responsable: signer } : {}),
      auditor: auditorParty,
    };
    const [template] = (await manager.query(
      'SELECT storage_driver, storage_key FROM document_template_version WHERE id = $1',
      [document.template_version_id],
    )) as Array<{ storage_driver: StorageDriver; storage_key: string }>;
    if (!template) {
      throw new ApiException(ErrorCode.TemplateNotActive, 'No se encontró la versión de plantilla del acta');
    }
    const [revisions] = (await manager.query(
"SELECT count(*)::int AS total FROM document_signature_reassignment WHERE document_id = $1 AND source = 'REASSIGNED'",
      [document.id],
    )) as Array<{ total: number }>;
    const docx = renderDocx(await this.storage.getFrom(template.storage_driver, template.storage_key), data);
    const pdf = await this.pdf.toPdf(docx, `${format.key}-${document.number}.docx`);
    const keyInput = {
      createdAt: document.created_at,
      formatKey: format.key,
      number: document.number,
      revision: (revisions?.total ?? 0) + 1,
    };
    const storedDocx = await this.storage.put({
      key: documentFileKey({ ...keyInput, extension: 'docx' }),
      body: docx,
      contentType: DOCX_MIME,
    });
    const storedPdf = await this.storage.put({
      key: documentFileKey({ ...keyInput, extension: 'pdf' }),
      body: pdf,
      contentType: 'application/pdf',
    });
    await manager.query(
      `UPDATE document SET data = $2, docx_driver = $3, docx_key = $4, docx_hash = $5, pdf_driver = $6, pdf_key = $7, pdf_hash = $8
       WHERE id = $1`,
      [
        document.id,
        JSON.stringify(data),
        storedDocx.driver,
        storedDocx.key,
        storedDocx.checksumSha256,
        storedPdf.driver,
        storedPdf.key,
        storedPdf.checksumSha256,
      ],
    );
    return { pdf, pdfHash: storedPdf.checksumSha256 };
  }

  private async viewerState(
    document: { readonly status: string },
    format: DocumentFormat,
    slots: ReadonlyArray<SlotRow>,
    actor: AuthenticatedUser,
    currentTurnChannel: SignatureMethod | null,
  ) {
    const mine = slots.filter((slot) => slot.signer_person_id !== null && slot.signer_person_id === actor.personId);
    const next = mine.find((slot) => slot.status === 'PENDING');
    const blocker = next ? await this.signerBlocker(document, slots, next.sign_order, actor) : null;
    const administers = await this.permissions.userHasPermission(actor.id, format.generatePermission);
    return {
      personId: actor.personId,
      signerOrders: mine.map((slot) => slot.sign_order),
      isCurrentSigner:
        document.status === 'PENDING_SIGNATURE' &&
        !slots.some((slot) => slot.status === 'REJECTED') &&
        next !== undefined &&
        slots.find((slot) => slot.status === 'PENDING')?.sign_order === next.sign_order,
      nextOrder: next?.sign_order ?? null,
      canSign: blocker !== null && blocker.code === null,
      blockedBy: blocker?.code ?? null,
      // Tras la primera firma (o un rechazo) reasignar alteraría lo que otros firmaron: reassignSigner lo rechaza.
      canReassign:
        document.status === 'PENDING_SIGNATURE' && slots.every((slot) => slot.status === 'PENDING') && administers,
      canResendLink: administers && currentTurnChannel === 'EMAIL_LINK',
    };
  }

  private async signerSlots(documentId: string): Promise<SlotRow[]> {
    return (await this.dataSource.query(
      `SELECT s.sign_order, s.role, s.signer_person_id, s.signer_name, s.status, s.signed_at, s.evidence->>'method' AS method
       FROM document_signature s WHERE s.document_id = $1 ORDER BY s.sign_order`,
      [documentId],
    )) as SlotRow[];
  }

  private async signerBlocker(
    document: { readonly status: string },
    slots: ReadonlyArray<SlotRow>,
    order: number,
    actor: AuthenticatedUser,
  ): Promise<{ readonly code: ErrorCode | null; readonly method: 'SESSION_MFA' | 'SESSION' }> {
    const blocked = (code: ErrorCode) => ({ code, method: 'SESSION' as const });
    if (document.status !== 'PENDING_SIGNATURE' || slots.some((item) => item.status === 'REJECTED')) {
      return blocked(ErrorCode.InvalidState);
    }
    const slot = slots.find((item) => item.sign_order === order);
    if (!slot) {
      return blocked(ErrorCode.ResourceNotFound);
    }
    if (slot.status !== 'PENDING') {
      return blocked(ErrorCode.InvalidState);
    }
    if (!slot.signer_person_id) {
      return blocked(ErrorCode.SignatureSignerUnassigned);
    }
    if (slot.signer_person_id !== actor.personId) {
      return blocked(ErrorCode.SignatureNotDesignatedSigner);
    }
    if (slots.find((item) => item.status === 'PENDING')?.sign_order !== order) {
      return blocked(ErrorCode.SignatureOutOfOrder);
    }
    const [session] = (await this.dataSource.query(
      `SELECT 1 AS found FROM app_user u
       JOIN refresh_token_family f ON f.user_id = u.id
       WHERE u.id = $1 AND f.id = $2 AND f.status = 'ACTIVE' AND f.expires_at > NOW() AND u.status = 'ACTIVE'`,
      [actor.id, actor.sessionId ?? null],
    )) as Array<{ found: number }>;
    if (!actor.sessionId || !session) {
      return blocked(ErrorCode.SignatureSessionInvalid);
    }
    // "Sesión con MFA" = sesión abierta o elevada con segundo factor (MfaAccountService.isMfaSession), no el
    // mfa_enabled del usuario: quien tiene MFA pero entró solo con contraseña firma como SESSION.
    const mfaSession = await this.mfaAccount.isMfaSession(actor);
    // MFA obligatorio solo en los turnos de Control Interno; en los demás basta la sesión vigente.
    if (requiresMfa(slot.role) && !mfaSession) {
      return blocked(ErrorCode.SignatureMfaRequired);
    }
    return { code: null, method: mfaSession ? 'SESSION_MFA' : 'SESSION' };
  }

  private async prepareSignerAction(documentId: string, order: number, actor: AuthenticatedUser) {
    const document = await this.documentRow(documentId);
    const blocker = await this.signerBlocker(document, await this.signerSlots(documentId), order, actor);
    if (blocker.code === ErrorCode.InvalidState) {
      throw new ApiException(ErrorCode.InvalidState, `El documento no está pendiente de firma en el turno ${order}`);
    }
    if (blocker.code === ErrorCode.ResourceNotFound) {
      throw new ApiException(ErrorCode.ResourceNotFound, `El documento no tiene el firmante ${order}`);
    }
    if (blocker.code) {
      throw new ApiException(blocker.code);
    }
    if (!document.signature_reference) {
      await this.requestSignatures(documentId);
    }
    const reference = document.signature_reference ?? (await this.documentRow(documentId)).signature_reference;
    return { reference: reference ?? '', sessionId: actor.sessionId ?? '', method: blocker.method };
  }

  private async storeSignedPdf(documentId: string): Promise<void> {
    const document = await this.documentRow(documentId);
    if (document.status !== 'SIGNED' || document.signed_pdf_key || !document.signature_reference || !this.signatures.signedDocument) {
      return;
    }
    const signed = await this.signatures.signedDocument(document.signature_reference);
    const stored = await this.storage.put({
      key: signedDocumentKey({ createdAt: document.created_at, formatKey: document.format_key, number: document.number }),
      body: signed,
      contentType: 'application/pdf',
    });
    await this.dataSource.query(
      `UPDATE document SET signed_pdf_driver = $2, signed_pdf_key = $3, signed_pdf_hash = $4
       WHERE id = $1 AND signed_pdf_key IS NULL`,
      [documentId, stored.driver, stored.key, stored.checksumSha256],
    );
  }

  async detail(documentId: string, actor?: AuthenticatedUser) {
    const document = await this.documentRow(documentId);
    const format = await this.catalog.forDocument(document.id);
    if (actor) {
      await this.assertCanRead(documentId, format.readPermission, actor.id);
    }
    const slots = await this.signerSlots(documentId);
    const label = (role: string) => format.signers.find((spec) => spec.role === role)?.label ?? role;
    const links = await this.links.latestByOrder(documentId);
    const signatures = slots.map((slot) => ({
      order: slot.sign_order,
      role: slot.role,
      roleLabel: label(slot.role),
      personId: slot.signer_person_id,
      name: slot.signer_name,
      status: slot.status,
      signedAt: slot.signed_at,
      method: slot.status === 'PENDING' ? null : slot.method,
      methodLabel: slot.status === 'PENDING' ? null : methodLabel(slot.method),
      signingLink: this.linkSummary(links.get(slot.sign_order)),
    }));
    // Con una firma rechazada no hay turno, aunque el acta siga PENDING_SIGNATURE porque su proceso falló (lifecycleError).
    const pending =
      document.status === 'PENDING_SIGNATURE' && !slots.some((slot) => slot.status === 'REJECTED')
        ? slots.find((slot) => slot.status === 'PENDING')
        : undefined;
    const turnChannel = pending
      ? await this.links.channel(this.dataSource.manager, pending.role, pending.signer_person_id)
      : null;
    const currentTurn = pending
      ? {
          order: pending.sign_order,
          role: pending.role,
          roleLabel: label(pending.role),
          personId: pending.signer_person_id,
          name: pending.signer_name,
          assigned: pending.signer_person_id !== null,
          channel: turnChannel?.channel ?? null,
          blockedBy: turnChannel?.blockedBy ?? null,
        }
      : null;
    const reassignments = (await this.dataSource.query(
      `SELECT r.sign_order AS "order", r.role, r.from_person_id AS "fromPersonId", r.to_person_id AS "toPersonId",
              nullif(trim(concat_ws(' ', pf.first_name, pf.last_name)), '') AS "fromName",
              nullif(trim(concat_ws(' ', pt.first_name, pt.last_name)), '') AS "toName",
              r.reason, r.reassigned_by AS "reassignedBy", r.reassigned_at AS "reassignedAt",
              r.previous_pdf_hash AS "previousPdfSha256", r.new_pdf_hash AS "newPdfSha256", r.source
       FROM document_signature_reassignment r
       LEFT JOIN person pf ON pf.id = r.from_person_id
       JOIN person pt ON pt.id = r.to_person_id
       WHERE r.document_id = $1 ORDER BY r.reassigned_at, r.id`,
      [documentId],
    )) as ReadonlyArray<Record<string, unknown>>;
    return {
      currentTurn,
      viewer: actor ? await this.viewerState(document, format, slots, actor, currentTurn?.channel ?? null) : null,
      verification:
        document.signature_reference && this.signatures.verification
          ? await this.signatures.verification(document.signature_reference)
          : null,
      reassignments,
      id: document.id,
      formatKey: document.format_key,
      number: document.number,
      status: document.status,
      entityType: document.entity_type,
      entityId: document.entity_id,
      links: await this.lifecycle.links(document.entity_type, document.entity_id),
      pdfDriver: document.pdf_driver,
      signatureProvider: document.signature_provider,
      pdfSha256: document.pdf_hash,
      signedPdfSha256: document.signed_pdf_hash,
      signatures,
      lifecycleError: document.lifecycle_error,
      lifecycleFailedAt: document.lifecycle_failed_at,
      voidedAt: document.voided_at,
      voidedBy: document.voided_by,
      voidReason: document.void_reason,
    };
  }

  /** Estado del enlace de firma para quien administra el proceso. Nunca incluye el token ni su hash. */
  private linkSummary(link: SigningLinkRow | undefined) {
    if (!link) {
      return null;
    }
    return {
      status: linkState(link),
      email: link.email,
      sendAttempts: link.send_attempts,
      lastSendError: link.delivery_status === 'FAILED' ? link.last_send_error : null,
      createdAt: link.created_at,
      sentAt: link.sent_at,
      expiresAt: link.expires_at,
      identityAttempts: link.identity_attempts,
      identityConfirmedAt: link.identity_confirmed_at,
      consumedAt: link.consumed_at,
      consumedAction: link.consumed_action,
      invalidatedAt: link.invalidated_at,
      invalidatedReason: link.invalidated_reason,
    };
  }

  async download(documentId: string, kind: 'pdf' | 'docx', actorId: string) {
    const document = await this.documentRow(documentId);
    await this.assertCanRead(documentId, (await this.catalog.forDocument(documentId)).readPermission, actorId);
    const signed = kind === 'pdf' && document.signed_pdf_driver && document.signed_pdf_key;
    const body = signed
      ? await this.storage.getFrom(document.signed_pdf_driver as StorageDriver, document.signed_pdf_key as string)
      : kind === 'pdf'
        ? await this.storage.getFrom(document.pdf_driver, document.pdf_key)
        : await this.storage.getFrom(document.docx_driver, document.docx_key);
    return {
      body,
      fileName: `${document.format_key}-${document.number}${signed ? '-firmado' : ''}.${kind}`,
      contentType: kind === 'pdf' ? 'application/pdf' : DOCX_MIME,
    };
  }

  private async reserve(manager: EntityManager, format: DocumentFormat, period: string): Promise<number> {
    const policy = this.config.getOrThrow('documents', { infer: true }).numberingPolicy;
    await manager.query(
      `INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)
       ON CONFLICT (format_key, period) DO NOTHING`,
      [format.key, period, initialSequenceValue(format, period, policy)],
    );
    const [row] = (await manager.query(
      `WITH reserved AS (
         UPDATE document_sequence SET current_value = current_value + 1, updated_at = NOW()
         WHERE format_key = $1 AND period = $2 RETURNING current_value
       ) SELECT current_value FROM reserved`,
      [format.key, period],
    )) as Array<{ current_value: string }>;
    if (!row) {
      throw new Error(`No se pudo reservar consecutivo para ${format.key}`);
    }
    return Number(row.current_value);
  }

  /** Si el formato tiene plantilla vigente hoy (sin ella, la solicitud del outbox falla con TEMPLATE_NOT_ACTIVE). */
  async hasActiveTemplate(formatKey: string, manager: EntityManager = this.dataSource.manager): Promise<boolean> {
    return (await this.activeTemplate(formatKey, new Date().toISOString().slice(0, 10), manager)) !== undefined;
  }

  private async activeTemplate(formatKey: string, date: string, manager: EntityManager): Promise<TemplateRow | undefined> {
    const [row] = (await manager.query(
      `SELECT id, sgc_version, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, storage_driver, storage_key
       FROM document_template_version
       WHERE format_key = $1 AND effective_date <= $2
       ORDER BY effective_date DESC LIMIT 1`,
      [formatKey, date],
    )) as TemplateRow[];
    return row;
  }

  private async buildContext(
    manager: EntityManager,
    format: DocumentFormat,
    template: TemplateRow,
    payload: DocumentRequestPayload,
    resolved: ReadonlyArray<ResolvedSigner>,
    now: Date,
  ) {
    const personIds = [
      ...new Set(
        [
          payload.responsiblePersonId,
          ...Object.values(payload.signers ?? {}),
          ...resolved.flatMap((signer) => [signer.personId, signer.substitution?.replacedPersonId]),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const persons = personIds.length
      ? ((await manager.query(
          `SELECT id, first_name, last_name, document_type, document_number, position_title, email FROM person WHERE id = ANY($1)`,
          [personIds],
        )) as Array<PersonRow & { document_type: string | null }>)
      : [];
    // Abreviatura del tipo solo si hay número; tipo desconocido → '' (el acta imprime solo el número).
    const documentType = (person: (typeof persons)[number] | undefined): string =>
      person?.document_number ? identityDocumentAbbreviation(person.document_type) : '';
    const byId = new Map(persons.map((person) => [person.id, person]));
    const missing = personIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, `Personas inexistentes: ${missing.join(', ')}`);
    }
    const [costCenter] = payload.costCenterId
      ? ((await manager.query('SELECT external_code, name FROM cost_center WHERE id = $1', [
          payload.costCenterId,
        ])) as Array<{ external_code: string; name: string }>)
      : [];
    if (payload.costCenterId && !costCenter) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Centro de costo inexistente');
    }
    // Unidad del centro vigente a la fecha del acta (no la de hoy): queda en el snapshot document.data y un re-render
    // posterior (firma, reasignación) sigue mostrando la de la emisión aunque el centro se mueva de unidad.
    const costCenterUnit = payload.costCenterId ? await unitAt(manager, payload.costCenterId, now) : null;
    const assetIds = payload.assetIds ?? [];
    const assets = assetIds.length
      ? ((await manager.query(
          `SELECT a.id, a.internal_code, a.description, a.physical_condition, a.data_quality_flags, o.legacy_asset_id,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1) AS visible_code,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1) AS legacy_code
           FROM asset a LEFT JOIN asset_import_origin o ON o.asset_id = a.id
           WHERE a.id = ANY($1)`,
          [assetIds],
        )) as Array<{
          id: string;
          internal_code: string;
          description: string;
          physical_condition: string | null;
          data_quality_flags: string[];
          legacy_asset_id: string | null;
          visible_code: string | null;
          legacy_code: string | null;
        }>)
      : [];
    if (assets.length !== new Set(assetIds).size) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Hay activos inexistentes en la solicitud');
    }
    const ordered = assetIds
      .map((id) => assets.find((asset) => asset.id === id))
      .filter((asset): asset is (typeof assets)[number] => asset !== undefined);

    const responsible = payload.responsiblePersonId ? byId.get(payload.responsiblePersonId) : undefined;
    const signers = resolved.map(({ spec, personId, substitution }) => {
      const person = personId ? byId.get(personId) : undefined;
      return {
        orden: spec.order,
        rol: spec.role,
        etiqueta: spec.label,
        personId,
        nombre: personName(person),
        tipoDocumento: documentType(person),
        documento: person?.document_number ?? '',
        cargo: person?.position_title ?? spec.label,
        ...(substitution
          ? {
              sustituye: { nombre: personName(byId.get(substitution.replacedPersonId)), rol: spec.label },
              motivoSustitucion: substitution.reason,
            }
          : {}),
      };
    });
    // Las otras firmas que ocupaba cada designado sustituido: por qué no pudo firmar el turno de Control Interno.
    const substitutions = resolved
      .filter((signer) => signer.substitution)
      .map((signer) => ({
        rol: signer.spec.label,
        sustituto: personName(byId.get(signer.personId ?? '')),
        sustituido: personName(byId.get(signer.substitution?.replacedPersonId ?? '')),
        conflicto: resolved
          .filter((other) => other !== signer && other.personId === signer.substitution?.replacedPersonId)
          .map((other) => other.spec.label)
          .join(', '),
        motivo: signer.substitution?.reason ?? '',
      }));
    const tables =
      payload.tables || substitutions.length > 0
        ? { ...payload.tables, ...(substitutions.length > 0 ? { sustituciones: substitutions } : {}) }
        : undefined;
    const unassigned = signers.filter((signer) => !signer.personId).map((signer) => signer.etiqueta);
    if (unassigned.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        `El acta nombra a sus firmantes: falta asignar ${unassigned.join(', ')}`,
      );
    }
    const auditor = signers.find((signer) => signer.rol === 'AUDITA' || signer.rol === 'CONTROL_INTERNO');

    return {
      formato: {
        codigo: format.sgcCode ?? '',
        clave: format.key,
        nombre: format.name,
        version: template.sgc_version,
        fechaVigencia: template.effective_date,
      },
      documento: { numero: '', fecha: longDate(now), fechaIso: now.toISOString().slice(0, 10) },
      centroCosto: {
        codigo: costCenter?.external_code ?? '',
        nombre: costCenter?.name ?? '',
        unidad: { codigo: costCenterUnit?.code ?? '', nombre: costCenterUnit?.name ?? '' },
      },
      responsable: {
        nombre: personName(responsible),
        tipoDocumento: documentType(responsible),
        documento: responsible?.document_number ?? '',
        cargo: responsible?.position_title ?? '',
      },
      auditor: auditor
        ? { nombre: auditor.nombre, tipoDocumento: auditor.tipoDocumento, documento: auditor.documento, cargo: auditor.cargo }
        : { nombre: '', tipoDocumento: '', documento: '', cargo: '' },
      firmantes: signers,
      firmante: signersByRole(signers),
      activos: ordered.map((asset, index) => ({
        indice: index + 1,
        id: asset.id,
        idOrigen: asset.legacy_asset_id ?? asset.internal_code,
        codigo: asset.visible_code ?? asset.legacy_code ?? asset.internal_code,
        descripcion: asset.description,
        unidades: 1,
        observacion: payload.assetNotes?.[asset.id] ?? '',
        estado: conditionLabel(asset.physical_condition, asset.data_quality_flags),
        // Solo con assetFields: las actas que no los usan conservan su data tal cual.
        ...(payload.assetFields ? { campos: payload.assetFields[asset.id] ?? {} } : {}),
      })),
      totalElementos: ordered.length,
      campos: payload.fields ?? {},
      // Solo con tables (o sustituciones): las actas que no las usan conservan su data tal cual.
      ...(tables ? { tablas: tables } : {}),
    };
  }

  private async linkAssets(manager: EntityManager, documentId: string, payload: DocumentRequestPayload): Promise<void> {
    const assetIds = [...new Set(payload.assetIds ?? [])];
    const movementIds = payload.movementIds ?? {};
    const foreign = Object.keys(movementIds).filter((assetId) => !assetIds.includes(assetId));
    if (foreign.length > 0) {
      throw new ApiException(ErrorCode.ValidationFailed, `Movimientos de activos que no están en el documento: ${foreign.join(', ')}`);
    }
    if (assetIds.length === 0) {
      return;
    }
    const linked = (await manager.query(
      `INSERT INTO document_asset (document_id, asset_id, movement_id)
       SELECT $1, a.id, m.id
       FROM unnest($2::uuid[]) AS a(id)
       LEFT JOIN asset_movement m ON m.id = ($3::jsonb ->> a.id::text)::uuid AND m.asset_id = a.id
       RETURNING asset_id, movement_id`,
      [documentId, assetIds, JSON.stringify(movementIds)],
    )) as Array<{ asset_id: string; movement_id: string | null }>;
    const unmatched = linked.filter((item) => movementIds[item.asset_id] && !item.movement_id);
    if (unmatched.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        `El movimiento indicado no pertenece al activo: ${unmatched.map((item) => item.asset_id).join(', ')}`,
      );
    }
  }

  private async documentRow(documentId: string) {
    const [row] = (await this.dataSource.query('SELECT * FROM document WHERE id = $1', [documentId])) as Array<{
      id: string;
      format_key: string;
      number: string;
      period: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
      pdf_driver: StorageDriver;
      pdf_key: string;
      pdf_hash: string;
      docx_driver: StorageDriver;
      docx_key: string;
      signature_provider: string | null;
      signature_reference: string | null;
      signed_pdf_driver: StorageDriver | null;
      signed_pdf_key: string | null;
      signed_pdf_hash: string | null;
      lifecycle_error: string | null;
      lifecycle_failed_at: Date | null;
      voided_at: Date | null;
      created_at: Date;
      voided_by: string | null;
      void_reason: string | null;
    }>;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el documento');
    }
    return row;
  }

  private async assertCanRead(documentId: string, permission: string, actorId: string): Promise<void> {
    if (await this.permissions.userHasPermission(actorId, permission)) {
      return;
    }
    const [signer] = (await this.dataSource.query(
      `SELECT 1 AS found FROM document_signature s JOIN app_user u ON u.person_id = s.signer_person_id
       WHERE s.document_id = $1 AND u.id = $2 LIMIT 1`,
      [documentId, actorId],
    )) as Array<{ found: number }>;
    if (!signer) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${permission} o ser firmante del documento`);
    }
  }

  private async assertPermission(actorId: string, permission: string): Promise<void> {
    if (!(await this.permissions.userHasPermission(actorId, permission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${permission}`);
    }
  }
}
