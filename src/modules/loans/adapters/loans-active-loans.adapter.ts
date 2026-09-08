import { Injectable } from '@nestjs/common';
import type { ActiveLoansPort } from '../../users/ports/active-loans.port.js';
import { LoansService } from '../services/loans.service.js';

@Injectable()
export class LoansActiveLoansAdapter implements ActiveLoansPort {
  constructor(private readonly loansService: LoansService) {}

  countActiveByResponsibleUserId(userId: string): Promise<number> {
    return this.loansService.countActiveByResponsibleUserId(userId);
  }
}
