export const HOLD_OPEN_LOAN = (loanStatusesParam: string): string =>
  `CASE WHEN EXISTS (SELECT 1 FROM asset_loan_item li JOIN asset_loan l ON l.id = li.loan_id
         WHERE li.asset_id = a.id AND l.status::text = ANY(${loanStatusesParam}) AND li.received_at IS NULL) THEN 'está en un préstamo abierto' END`;

export const HOLD_OPEN_TRANSFER = `CASE WHEN EXISTS (SELECT 1 FROM asset_transfer_item ti WHERE ti.asset_id = a.id AND ti.open)
       THEN 'está en un traslado abierto' END`;

export const HOLD_OPEN_INVENTORY = `CASE WHEN EXISTS (SELECT 1 FROM physical_inventory_item pi JOIN physical_inventory p ON p.id = pi.inventory_id
         WHERE pi.asset_id = a.id AND p.status IN ('PLANNED', 'IN_PROGRESS')) THEN 'está en una toma física abierta' END`;

export const HOLD_REQUEST_RESERVATION = (exceptRequestParam?: string): string =>
  exceptRequestParam
    ? `CASE WHEN EXISTS (SELECT 1 FROM asset_request_item ri WHERE ri.asset_id = a.id AND ri.open AND ri.request_id IS DISTINCT FROM ${exceptRequestParam}::uuid)
       THEN 'está reservado por otra solicitud' END`
    : `CASE WHEN EXISTS (SELECT 1 FROM asset_request_item ri WHERE ri.asset_id = a.id AND ri.open)
       THEN 'está reservado por una solicitud de activos' END`;

export const HOLD_OPEN_WRITE_OFF = (exceptWriteOffParam?: string): string =>
  exceptWriteOffParam
    ? `CASE WHEN EXISTS (SELECT 1 FROM asset_write_off_item wi WHERE wi.asset_id = a.id AND wi.open AND wi.write_off_id IS DISTINCT FROM ${exceptWriteOffParam}::uuid)
       THEN 'está en otra baja abierta' END`
    : `CASE WHEN EXISTS (SELECT 1 FROM asset_write_off_item wi WHERE wi.asset_id = a.id AND wi.open)
       THEN 'está en una baja abierta' END`;

export const HOLD_OPEN_HANDOVER = `CASE WHEN EXISTS (SELECT 1 FROM asset_handover_item hi WHERE hi.asset_id = a.id AND hi.open)
       THEN 'está en una entrega abierta' END`;

export const holdReasons = (...holds: ReadonlyArray<string>): string => `ARRAY_REMOVE(ARRAY[\n  ${holds.join(',\n  ')}\n]::text[], NULL)`;
