import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export const SIGNATURE_PROVIDER = 'SignatureProvider';

export type SignatureStatus = 'PENDING' | 'SIGNED' | 'REJECTED';

export interface SignerRequest {
  readonly order: number;
  readonly role: string;
  readonly roleLabel?: string;
  readonly personId: string | null;
  readonly name: string | null;
  readonly documentNumber: string | null;
  readonly email: string | null;
}

export interface SignatureRequest {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly formatKey: string;
  readonly title?: string;
  readonly pdf: Buffer;
  readonly pdfSha256: string;
  readonly signers: ReadonlyArray<SignerRequest>;
}

export interface SignerStatus {
  readonly order: number;
  readonly status: SignatureStatus;
  readonly signedAt?: Date;
  readonly evidence?: Record<string, unknown>;
}

export interface SignatureCapture {
  readonly order: number;
  readonly signerUserId: string;
  readonly signerPersonId: string;
  readonly sessionId: string;
  readonly mfaEnabled: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly rubricPng: Buffer;
}

export interface SignatureRejection {
  readonly order: number;
  readonly signerUserId: string;
  readonly signerPersonId: string;
  readonly sessionId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly reason: string;
}

export type AttestationIntegrity = 'INTACT' | 'ALTERED' | 'UNAVAILABLE';

export interface SignatureAttestation {
  readonly reference: string;
  readonly status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  readonly integrity: AttestationIntegrity;
  readonly documentSha256: string;
  readonly signers: ReadonlyArray<{
    readonly order: number;
    readonly role: string;
    readonly name: string | null;
    readonly status: SignatureStatus;
    readonly signedAt: string | null;
  }>;
  readonly checkedAt: string;
}

export interface SignatureProvider {
  readonly name: string;
  request(input: SignatureRequest): Promise<{ readonly externalReference: string }>;
  status(externalReference: string): Promise<ReadonlyArray<SignerStatus>>;
  signedDocument?(externalReference: string): Promise<Buffer>;
  capture?(externalReference: string, capture: SignatureCapture): Promise<void>;
  reject?(externalReference: string, rejection: SignatureRejection): Promise<void>;
  reissue?(externalReference: string, input: SignatureRequest, manager: EntityManager): Promise<void>;
  attestation?(verificationCode: string): Promise<SignatureAttestation | null>;
  verification?(externalReference: string): Promise<{ readonly code: string; readonly url: string } | null>;
}

@Injectable()
export class StubSignatureProvider implements SignatureProvider {
  readonly name = 'stub';
  private readonly requests = new Map<string, Map<number, SignerStatus>>();

  request(input: SignatureRequest): Promise<{ readonly externalReference: string }> {
    const reference = `stub-${input.documentId}`;
    this.requests.set(
      reference,
      new Map(input.signers.map((signer) => [signer.order, { order: signer.order, status: 'PENDING' }])),
    );
    return Promise.resolve({ externalReference: reference });
  }

  status(externalReference: string): Promise<ReadonlyArray<SignerStatus>> {
    return Promise.resolve([...(this.requests.get(externalReference)?.values() ?? [])]);
  }

  complete(externalReference: string, order: number, evidence: Record<string, unknown> = {}): void {
    const signers = this.requests.get(externalReference);
    if (!signers?.has(order)) {
      throw new Error(`La solicitud ${externalReference} no tiene el firmante ${order}`);
    }
    signers.set(order, { order, status: 'SIGNED', signedAt: new Date(), evidence: { provider: 'stub', ...evidence } });
  }
}
