import { Injectable } from '@nestjs/common';
import type { ActiveLoansPort } from './active-loans.port.js';

@Injectable()
export class ZeroActiveLoansAdapter implements ActiveLoansPort {
  countActiveByResponsibleUserId(_userId: string): Promise<number> {
    return Promise.resolve(0);
  }
}
