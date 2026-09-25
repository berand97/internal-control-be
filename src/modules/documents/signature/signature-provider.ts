import { Injectable } from '@nestjs/common';

export const SIGNATURE_PROVIDER = 'SignatureProvider';

export type SignatureStatus = 'PENDING' | 'SIGNED' | 'REJECTED';

export interface SignerRequest {
  readonly order: number;
  readonly role: string;
  readonly personId: string | null;
  readonly name: string | null;
  readonly documentNumber: string | null;
  readonly email: string | null;
}

export interface SignatureRequest {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly formatKey: string;
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

export interface SignatureProvider {
  readonly name: string;
  request(input: SignatureRequest): Promise<{ readonly externalReference: string }>;
  status(externalReference: string): Promise<ReadonlyArray<SignerStatus>>;
  signedDocument?(externalReference: string): Promise<Buffer>;
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
