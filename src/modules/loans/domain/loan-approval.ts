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

/**
 * Lectura: loan:read:global, o loan:read:org_unit sobre los centros de costo del usuario (asignaciones COST_CENTER
 * ∪ jefaturas). Un préstamo está en alcance si su centro de ORIGEN o su centro de DESTINO está entre ellos: el
 * origen es dueño de los activos y aprueba; el destino es la dependencia a la que se prestó y la que debe
 * devolverlos. Fuera de alcance = 404, igual que inexistente.
 */
export const requireReadScope = (scope: CostCenterScope): ReadableCostCenterScope =>
  requireReadableScope(scope, LOAN_READ_GLOBAL, LOAN_READ_SCOPED);

/**
 * Antes de mirar el préstamo: 403 INSUFFICIENT_PERMISSIONS sin ninguno de los dos permisos, 403
 * SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED con el acotado pero sin centros (mismo criterio que la lectura
 * de activos: un rol acotado asignado con alcance GLOBAL no da centros).
 */
export const requireApprovalScope = (scope: CostCenterScope): ReadableCostCenterScope =>
  requireReadableScope(scope, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED);

/**
 * El préstamo se aprueba sobre el centro de costo de ORIGEN (el dueño de los activos). Fuera de alcance responde
 * igual que un préstamo inexistente (404), como el detalle de activos fuera de alcance. El jefe del DESTINO puede
 * leerlo (requireReadScope) pero no aprobarlo: la respuesta de aprobación sigue siendo 404 para no distinguir.
 */
export const assertLoanInApprovalScope = (scope: ReadableCostCenterScope, sourceCostCenterId: string): void => {
  if (scope.kind === 'COST_CENTERS' && !scope.costCenterIds.includes(sourceCostCenterId)) {
    throw new ApiException(ErrorCode.ResourceNotFound);
  }
};
