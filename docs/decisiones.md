# Decisiones de diseño — préstamos, entregas y actas

Registro de decisiones tomadas en el código y de las preguntas que siguen abiertas para Control Interno.
Cada decisión dice dónde vive en el código. Las preguntas abiertas no se resolvieron inventando una regla:
se implementó lo mínimo defendible y se dejó visible.

## 5a. El préstamo se otorga a una dependencia, no a una persona (CERRADA)

- El préstamo va del centro de costo de ORIGEN (dueño de los activos) al centro de costo de DESTINO
  (`asset_loan.target_cost_center_id`). Origen ≠ destino (`LOAN_SAME_COST_CENTER`).
- La persona de contacto (`asset_loan.target_responsible_id`, `contactPersonId` en la API) es quien recibe y firma
  RECIBE en el acta. **No pasa a ser responsable del activo.**
- Durante el préstamo el activo conserva su centro de costo y su responsable: la entrega solo cambia el estado
  operativo a `ON_LOAN` (`LoansService.deliver`, `patch: { operationalStatus }`). Probado en
  `test/integration/loans.int-spec.ts` (entrega y firma).
- El acta OCI-01-65 usa el centro de costo de ORIGEN (`costCenterId: loan.sourceCostCenterId`).

## 5b. El préstamo queda ACTIVE solo con las firmas completas (CERRADA, con preguntas menores abiertas)

**Estado intermedio: `PENDING_SIGNATURES` (nuevo).** Se evaluó reutilizar `IN_TRANSIT`, que existía en el enum
y en las transiciones pero ningún endpoint lo producía. Se descartó: "en tránsito" describe activos en camino, y
este estado dura hasta la última firma, cuando los activos ya están (y se usan) en la dependencia de destino; con
ENTREGA y RECIBE firmados solo falta Control Interno. El nombre engañaría a la UI y a Control Interno.
`IN_TRANSIT` queda en el enum como heredado, sin uso.

**Qué pasa con el activo:** el movimiento `LOAN` y el estado `ON_LOAN` se registran **al entregar**, no al
completar las firmas. La entrega física ocurrió: la trazabilidad debe registrar el hecho cuando pasa (fecha del
movimiento = fecha de entrega). Si se esperara a las firmas, el inventario diría que el activo está en el origen
mientras está en el destino, y el acta no podría enlazar su movimiento (`document_asset.movement_id`) porque aún no
existiría. La firma formaliza la entrega; no la produce.

**Activación:** `LoanDeliveryActLifecycle.onSigned` pasa el préstamo de `PENDING_SIGNATURES` a `ACTIVE` en la misma
transacción que deja el acta SIGNED (si falla, el acta no queda firmada y el motor reintenta). El evento
`DELIVERY_ACT_SIGNED` lleva `payload.activated`.

**Vencidos:** un préstamo `PENDING_SIGNATURES` con la fecha estimada vencida **cuenta como vencido** en la alerta
(`GET /loans/overdue`, `overdue=true`, `daysOverdue`): los activos salieron y la obligación de devolverlos no depende
del papeleo. El job diario solo marca `OVERDUE` a los `ACTIVE`: un préstamo sin firmas no cambia de estado por la
fecha (perdería la información de que falta el acta).

**Acta rechazada:** el préstamo sigue `PENDING_SIGNATURES` y hay dos caminos explícitos:
- `POST /loans/:id/delivery-act/regenerate`: nueva acta con nuevo consecutivo, mismos activos, movimientos y fechas,
  firmantes corregidos (puede cambiar la persona de contacto). La rechazada queda como registro REJECTED
  (`deliveryAct.previous`). El enlace movimiento ↔ acta es único y pasa a la nueva. Permiso de generación del
  formato (`loan:update:global`).
- `POST /loans/:id/undo-delivery`: anula el acta pendiente (`voidForEntity`), revierte cada activo a su estado previo
  con movimiento `RETURN` (`metadata.undoDelivery`) y deja el préstamo `CANCELLED`.

**Migración de datos:** préstamos `ACTIVE`/`OVERDUE` con acta OCI-01-65 existente y no firmada pasan a
`PENDING_SIGNATURES`. Los entregados sin ninguna acta (anteriores al motor) se dejan como están.

**Preguntas abiertas (Control Interno):**
1. ¿Quién puede deshacer una entrega y hasta cuándo? Implementado provisionalmente: permiso de generación del acta
   (`loan:update:global`) y solo antes de que el acta quede firmada.
2. ¿Se puede registrar la devolución de un préstamo que aún no tiene todas sus firmas? Hoy no: la devolución exige
   `ACTIVE`/`OVERDUE`; si el préstamo no sigue, se deshace la entrega.

## 5c. Acta de devolución (formato SGC pendiente)

- Clave interna `LOAN_RETURN` en `src/modules/documents/domain/document-formats.ts`, con `sgcCode: null`,
  `version: null`, `signers: []`, consecutivo propio (su propia fila en `document_sequence`) y el contrato de
  marcadores documentado en el mismo archivo. `GET /documents/formats` lo muestra con `sgcCode: null`,
  `ready: false` y `pendingDecisions`.
- El motor se niega a generar, encolar o registrar plantilla de un formato sin código o sin firmantes:
  `409 DOCUMENT_FORMAT_NOT_READY`.
- La devolución no se rompe: `receive-return` registra todo y el préstamo expone `returnActFormat` (formato
  pendiente) y un `returnActs[]` por recepción con `status: PENDING_FORMAT`.
- Cuando el catálogo tenga código y firmantes, `receive-return` encola el acta en su transacción, con cada activo
  enlazado a su movimiento `RETURN` (probado con un formato y una plantilla de prueba en
  `test/integration/loan-return-act.int-spec.ts`).

**Pendiente de la universidad / Control Interno:** código SGC y versión; firmantes y orden; formato del consecutivo
(se dejó AAAA-NNNN provisional); si las devoluciones anteriores a la emisión del formato deben tener acta retroactiva.

## Otras decisiones de esta ronda

- **Lectura de préstamos por alcance:** `loan:read:global` o `loan:read:org_unit`; con el acotado se ven los
  préstamos cuyo centro de ORIGEN **o** de DESTINO está entre los centros del usuario (asignaciones COST_CENTER ∪
  jefaturas). Origen: dueño de los activos y quien aprueba. Destino: la dependencia a la que se prestó y la que debe
  devolver. Filtro en la consulta; fuera de alcance = 404 idéntico a inexistente.
- **Extensiones:** pide el solicitante (`POST /loans/:id/extend`); aprueba o rechaza quien puede aprobar el
  préstamo (`/extension/approve`, `/extension/reject`), nunca el solicitante.
- **Un activo en una solicitud abierta no entra en otra** (incluye `REQUESTED`); la validación corre dentro de la
  transacción con las filas de los activos bloqueadas.
- **Préstamo parcialmente devuelto:** `PARTIALLY_RETURNED` = quedan activos fuera (abierto; admite otra devolución
  de los pendientes, devueltos o declarados `LOST`). Todo resuelto: `RETURNED`, o `CLOSED_WITH_LOSSES` si alguno se
  perdió (nuevo estado final; antes un préstamo con un activo perdido quedaba `PARTIALLY_RETURNED` sin salida).
- **Cancelación de una entrega (OCI-01-55):** `POST /handovers/:id/cancel` con motivo; solo antes de SIGNED; anula el
  acta o la solicitud y libera los activos. **Pregunta abierta:** quién puede cancelar y hasta cuándo; provisional:
  `asset:update:global` (permiso de generación del formato).
