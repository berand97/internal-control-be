import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig, StorageDriver } from '../../../config/configuration.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import { isPng, prepareForSignature, stampSignature } from './pdf-stamp.js';
import type {
  AttestationIntegrity,
  SignatureAttestation,
  SignatureCapture,
  SignatureProvider,
  SignatureRejection,
  SignatureRequest,
  SignatureStatus,
  SignerStatus,
} from './signature-provider.js';

const MAX_RUBRIC_BYTES = 64 * 1024;

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

interface EnvelopeRow {
  id: string;
  document_id: string;
  verification_code: string;
  original_pdf_sha256: string;
  prepared_pdf_sha256: string;
  current_pdf_driver: StorageDriver;
  current_pdf_key: string;
  current_pdf_sha256: string;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
}

interface SignerRow {
  sign_order: number;
  role: string;
  role_label: string | null;
  person_id: string | null;
  name: string | null;
  document_number: string | null;
  status: SignatureStatus;
  signed_at: Date | null;
  pdf_sha256_before: string | null;
  pdf_sha256_after: string | null;
  ip_address: string | null;
  session_id: string | null;
  mfa_enabled: boolean | null;
}

@Injectable()
export class InternalSignatureProvider implements SignatureProvider {
  readonly name = 'internal';

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  verificationUrl(code: string): string {
    return `${this.config.getOrThrow('documents', { infer: true }).signatureVerifyUrl}/${code}`;
  }

  async request(input: SignatureRequest): Promise<{ readonly externalReference: string }> {
    const originalSha256 = sha256(input.pdf);
    if (originalSha256 !== input.pdfSha256) {
      throw new ApiException(ErrorCode.DocumentTampered, 'El PDF recibido no coincide con el hash del documento');
    }
    const code = randomBytes(24).toString('base64url');
    const signers = [...input.signers].sort((a, b) => a.order - b.order);
    const prepared = await prepareForSignature(input.pdf, {
      title: input.title ?? `${input.formatKey} ${input.documentNumber}`,
      verifyUrl: this.verificationUrl(code),
      verificationCode: code,
      originalSha256,
      slots: signers.map((signer) => ({ order: signer.order, label: signer.roleLabel ?? signer.role })),
    });
    const stored = await this.storage.put({
      key: `signatures/${input.documentId}/${code}/v0.pdf`,
      body: prepared,
      contentType: 'application/pdf',
    });
    return this.dataSource.transaction(async (manager) => {
      const [envelope] = (await manager.query(
        `INSERT INTO signature_envelope (document_id, verification_code, original_pdf_sha256, prepared_pdf_sha256,
           current_pdf_driver, current_pdf_key, current_pdf_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $4) RETURNING id`,
        [input.documentId, code, originalSha256, stored.checksumSha256, stored.driver, stored.key],
      )) as Array<{ id: string }>;
      const envelopeId = envelope?.id ?? '';
      for (const signer of signers) {
        await manager.query(
          `INSERT INTO signature_envelope_signer (envelope_id, sign_order, role, role_label, person_id, name, document_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [envelopeId, signer.order, signer.role, signer.roleLabel ?? null, signer.personId, signer.name, signer.documentNumber],
        );
      }
      return { externalReference: envelopeId };
    });
  }

  async status(externalReference: string): Promise<ReadonlyArray<SignerStatus>> {
    const signers = await this.signers(this.dataSource.manager, externalReference);
    return signers.map((signer) => ({
      order: signer.sign_order,
      status: signer.status,
      ...(signer.signed_at ? { signedAt: signer.signed_at } : {}),
      ...(signer.status === 'SIGNED'
        ? {
            evidence: {
              provider: this.name,
              ipAddress: signer.ip_address,
              sessionId: signer.session_id,
              mfaEnabled: signer.mfa_enabled,
              pdfSha256Before: signer.pdf_sha256_before,
              pdfSha256After: signer.pdf_sha256_after,
            },
          }
        : {}),
    }));
  }

  async signedDocument(externalReference: string): Promise<Buffer> {
    const envelope = await this.envelope(this.dataSource.manager, externalReference);
    if (envelope.status !== 'COMPLETED') {
      throw new ApiException(ErrorCode.InvalidState, 'El documento todavía no tiene todas las firmas');
    }
    return this.currentPdf(envelope);
  }

  async capture(externalReference: string, capture: SignatureCapture): Promise<void> {
    if (!isPng(capture.rubricPng) || capture.rubricPng.length > MAX_RUBRIC_BYTES) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La rúbrica debe ser una imagen PNG de máximo 64 KB');
    }
    await this.dataSource.transaction(async (manager) => {
      const envelope = await this.envelope(manager, externalReference, true);
      const signer = await this.nextSigner(manager, envelope, capture.order, capture.signerPersonId);
      const current = await this.currentPdf(envelope);
      const signedAt = new Date();
      const rubric = await this.storage.put({
        key: `signatures/${envelope.document_id}/${envelope.verification_code}/rubrica-${capture.order}.png`,
        body: capture.rubricPng,
        contentType: 'image/png',
      });
      const signers = await this.signers(manager, envelope.id);
      const stamped = await stampSignature(current, {
        slotIndex: signers.findIndex((item) => item.sign_order === capture.order),
        rubricPng: capture.rubricPng,
        label: signer.role_label ?? signer.role,
        name: signer.name ?? '',
        documentNumber: signer.document_number,
        signedAt,
        ipAddress: capture.ipAddress,
      });
      const stored = await this.storage.put({
        key: `signatures/${envelope.document_id}/${envelope.verification_code}/v${capture.order}.pdf`,
        body: stamped,
        contentType: 'application/pdf',
      });
      await manager.query(
        `UPDATE signature_envelope_signer SET status = 'SIGNED', signed_at = $3, signer_user_id = $4, session_id = $5,
           ip_address = $6, user_agent = $7, mfa_enabled = $8, rubric_driver = $9, rubric_key = $10, rubric_sha256 = $11,
           pdf_sha256_before = $12, pdf_sha256_after = $13
         WHERE envelope_id = $1 AND sign_order = $2`,
        [
          envelope.id,
          capture.order,
          signedAt,
          capture.signerUserId,
          capture.sessionId,
          capture.ipAddress,
          capture.userAgent,
          capture.mfaEnabled,
          rubric.driver,
          rubric.key,
          rubric.checksumSha256,
          envelope.current_pdf_sha256,
          stored.checksumSha256,
        ],
      );
      const pending = signers.filter((item) => item.status !== 'SIGNED' && item.sign_order !== capture.order).length;
      await manager.query(
        `UPDATE signature_envelope SET current_pdf_driver = $2, current_pdf_key = $3, current_pdf_sha256 = $4,
           status = CASE WHEN $5::int = 0 THEN 'COMPLETED' ELSE status END,
           completed_at = CASE WHEN $5::int = 0 THEN NOW() ELSE completed_at END
         WHERE id = $1`,
        [envelope.id, stored.driver, stored.key, stored.checksumSha256, pending],
      );
    });
  }

  async reject(externalReference: string, rejection: SignatureRejection): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const envelope = await this.envelope(manager, externalReference, true);
      await this.nextSigner(manager, envelope, rejection.order, rejection.signerPersonId);
      await manager.query(
        `UPDATE signature_envelope_signer SET status = 'REJECTED', signed_at = NOW(), signer_user_id = $3, session_id = $4,
           ip_address = $5, user_agent = $6, reject_reason = $7, pdf_sha256_before = $8
         WHERE envelope_id = $1 AND sign_order = $2`,
        [
          envelope.id,
          rejection.order,
          rejection.signerUserId,
          rejection.sessionId,
          rejection.ipAddress,
          rejection.userAgent,
          rejection.reason,
          envelope.current_pdf_sha256,
        ],
      );
      await manager.query(`UPDATE signature_envelope SET status = 'REJECTED', completed_at = NOW() WHERE id = $1`, [
        envelope.id,
      ]);
    });
  }

  async attestation(verificationCode: string): Promise<SignatureAttestation | null> {
    const [envelope] = (await this.dataSource.query('SELECT * FROM signature_envelope WHERE verification_code = $1', [
      verificationCode,
    ])) as EnvelopeRow[];
    if (!envelope) {
      return null;
    }
    const signers = await this.signers(this.dataSource.manager, envelope.id);
    return {
      reference: envelope.verification_code,
      status: envelope.status,
      integrity: await this.integrity(envelope, signers),
      documentSha256: envelope.current_pdf_sha256,
      signers: signers.map((signer) => ({
        order: signer.sign_order,
        role: signer.role_label ?? signer.role,
        name: signer.status === 'PENDING' ? null : signer.name,
        status: signer.status,
        signedAt: signer.signed_at ? new Date(signer.signed_at).toISOString() : null,
      })),
      checkedAt: new Date().toISOString(),
    };
  }

  private async integrity(envelope: EnvelopeRow, signers: ReadonlyArray<SignerRow>): Promise<AttestationIntegrity> {
    let expected = envelope.prepared_pdf_sha256;
    for (const signer of signers.filter((item) => item.status === 'SIGNED')) {
      if (signer.pdf_sha256_before !== expected || !signer.pdf_sha256_after) {
        return 'ALTERED';
      }
      expected = signer.pdf_sha256_after;
    }
    if (expected !== envelope.current_pdf_sha256) {
      return 'ALTERED';
    }
    try {
      const content = await this.storage.getFrom(envelope.current_pdf_driver, envelope.current_pdf_key);
      return sha256(content) === envelope.current_pdf_sha256 ? 'INTACT' : 'ALTERED';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  private async currentPdf(envelope: EnvelopeRow): Promise<Buffer> {
    const content = await this.storage.getFrom(envelope.current_pdf_driver, envelope.current_pdf_key);
    if (sha256(content) !== envelope.current_pdf_sha256) {
      throw new ApiException(ErrorCode.DocumentTampered);
    }
    return content;
  }

  private async envelope(manager: EntityManager, id: string, lock = false): Promise<EnvelopeRow> {
    const [envelope] = (await manager.query(
      `SELECT * FROM signature_envelope WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )) as EnvelopeRow[];
    if (!envelope) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud de firma');
    }
    return envelope;
  }

  private signers(manager: EntityManager, envelopeId: string): Promise<SignerRow[]> {
    return manager.query(
      `SELECT sign_order, role, role_label, person_id, name, document_number, status, signed_at,
         pdf_sha256_before, pdf_sha256_after, host(ip_address) AS ip_address, session_id, mfa_enabled
       FROM signature_envelope_signer WHERE envelope_id = $1 ORDER BY sign_order`,
      [envelopeId],
    ) as Promise<SignerRow[]>;
  }

  private async nextSigner(
    manager: EntityManager,
    envelope: EnvelopeRow,
    order: number,
    personId: string,
  ): Promise<SignerRow> {
    if (envelope.status !== 'PENDING') {
      throw new ApiException(ErrorCode.InvalidState, 'La solicitud de firma ya está cerrada');
    }
    const signers = await this.signers(manager, envelope.id);
    const signer = signers.find((item) => item.sign_order === order);
    if (!signer || signer.status !== 'PENDING') {
      throw new ApiException(ErrorCode.InvalidState, `El firmante ${order} no está pendiente`);
    }
    if (!signer.person_id || signer.person_id !== personId) {
      throw new ApiException(ErrorCode.SignatureNotAllowed, 'Solo la persona designada puede firmar este turno');
    }
    const next = signers.find((item) => item.status === 'PENDING');
    if (next?.sign_order !== order) {
      throw new ApiException(ErrorCode.SignatureOutOfOrder, `Primero debe firmar el turno ${next?.sign_order}`);
    }
    return signer;
  }
}
