/**
 * Procesos abiertos que retienen un activo, como fragmentos SQL sobre `asset a`: cada uno es un CASE que da el motivo
 * en texto llano ('está en un préstamo abierto', …) o NULL. Una sola definición para quien necesita saber si un activo
 * está comprometido (elegir activos en una solicitud, entregar a un responsable); holdReasons los junta en un text[]
 * sin NULL.
 */

/**
 * Préstamo abierto que aún no lo devolvió: estados en el parámetro indicado (OPEN_LOAN_STATUSES: incluye REQUESTED,
 * APPROVED —el préstamo programado de una solicitud— y PENDING_SIGNATURES) y el ítem sin recibir de vuelta.
 */
export const HOLD_OPEN_LOAN = (loanStatusesParam: string): string =>
  `CASE WHEN EXISTS (SELECT 1 FROM asset_loan_item li JOIN asset_loan l ON l.id = li.loan_id
         WHERE li.asset_id = a.id AND l.status::text = ANY(${loanStatusesParam}) AND li.received_at IS NULL) THEN 'está en un préstamo abierto' END`;

/** Traslado abierto (asset_transfer_item.open). */
export const HOLD_OPEN_TRANSFER = `CASE WHEN EXISTS (SELECT 1 FROM asset_transfer_item ti WHERE ti.asset_id = a.id AND ti.open)
       THEN 'está en un traslado abierto' END`;

/** Toma física abierta (PLANNED o IN_PROGRESS). */
export const HOLD_OPEN_INVENTORY = `CASE WHEN EXISTS (SELECT 1 FROM physical_inventory_item pi JOIN physical_inventory p ON p.id = pi.inventory_id
         WHERE pi.asset_id = a.id AND p.status IN ('PLANNED', 'IN_PROGRESS')) THEN 'está en una toma física abierta' END`;

/**
 * Reservado por una solicitud de activos (asset_request_item.open: aceptada o devuelta al solicitante). Con
 * exceptRequestParam, la solicitud indicada no cuenta (la propia, al elegir sus activos).
 */
export const HOLD_REQUEST_RESERVATION = (exceptRequestParam?: string): string =>
  exceptRequestParam
    ? `CASE WHEN EXISTS (SELECT 1 FROM asset_request_item ri WHERE ri.asset_id = a.id AND ri.open AND ri.request_id IS DISTINCT FROM ${exceptRequestParam}::uuid)
       THEN 'está reservado por otra solicitud' END`
    : `CASE WHEN EXISTS (SELECT 1 FROM asset_request_item ri WHERE ri.asset_id = a.id AND ri.open)
       THEN 'está reservado por una solicitud de activos' END`;

/** Los motivos que apliquen, como text[] (vacío si ninguno). */
export const holdReasons = (...holds: ReadonlyArray<string>): string => `ARRAY_REMOVE(ARRAY[\n  ${holds.join(',\n  ')}\n]::text[], NULL)`;
