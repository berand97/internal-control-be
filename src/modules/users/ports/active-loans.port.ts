export const ACTIVE_LOANS_PORT = 'ActiveLoansPort';

export interface ActiveLoansPort {
  countActiveByResponsibleUserId(userId: string): Promise<number>;
}
