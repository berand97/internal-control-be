import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  type CostCenterScope,
  type ReadableCostCenterScope,
  requireReadableScope,
} from '../../roles/services/cost-center-scope.js';

export const LOAN_APPROVE_GLOBAL = 'loan:approve:global';
export const LOAN_APPROVE_SCOPED = 'loan:approve:org_unit';
export const LOAN_READ_GLOBAL = 'loan:read:global';
export const LOAN_READ_SCOPED = 'loan:read:org_unit';

export const requireReadScope = (scope: CostCenterScope): ReadableCostCenterScope =>
  requireReadableScope(scope);

export const requireApprovalScope = (scope: CostCenterScope): ReadableCostCenterScope =>
  requireReadableScope(scope);

export const assertLoanInApprovalScope = (scope: ReadableCostCenterScope, sourceCostCenterId: string): void => {
  if (scope.kind === 'COST_CENTERS' && !scope.costCenterIds.includes(sourceCostCenterId)) {
    throw new ApiException(ErrorCode.ResourceNotFound);
  }
};
