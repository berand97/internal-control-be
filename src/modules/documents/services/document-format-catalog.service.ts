import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { ErrorDetail } from '../../../common/types/response-envelope.type.js';
import {
  type DocumentFormat,
  processBindingViolations,
  type ProcessFormatBinding,
  SGC_VERSION_PATTERN,
  SIGNER_SOURCE_VALUES,
  type SignerSource,
  type SignerSpec,
} from '../domain/document-formats.js';
import { DocumentLifecycleRegistry } from '../lifecycle/document-lifecycle.registry.js';

export const bogotaToday = (instant: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

export const FORMAT_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
export const SIGNER_ROLE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
export const SGC_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const YEAR_PATTERN = /^\d{4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_SIGNERS = 20;

export interface FormatVersionInput {
  readonly sgcCode: string;
  readonly sgcVersion: string;
  readonly name: string;
  readonly effectiveFrom?: string;
  readonly signers: ReadonlyArray<SignerSpec>;
  readonly numbering: {
    readonly width: number;
    readonly perYear: boolean;
    readonly lastIssued: number;
    readonly lastIssuedPeriod?: string | null;
  };
  readonly pendingDecisions?: ReadonlyArray<string>;
  readonly changeReason?: string | null;
}

export interface CreateFormatInput extends FormatVersionInput {
  readonly key: string;
  readonly readPermission: string;
  readonly generatePermission: string;
}

export type FormatVersionStatus = 'CURRENT' | 'SCHEDULED' | 'SUPERSEDED';

export interface FormatVersionHistoryItem extends DocumentFormat {
  readonly status: FormatVersionStatus;
  readonly changeReason: string | null;
  readonly createdBy: {
    readonly userId: string;
    readonly name: string | null;
  } | null;
  readonly createdAt: string;
  readonly documentCount: number;
}

interface VersionRow {
  id: string;
  format_key: string;
  version_number: number;
  effective_from: string | null;
  sgc_code: string | null;
  sgc_version: string | null;
  name: string;
  numbering_width: number;
  numbering_per_year: boolean;
  numbering_last_issued: string;
  numbering_last_issued_period: string | null;
  pending_decisions: string[];
  change_reason: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  read_permission: string;
  generate_permission: string;
  signers: Array<{
    order: number;
    role: string;
    label: string;
    source: SignerSource;
  }>;
}

const VERSION_SELECT = `
  SELECT v.id, v.format_key, v.version_number, to_char(v.effective_from, 'YYYY-MM-DD') AS effective_from,
         v.sgc_code, v.sgc_version, v.name, v.numbering_width, v.numbering_per_year,
         v.numbering_last_issued::text AS numbering_last_issued, v.numbering_last_issued_period, v.pending_decisions,
         v.change_reason, v.created_by, v.created_at,
         (SELECT nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')
            FROM app_user u JOIN person p ON p.id = u.person_id WHERE u.id = v.created_by) AS created_by_name,
         f.read_permission, f.generate_permission,
         coalesce((SELECT jsonb_agg(jsonb_build_object('order', s.sign_order, 'role', s.role, 'label', s.label, 'source', s.source)
                                    ORDER BY s.sign_order)
                   FROM document_format_signer s WHERE s.version_id = v.id), '[]'::jsonb) AS signers
  FROM document_format_version v
  JOIN document_format f ON f.key = v.format_key
`;

const EFFECTIVE_ORDER = `coalesce(v.effective_from, '-infinity'::date) DESC, v.version_number DESC`;

const toFormat = (row: VersionRow): DocumentFormat => ({
  key: row.format_key,
  versionId: row.id,
  versionNumber: row.version_number,
  effectiveFrom: row.effective_from,
  sgcCode: row.sgc_code,
  version: row.sgc_version,
  name: row.name,
  numbering: {
    width: row.numbering_width,
    perYear: row.numbering_per_year,
    lastIssued: Number(row.numbering_last_issued),
    ...(row.numbering_last_issued_period
      ? { lastIssuedPeriod: row.numbering_last_issued_period }
      : {}),
  },
  readPermission: row.read_permission,
  generatePermission: row.generate_permission,
  signers: row.signers.map((signer) => ({
    order: signer.order,
    role: signer.role,
    label: signer.label,
    source: signer.source,
  })),
  pendingDecisions: row.pending_decisions,
});

@Injectable()
export class DocumentFormatCatalogService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly lifecycle: DocumentLifecycleRegistry,
  ) {}

  async current(
    key: string,
    manager: EntityManager = this.dataSource.manager,
    date: string = bogotaToday(),
  ): Promise<DocumentFormat> {
    const format = await this.find(key, manager, date);
    if (!format) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        `El formato ${key} no existe.`,
      );
    }
    return format;
  }

  async find(
    key: string,
    manager: EntityManager = this.dataSource.manager,
    date: string = bogotaToday(),
  ): Promise<DocumentFormat | undefined> {
    const [row] = (await manager.query(
      `${VERSION_SELECT}
       WHERE v.format_key = $1 AND (v.effective_from IS NULL OR v.effective_from <= $2::date)
       ORDER BY ${EFFECTIVE_ORDER} LIMIT 1`,
      [key, date],
    )) as VersionRow[];
    return row ? toFormat(row) : undefined;
  }

  async currentAll(
    manager: EntityManager = this.dataSource.manager,
    date: string = bogotaToday(),
  ): Promise<DocumentFormat[]> {
    const rows = (await manager.query(
      `SELECT DISTINCT ON (v.format_key) * FROM (${VERSION_SELECT}) v
       WHERE v.effective_from IS NULL OR v.effective_from::date <= $1::date
       ORDER BY v.format_key, coalesce(v.effective_from::date, '-infinity'::date) DESC, v.version_number DESC`,
      [date],
    )) as VersionRow[];
    return rows.map(toFormat);
  }

  async byVersionIds(
    ids: ReadonlyArray<string>,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<string, DocumentFormat>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = (await manager.query(
      `${VERSION_SELECT} WHERE v.id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    )) as VersionRow[];
    return new Map(rows.map((row) => [row.id, toFormat(row)]));
  }

  async forDocument(
    documentId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<DocumentFormat> {
    const [row] = (await manager.query(
      `${VERSION_SELECT} WHERE v.id = (SELECT format_version_id FROM document WHERE id = $1)`,
      [documentId],
    )) as VersionRow[];
    if (!row) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        'No encontramos el acta.',
      );
    }
    return toFormat(row);
  }

  async scheduled(
    key: string,
    date: string = bogotaToday(),
  ): Promise<DocumentFormat | undefined> {
    const [row] = (await this.dataSource.query(
      `${VERSION_SELECT} WHERE v.format_key = $1 AND v.effective_from > $2::date
       ORDER BY v.effective_from ASC, v.version_number DESC LIMIT 1`,
      [key, date],
    )) as VersionRow[];
    return row ? toFormat(row) : undefined;
  }

  async history(key: string): Promise<FormatVersionHistoryItem[]> {
    const current = await this.find(key);
    if (!current) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        `El formato ${key} no existe.`,
      );
    }
    const today = bogotaToday();
    const rows = (await this.dataSource.query(
      `SELECT h.*, (SELECT count(*)::int FROM document d WHERE d.format_version_id = h.id) AS document_count
       FROM (${VERSION_SELECT} WHERE v.format_key = $1) h
       ORDER BY h.version_number DESC`,
      [key],
    )) as Array<VersionRow & { document_count: number }>;
    return rows.map((row) => ({
      ...toFormat(row),
      status:
        row.id === current.versionId
          ? 'CURRENT'
          : row.effective_from !== null && row.effective_from > today
            ? 'SCHEDULED'
            : 'SUPERSEDED',
      changeReason: row.change_reason,
      createdBy: row.created_by
        ? { userId: row.created_by, name: row.created_by_name }
        : null,
      createdAt: new Date(row.created_at).toISOString(),
      documentCount: row.document_count,
    }));
  }

  bindingFor(key: string): ProcessFormatBinding | undefined {
    return this.lifecycle.bindingFor(key);
  }

  async createFormat(
    input: CreateFormatInput,
    actorId: string | null,
  ): Promise<DocumentFormat> {
    const key = input.key.trim();
    const today = bogotaToday();
    const errors: ErrorDetail[] = [];
    if (!FORMAT_KEY_PATTERN.test(key)) {
      errors.push({
        field: 'key',
        message:
          'Use de 2 a 40 mayúsculas, números, guiones o guion bajo.',
      });
    }
    const effectiveFrom = input.effectiveFrom ?? today;
    if (DATE_PATTERN.test(effectiveFrom) && effectiveFrom > today) {
      errors.push({
        field: 'effectiveFrom',
        message: 'La primera versión debe regir desde hoy o antes.',
      });
    }
    errors.push(...this.versionErrors(input));
    this.throwIfErrors(errors);
    return this.dataSource.transaction(async (manager) => {
      const [exists] = (await manager.query(
        'SELECT 1 AS found FROM document_format WHERE key = $1 FOR UPDATE',
        [key],
      )) as unknown[];
      if (exists) {
        throw new ApiException(
          ErrorCode.DocumentFormatAlreadyExists,
          `Ya existe el formato ${key}.`,
        );
      }
      await this.assertPermissionsExist(
        manager,
        input.readPermission,
        input.generatePermission,
      );
      this.assertProcess(key, input.signers);
      await this.assertInitialValueApplies(manager, key, null, input.numbering);
      const inserted = (await manager.query(
        `INSERT INTO document_format (key, read_permission, generate_permission, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, input.readPermission, input.generatePermission, actorId],
      )) as unknown[];
      if (inserted.length === 0) {
        throw new ApiException(
          ErrorCode.DocumentFormatAlreadyExists,
          `Ya existe el formato ${key}.`,
        );
      }
      const versionId = await this.insertVersion(
        manager,
        key,
        1,
        { ...input, effectiveFrom },
        actorId,
      );
      const created = await this.byVersionIds([versionId], manager);
      return created.get(versionId) as DocumentFormat;
    });
  }

  async createVersion(
    key: string,
    input: FormatVersionInput,
    actorId: string | null,
  ): Promise<DocumentFormat> {
    const today = bogotaToday();
    const effectiveFrom = input.effectiveFrom ?? today;
    const errors = this.versionErrors(input);
    if (DATE_PATTERN.test(effectiveFrom) && effectiveFrom < today) {
      errors.push({
        field: 'effectiveFrom',
        message: 'La versión nueva debe regir desde hoy o una fecha futura.',
      });
    }
    this.throwIfErrors(errors);
    return this.dataSource.transaction(async (manager) => {
      const [format] = (await manager.query(
        'SELECT key FROM document_format WHERE key = $1 FOR UPDATE',
        [key],
      )) as Array<{
        key: string;
      }>;
      if (!format) {
        throw new ApiException(
          ErrorCode.ResourceNotFound,
          `El formato ${key} no existe.`,
        );
      }
      const [latest] = (await manager.query(
        `SELECT version_number, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
         FROM document_format_version WHERE format_key = $1 ORDER BY version_number DESC LIMIT 1`,
        [key],
      )) as Array<{ version_number: number; effective_from: string | null }>;
      if (latest?.effective_from && effectiveFrom < latest.effective_from) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          'La fecha no puede ser anterior a la de la última versión.',
          [
            {
              field: 'effectiveFrom',
              message: `La versión ${latest.version_number} rige desde ${latest.effective_from}.`,
            },
          ],
        );
      }
      this.assertProcess(key, input.signers);
      const previous = await this.find(key, manager, effectiveFrom);
      await this.assertInitialValueApplies(
        manager,
        key,
        previous ?? null,
        input.numbering,
      );
      const versionId = await this.insertVersion(
        manager,
        key,
        (latest?.version_number ?? 0) + 1,
        { ...input, effectiveFrom },
        actorId,
      );
      const created = await this.byVersionIds([versionId], manager);
      return created.get(versionId) as DocumentFormat;
    });
  }

  private versionErrors(input: FormatVersionInput): ErrorDetail[] {
    const errors: ErrorDetail[] = [];
    const text = (value: unknown): string =>
      typeof value === 'string' ? value.trim() : '';
    if (!SGC_CODE_PATTERN.test(text(input.sgcCode))) {
      errors.push({
        field: 'sgcCode',
        message:
          'Use hasta 20 letras, números, puntos o guiones.',
      });
    }
    if (!SGC_VERSION_PATTERN.test(text(input.sgcVersion))) {
      errors.push({
        field: 'sgcVersion',
        message: 'Use hasta 10 letras, números, puntos o guiones.',
      });
    }
    if (text(input.name).length < 3 || text(input.name).length > 200) {
      errors.push({ field: 'name', message: 'Escriba un nombre de 3 a 200 caracteres.' });
    }
    if (
      input.effectiveFrom !== undefined &&
      (!DATE_PATTERN.test(input.effectiveFrom) ||
        Number.isNaN(Date.parse(input.effectiveFrom)))
    ) {
      errors.push({ field: 'effectiveFrom', message: 'Fecha AAAA-MM-DD' });
    }
    const signers = Array.isArray(input.signers) ? input.signers : [];
    if (signers.length === 0 || signers.length > MAX_SIGNERS) {
      errors.push({
        field: 'signers',
        message: `De 1 a ${MAX_SIGNERS} firmantes`,
      });
    }
    const orders = signers.map((signer) => signer.order);
    const roles = signers.map((signer) => signer.role);
    signers.forEach((signer, index) => {
      if (
        !Number.isInteger(signer.order) ||
        signer.order < 1 ||
        signer.order > 99
      ) {
        errors.push({
          field: `signers[${index}].order`,
          message: 'Escriba un número de 1 a 99.',
        });
      }
      if (
        typeof signer.role !== 'string' ||
        !SIGNER_ROLE_PATTERN.test(signer.role)
      ) {
        errors.push({
          field: `signers[${index}].role`,
          message:
            'Use hasta 40 mayúsculas, números o guion bajo. Debe empezar con letra.',
        });
      }
      if (text(signer.label).length < 1 || text(signer.label).length > 80) {
        errors.push({
          field: `signers[${index}].label`,
          message: 'Escriba una etiqueta de 1 a 80 caracteres.',
        });
      }
      if (!SIGNER_SOURCE_VALUES.includes(signer.source)) {
        errors.push({
          field: `signers[${index}].source`,
          message: 'Elija de dónde sale el firmante.',
        });
      }
    });
    if (new Set(orders).size !== orders.length) {
      errors.push({
        field: 'signers',
        message: 'Dos firmantes no pueden tener el mismo orden.',
      });
    }
    if (new Set(roles).size !== roles.length) {
      errors.push({
        field: 'signers',
        message: 'Dos firmantes no pueden tener el mismo rol.',
      });
    }
    const numbering =
      input.numbering ?? ({} as FormatVersionInput['numbering']);
    if (
      !Number.isInteger(numbering.width) ||
      numbering.width < 1 ||
      numbering.width > 10
    ) {
      errors.push({
        field: 'numbering.width',
        message: 'Escriba un número de dígitos de 1 a 10.',
      });
    }
    if (typeof numbering.perYear !== 'boolean') {
      errors.push({
        field: 'numbering.perYear',
        message: 'Elija si el consecutivo es anual o continuo.',
      });
    }
    if (
      !Number.isSafeInteger(numbering.lastIssued) ||
      numbering.lastIssued < 0
    ) {
      errors.push({
        field: 'numbering.lastIssued',
        message: 'Escriba el último número emitido antes del sistema, 0 o más.',
      });
    }
    const period = numbering.lastIssuedPeriod ?? null;
    if (numbering.perYear === false && period !== null) {
      errors.push({
        field: 'numbering.lastIssuedPeriod',
        message: 'El año solo se indica en un consecutivo anual.',
      });
    }
    if (
      numbering.perYear === true &&
      period !== null &&
      !YEAR_PATTERN.test(period)
    ) {
      errors.push({ field: 'numbering.lastIssuedPeriod', message: 'Escriba el año con 4 dígitos.' });
    }
    if (
      numbering.perYear === true &&
      period === null &&
      numbering.lastIssued > 0
    ) {
      errors.push({
        field: 'numbering.lastIssuedPeriod',
        message:
          'Indique el año del último número emitido.',
      });
    }
    const decisions = input.pendingDecisions ?? [];
    if (
      !Array.isArray(decisions) ||
      decisions.length > 20 ||
      decisions.some(
        (item) => typeof item !== 'string' || !item.trim() || item.length > 500,
      )
    ) {
      errors.push({
        field: 'pendingDecisions',
        message: 'Escriba hasta 20 textos de 1 a 500 caracteres.',
      });
    }
    if (
      input.changeReason !== undefined &&
      input.changeReason !== null &&
      (typeof input.changeReason !== 'string' ||
        input.changeReason.length > 500)
    ) {
      errors.push({ field: 'changeReason', message: 'Hasta 500 caracteres' });
    }
    return errors;
  }

  private throwIfErrors(errors: ReadonlyArray<ErrorDetail>): void {
    if (errors.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'Revise los datos del formato.',
        errors,
      );
    }
  }

  private assertProcess(key: string, signers: ReadonlyArray<SignerSpec>): void {
    const binding = this.lifecycle.bindingFor(key);
    const violations = binding
      ? processBindingViolations(binding, signers)
      : [];
    if (binding && violations.length > 0) {
      throw new ApiException(
        ErrorCode.DocumentFormatBreaksProcess,
        `${binding.process} usa el formato ${key}. ${violations.join(' ')}`,
        violations.map((message) => ({ field: 'signers', message })),
      );
    }
  }

  private async assertPermissionsExist(
    manager: EntityManager,
    ...codes: string[]
  ): Promise<void> {
    const found = (await manager.query(
      'SELECT code FROM permission WHERE code = ANY($1::text[])',
      [codes],
    )) as Array<{ code: string }>;
    const missing = codes.filter(
      (code) => !found.some((row) => row.code === code),
    );
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'Ese permiso no existe.',
        missing.map((code) => ({
          field:
            codes.indexOf(code) === 0 ? 'readPermission' : 'generatePermission',
          message: 'Ese permiso no existe.',
        })),
      );
    }
  }

  private async assertInitialValueApplies(
    manager: EntityManager,
    key: string,
    previous: DocumentFormat | null,
    numbering: FormatVersionInput['numbering'],
  ): Promise<void> {
    const period = numbering.perYear
      ? (numbering.lastIssuedPeriod ?? null)
      : '';
    const changed =
      !previous ||
      previous.numbering.perYear !== numbering.perYear ||
      previous.numbering.lastIssued !== numbering.lastIssued ||
      (previous.numbering.lastIssuedPeriod ?? null) !==
        (numbering.perYear ? (numbering.lastIssuedPeriod ?? null) : null);
    if (!changed || period === null) {
      return;
    }
    const [sequence] = (await manager.query(
      'SELECT current_value::text AS current_value FROM document_sequence WHERE format_key = $1 AND period = $2',
      [key, period],
    )) as Array<{ current_value: string }>;
    if (sequence) {
      throw new ApiException(
        ErrorCode.DocumentFormatSequenceStarted,
        `El consecutivo de ${key}${period ? ` en ${period}` : ''} ya va en ${sequence.current_value}. El valor inicial ya no se puede cambiar.`,
        [
          {
            field: 'numbering.lastIssued',
            message: `El consecutivo va en ${sequence.current_value}.`,
          },
        ],
      );
    }
  }

  private async insertVersion(
    manager: EntityManager,
    key: string,
    versionNumber: number,
    input: FormatVersionInput & { readonly effectiveFrom: string },
    actorId: string | null,
  ): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO document_format_version (format_key, version_number, sgc_code, sgc_version, name, effective_from,
         numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, pending_decisions,
         change_reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        key,
        versionNumber,
        input.sgcCode.trim(),
        input.sgcVersion.trim(),
        input.name.trim(),
        input.effectiveFrom,
        input.numbering.width,
        input.numbering.perYear,
        input.numbering.lastIssued,
        input.numbering.perYear
          ? (input.numbering.lastIssuedPeriod ?? null)
          : null,
        JSON.stringify(
          (input.pendingDecisions ?? []).map((item) => item.trim()),
        ),
        input.changeReason?.trim() || null,
        actorId,
      ],
    )) as Array<{ id: string }>;
    const versionId = row?.id ?? '';
    for (const signer of [...input.signers].sort((a, b) => a.order - b.order)) {
      await manager.query(
        'INSERT INTO document_format_signer (version_id, sign_order, role, label, source) VALUES ($1, $2, $3, $4, $5)',
        [
          versionId,
          signer.order,
          signer.role,
          signer.label.trim(),
          signer.source,
        ],
      );
    }
    return versionId;
  }
}
