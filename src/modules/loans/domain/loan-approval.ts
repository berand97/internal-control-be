import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  type CostCenterScope,
  type ReadableCostCenterScope,
  requireReadableScope,
} from '../../roles/services/cost-center-scope.js';

export const LOAN_APPROVE_GLOBAL = 'loan:approve:global';
export const LOAN_APPROVE_SCOPED = 'loan:approve:org_unit';

/**
 * Antes de mirar el préstamo: 403 INSUFFICIENT_PERMISSIONS sin ninguno de los dos permisos, 403
 * SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED con el acotado pero sin centros (mismo criterio que la lectura
 * de activos: un rol acotado asignado con alcance GLOBAL no da centros).
 */
export const requireApprovalScope = (scope: CostCenterScope): ReadableCostCenterScope =>
  requireReadableScope(scope, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED);

/**
 * El préstamo se aprueba sobre el centro de costo de ORIGEN (el dueño de los activos). Fuera de alcance responde
 * igual que un préstamo inexistente (404), como el detalle de activos fuera de alcance: quien no puede aprobarlo
 * tampoco puede leerlo (el jefe no tiene loan:read:global), así que no se revela que existe.
 */
export const assertLoanInApprovalScope = (scope: ReadableCostCenterScope, sourceCostCenterId: string): void => {
  if (scope.kind === 'COST_CENTERS' && !scope.costCenterIds.includes(sourceCostCenterId)) {
    throw new ApiException(ErrorCode.ResourceNotFound);
  }
};
