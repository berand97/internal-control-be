import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1767225600000 implements MigrationInterface {
  name = 'InitialSchema1767225600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
-- =============================================================================
-- SISTEMA DE GESTIÓN Y CONTROL DE ACTIVOS - UNIVERSIDAD
-- Departamento de Control Interno
-- Motor: PostgreSQL 15+
-- =============================================================================
-- Diseñado desde la perspectiva del Director/a de Control Interno:
--   1. Trazabilidad completa (todo cambio queda registrado con firma)
--   2. Separación entre "dónde está" (físico) y "a quién pertenece" (organizacional)
--   3. Escalabilidad por campos custom sin migraciones
--   4. Autocontención: no depende de sistema externo para arrancar
--   5. Preparado para conciliación contable (depreciación, actas, bajas)
-- =============================================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";        -- texto case-insensitive (emails)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- búsqueda difusa en descripciones

-- =============================================================================
-- SECCIÓN 1: ENUMS Y TIPOS BASE
-- =============================================================================
-- Se usan enums para valores cerrados de dominio. Si un valor debiera ser
-- editable por el usuario, va a tabla de catálogo (ver sección 3).

CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

CREATE TYPE asset_operational_status AS ENUM (
    'IN_USE',           -- Asignado y en uso normal
    'IN_STORAGE',       -- En bodega, disponible
    'ON_LOAN',          -- Prestado temporalmente a otra dependencia
    'IN_MAINTENANCE',   -- En reparación/mantenimiento
    'LOST',             -- Reportado como perdido/robado
    'WRITTEN_OFF'       -- Dado de baja formalmente
);

CREATE TYPE asset_physical_condition AS ENUM (
    'NEW', 'GOOD', 'FAIR', 'POOR', 'OBSOLETE'
);

CREATE TYPE movement_type AS ENUM (
    'REGISTRATION',       -- Alta inicial del activo
    'ASSIGNMENT',         -- Asignación a responsable
    'LOAN',               -- Préstamo entre dependencias
    'RETURN',             -- Devolución de préstamo
    'TRANSFER',           -- Reubicación definitiva a otra dependencia
    'RELOCATION',         -- Cambio de ubicación física (mismo owner)
    'MAINTENANCE_IN',     -- Entrada a mantenimiento
    'MAINTENANCE_OUT',    -- Salida de mantenimiento
    'PHYSICAL_VERIFICATION', -- Verificación en toma física
    'CONDITION_CHANGE',   -- Cambio de estado físico
    'WRITE_OFF',          -- Baja definitiva
    'REACTIVATION'        -- Reactivación (revocatoria de baja)
);

CREATE TYPE loan_status AS ENUM (
    'REQUESTED', 'APPROVED', 'REJECTED', 'ACTIVE', 'RETURNED', 'OVERDUE', 'CANCELLED'
);

CREATE TYPE depreciation_method AS ENUM (
    'STRAIGHT_LINE',      -- Línea recta (más común en Colombia)
    'DECLINING_BALANCE',  -- Saldo decreciente
    'UNITS_OF_PRODUCTION',
    'NONE'                -- Activos no depreciables (terrenos, obras de arte)
);

-- =============================================================================
-- SECCIÓN 2: ESTRUCTURA ORGANIZACIONAL
-- =============================================================================
-- La universidad tiene: Campus → Edificios → Pisos → Salones (físico)
-- Y también: Rectoría → Vicerrectoría → Facultad → Departamento (organizacional)
-- Un activo tiene AMBAS. Separarlas es lo que permite préstamos y traslados
-- físicos sin cambiar el responsable contable.

-- ─── Estructura física (sedes/edificios/salones) ────────────────────────────
CREATE TABLE campus (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    address         TEXT,
    city            VARCHAR(100),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE building (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campus_id       UUID NOT NULL REFERENCES campus(id),
    code            VARCHAR(20) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    floors_count    SMALLINT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (campus_id, code)
);

CREATE TABLE location (
    -- Salones, oficinas, laboratorios, bodegas.
    -- Nombre genérico "location" para no encasillarse a "salón".
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    building_id     UUID NOT NULL REFERENCES building(id),
    code            VARCHAR(30) NOT NULL,            -- ej: 302, A-102
    name            VARCHAR(200) NOT NULL,           -- ej: "Aula 302", "Bodega Central"
    floor_number    SMALLINT,
    location_type   VARCHAR(30) NOT NULL,            -- CLASSROOM, OFFICE, LAB, WAREHOUSE, HALL
    capacity        INTEGER,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (building_id, code)
);

CREATE INDEX idx_location_building ON location(building_id) WHERE is_active;
CREATE INDEX idx_location_type ON location(location_type);

-- ─── Estructura organizacional (jerárquica) ─────────────────────────────────
CREATE TABLE organizational_unit (
    -- Modela: Rectoría, Vicerrectorías, Facultades, Departamentos, Programas.
    -- Auto-referencia (parent_id) para armar el árbol.
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       UUID REFERENCES organizational_unit(id),
    code            VARCHAR(20) NOT NULL UNIQUE,     -- código interno
    name            VARCHAR(200) NOT NULL,
    unit_type       VARCHAR(30) NOT NULL,            -- RECTORATE, VICERECTORATE, FACULTY, DEPARTMENT, PROGRAM, AREA
    hierarchy_level SMALLINT NOT NULL DEFAULT 0,     -- 0=raíz, se calcula al insertar
    hierarchy_path  TEXT,                             -- ej: /rec/vac/fing/depsis -- para queries de descendientes
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_unit_parent ON organizational_unit(parent_id);
CREATE INDEX idx_org_unit_path ON organizational_unit USING GIN (hierarchy_path gin_trgm_ops);

-- ─── Centros de costo (espejo del sistema contable) ─────────────────────────
-- CLAVE: Aquí es donde se conecta la contabilidad. external_code es el ID
-- que usa el sistema fuente (SIIGO, SAP, World Office, etc). Cuando llegue
-- la integración real, se sincroniza contra esa clave.
CREATE TABLE cost_center (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_code       VARCHAR(30) NOT NULL UNIQUE,   -- ej: "4330" del Excel actual
    name                VARCHAR(200) NOT NULL,
    organizational_unit_id UUID REFERENCES organizational_unit(id),
    parent_id           UUID REFERENCES cost_center(id),
    accepts_assets      BOOLEAN NOT NULL DEFAULT TRUE, -- centros de agrupación no aceptan activos directamente
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Metadatos de sincronización (para cuando exista integración)
    sync_source         VARCHAR(30) NOT NULL DEFAULT 'MANUAL', -- MANUAL, IMPORT_EXCEL, API_ERP
    last_synced_at      TIMESTAMPTZ,
    external_metadata   JSONB,                          -- guardar campos extra del sistema fuente sin migración
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cost_center_org_unit ON cost_center(organizational_unit_id);
CREATE INDEX idx_cost_center_parent ON cost_center(parent_id);
CREATE INDEX idx_cost_center_active ON cost_center(is_active) WHERE is_active;

-- =============================================================================
-- SECCIÓN 3: PERSONAS, ROLES Y PERMISOS
-- =============================================================================

CREATE TABLE person (
    -- Persona natural: empleado, docente, funcionario. Se separa de "user"
    -- porque puede existir una persona responsable de activos que no tenga
    -- acceso al sistema (ej: docente que sólo recibe activos asignados).
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type   VARCHAR(10) NOT NULL,           -- CC, CE, TI, PAS
    document_number VARCHAR(30) NOT NULL,
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    email           CITEXT,
    phone           VARCHAR(30),
    position_title  VARCHAR(150),                    -- cargo institucional
    organizational_unit_id UUID REFERENCES organizational_unit(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_type, document_number)
);

CREATE INDEX idx_person_org_unit ON person(organizational_unit_id);
CREATE INDEX idx_person_name ON person USING GIN ((first_name || ' ' || last_name) gin_trgm_ops);

CREATE TABLE app_user (
    -- Usuario del sistema. Toda persona con login es también person.
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id       UUID NOT NULL UNIQUE REFERENCES person(id),
    username        CITEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,                   -- bcrypt/argon2
    status          user_status NOT NULL DEFAULT 'ACTIVE',
    last_login_at   TIMESTAMPTZ,
    mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================================================
-- SECCIÓN 4: CATÁLOGOS DE ACTIVOS
-- =============================================================================

CREATE TABLE asset_category (
    -- Categorías jerárquicas: "Muebles y enseres > Sillas > Sillas ergonómicas"
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       UUID REFERENCES asset_category(id),
    code            VARCHAR(30) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    -- Valores por defecto que hereda cada activo de esta categoría:
    default_useful_life_years   SMALLINT,             -- para depreciación
    default_depreciation_method depreciation_method DEFAULT 'STRAIGHT_LINE',
    requires_serial_number      BOOLEAN NOT NULL DEFAULT FALSE,
    requires_photo              BOOLEAN NOT NULL DEFAULT TRUE,
    hierarchy_path              TEXT,
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asset_category_parent ON asset_category(parent_id);

-- CLAVE DE ESCALABILIDAD: campos dinámicos por categoría.
-- El admin puede crear una categoría "Equipos de laboratorio" y definir
-- sus propios campos sin tocar código.
CREATE TABLE asset_category_field (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id     UUID NOT NULL REFERENCES asset_category(id) ON DELETE CASCADE,
    field_code      VARCHAR(50) NOT NULL,            -- "voltage", "capacity_liters"
    field_label     VARCHAR(150) NOT NULL,           -- "Voltaje", "Capacidad (L)"
    field_type      VARCHAR(20) NOT NULL,            -- TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
    is_required     BOOLEAN NOT NULL DEFAULT FALSE,
    options         JSONB,                            -- para SELECT: ["110V","220V"]
    validation_rules JSONB,                           -- {"min":0,"max":1000}
    display_order   SMALLINT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (category_id, field_code)
);

CREATE TABLE manufacturer (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(150) NOT NULL UNIQUE,
    country     VARCHAR(80),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE supplier (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_id          VARCHAR(30) NOT NULL UNIQUE,     -- NIT en Colombia
    name            VARCHAR(200) NOT NULL,
    contact_email   CITEXT,
    contact_phone   VARCHAR(30),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE acquisition_type (
    -- Tipo de origen del activo. Se hace catálogo (no enum) porque control
    -- interno puede requerir crear nuevos tipos según normativa institucional.
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(30) NOT NULL UNIQUE,         -- PURCHASE, DONATION, LEASING, EXCHANGE, GRANT
    name        VARCHAR(100) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- SECCIÓN 5: ACTIVOS (núcleo del sistema)
-- =============================================================================

CREATE TABLE asset (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Identificación
    internal_code           VARCHAR(30) NOT NULL UNIQUE,     -- ej: A0045 del Excel
    barcode                 VARCHAR(50) UNIQUE,               -- código de barras físico
    serial_number           VARCHAR(100),                     -- serie del fabricante
    description             VARCHAR(500) NOT NULL,
    model                   VARCHAR(150),

    -- Clasificación
    category_id             UUID NOT NULL REFERENCES asset_category(id),
    manufacturer_id         UUID REFERENCES manufacturer(id),

    -- Origen
    acquisition_type_id     UUID NOT NULL REFERENCES acquisition_type(id),
    acquisition_date        DATE NOT NULL,
    acquisition_document    VARCHAR(100),                     -- "ACTA N° 1065", factura
    supplier_id             UUID REFERENCES supplier(id),
    acquisition_price       NUMERIC(15,2) NOT NULL DEFAULT 0,
    currency                CHAR(3) NOT NULL DEFAULT 'COP',

    -- Estado ACTUAL (desnormalizado para queries rápidas; histórico va en asset_movement)
    operational_status      asset_operational_status NOT NULL DEFAULT 'IN_USE',
    physical_condition      asset_physical_condition NOT NULL DEFAULT 'NEW',
    current_cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
    current_location_id     UUID REFERENCES location(id),
    current_responsible_id  UUID REFERENCES person(id),       -- custodio actual

    -- Baja (write-off)
    written_off_at          DATE,
    write_off_reason        TEXT,
    write_off_document      VARCHAR(100),                     -- acta de baja
    write_off_approved_by   UUID REFERENCES app_user(id),

    -- Verificación en toma física (última)
    last_verified_at        TIMESTAMPTZ,
    last_verified_by        UUID REFERENCES app_user(id),

    -- QR tokenizado (versionado para invalidación)
    qr_token                TEXT UNIQUE,                      -- JWT firmado
    qr_token_version        SMALLINT NOT NULL DEFAULT 1,
    qr_signed_at            TIMESTAMPTZ,
    qr_signed_by            UUID REFERENCES app_user(id),

    -- Depreciación
    depreciation_method     depreciation_method NOT NULL DEFAULT 'STRAIGHT_LINE',
    useful_life_years       SMALLINT,                         -- se hereda de la categoría al alta
    salvage_value           NUMERIC(15,2) NOT NULL DEFAULT 0,

    -- Otros
    notes                   TEXT,
    warranty_expires_at     DATE,
    insurance_policy_number VARCHAR(80),

    -- Metadata
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              UUID NOT NULL REFERENCES app_user(id),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES app_user(id),

    CONSTRAINT chk_write_off_consistency
        CHECK ((operational_status = 'WRITTEN_OFF' AND written_off_at IS NOT NULL)
               OR (operational_status <> 'WRITTEN_OFF' AND written_off_at IS NULL))
);

CREATE INDEX idx_asset_barcode ON asset(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_asset_serial ON asset(serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX idx_asset_cost_center ON asset(current_cost_center_id);
CREATE INDEX idx_asset_location ON asset(current_location_id);
CREATE INDEX idx_asset_responsible ON asset(current_responsible_id);
CREATE INDEX idx_asset_status ON asset(operational_status);
CREATE INDEX idx_asset_category ON asset(category_id);
CREATE INDEX idx_asset_description_trgm ON asset USING GIN (description gin_trgm_ops);
CREATE INDEX idx_asset_active_status ON asset(operational_status, current_cost_center_id)
    WHERE operational_status <> 'WRITTEN_OFF';

-- Valores de campos dinámicos definidos en asset_category_field
CREATE TABLE asset_custom_value (
    asset_id        UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    field_id        UUID NOT NULL REFERENCES asset_category_field(id) ON DELETE CASCADE,
    value_text      TEXT,        -- se usa según field_type
    value_number    NUMERIC,
    value_date      DATE,
    value_boolean   BOOLEAN,
    value_json      JSONB,       -- multi-select y estructuras complejas
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset_id, field_id)
);

CREATE INDEX idx_custom_value_field ON asset_custom_value(field_id);

-- Fotografías y documentos anexos del activo
CREATE TABLE asset_photo (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    file_url        TEXT NOT NULL,                    -- ruta en storage (S3/MinIO)
    file_hash       VARCHAR(64),                       -- SHA-256 para integridad
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    caption         VARCHAR(200),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by     UUID NOT NULL REFERENCES app_user(id)
);

CREATE INDEX idx_asset_photo_asset ON asset_photo(asset_id);
-- Sólo una foto principal por activo
CREATE UNIQUE INDEX idx_asset_photo_primary ON asset_photo(asset_id) WHERE is_primary;

CREATE TABLE asset_document (
    -- Facturas, actas, certificados, pólizas
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    document_type   VARCHAR(30) NOT NULL,             -- INVOICE, ACT, WARRANTY, INSURANCE, WRITE_OFF_ACT
    reference       VARCHAR(100),                      -- número de documento
    file_url        TEXT NOT NULL,
    file_hash       VARCHAR(64),
    document_date   DATE,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by     UUID NOT NULL REFERENCES app_user(id)
);

CREATE INDEX idx_asset_document_asset ON asset_document(asset_id);

-- =============================================================================
-- SECCIÓN 6: MOVIMIENTOS E HISTÓRICO
-- =============================================================================
-- Tabla append-only: nunca se actualiza, sólo se inserta. Es la fuente de
-- verdad para auditoría de trazabilidad. Los campos "current_*" en asset son
-- redundancia optimizada, pero esta tabla es la que responde ante la Contraloría.

CREATE TABLE asset_movement (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id                    UUID NOT NULL REFERENCES asset(id),
    movement_type               movement_type NOT NULL,

    -- Estado ANTES del movimiento (snapshot)
    from_cost_center_id         UUID REFERENCES cost_center(id),
    from_location_id            UUID REFERENCES location(id),
    from_responsible_id         UUID REFERENCES person(id),
    from_operational_status     asset_operational_status,
    from_physical_condition     asset_physical_condition,

    -- Estado DESPUÉS del movimiento
    to_cost_center_id           UUID REFERENCES cost_center(id),
    to_location_id              UUID REFERENCES location(id),
    to_responsible_id           UUID REFERENCES person(id),
    to_operational_status       asset_operational_status,
    to_physical_condition       asset_physical_condition,

    -- Autoría y autorización
    requested_by                UUID REFERENCES app_user(id),
    authorized_by               UUID REFERENCES app_user(id),     -- quién firma
    executed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Contexto
    reason                      TEXT,
    document_reference          VARCHAR(100),                     -- número de acta/oficio
    attachment_url              TEXT,
    loan_id                     UUID,                              -- FK a asset_loan (definido abajo)

    -- Firma del evento (para no repudio)
    -- Hash del evento firmado con clave del sistema, para probar integridad
    event_signature             TEXT,

    -- Metadata técnica
    ip_address                  INET,
    user_agent                  TEXT,
    geo_latitude                NUMERIC(9,6),
    geo_longitude               NUMERIC(9,6),

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movement_asset ON asset_movement(asset_id, executed_at DESC);
CREATE INDEX idx_movement_type ON asset_movement(movement_type);
CREATE INDEX idx_movement_executed ON asset_movement(executed_at DESC);
CREATE INDEX idx_movement_authorized_by ON asset_movement(authorized_by);
CREATE INDEX idx_movement_from_cc ON asset_movement(from_cost_center_id);
CREATE INDEX idx_movement_to_cc ON asset_movement(to_cost_center_id);

-- ─── Préstamos entre dependencias ───────────────────────────────────────────
-- Un préstamo tiene ciclo de vida (solicitado → aprobado → activo → devuelto).
-- Cada transición genera un asset_movement, pero el "objeto préstamo" vive aquí.
CREATE TABLE asset_loan (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id                UUID NOT NULL REFERENCES asset(id),

    -- Origen y destino
    source_cost_center_id   UUID NOT NULL REFERENCES cost_center(id),
    target_cost_center_id   UUID NOT NULL REFERENCES cost_center(id),
    target_location_id      UUID REFERENCES location(id),
    target_responsible_id   UUID NOT NULL REFERENCES person(id),

    -- Fechas
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_return_date    DATE NOT NULL,
    approved_at             TIMESTAMPTZ,
    delivered_at            TIMESTAMPTZ,
    actual_return_date      TIMESTAMPTZ,

    -- Actores
    requested_by            UUID NOT NULL REFERENCES app_user(id),
    approved_by             UUID REFERENCES app_user(id),
    delivered_by            UUID REFERENCES app_user(id),
    received_back_by        UUID REFERENCES app_user(id),

    -- Estado
    status                  loan_status NOT NULL DEFAULT 'REQUESTED',
    purpose                 TEXT NOT NULL,
    conditions              TEXT,
    return_notes            TEXT,

    -- Estado del activo al devolver (para compararlo con el estado al entregar)
    condition_on_delivery   asset_physical_condition,
    condition_on_return     asset_physical_condition,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_return_after_delivery
        CHECK (actual_return_date IS NULL OR delivered_at IS NULL OR actual_return_date >= delivered_at)
);

CREATE INDEX idx_loan_asset ON asset_loan(asset_id);
CREATE INDEX idx_loan_status ON asset_loan(status);
CREATE INDEX idx_loan_target_cc ON asset_loan(target_cost_center_id);
CREATE INDEX idx_loan_expected_return ON asset_loan(expected_return_date) WHERE status IN ('ACTIVE', 'OVERDUE');

-- =============================================================================
-- SECCIÓN 7: TOMAS FÍSICAS E INVENTARIOS
-- =============================================================================
-- Control interno programa tomas físicas periódicas (anual, semestral).
-- Cada toma tiene un alcance (uno o varios centros de costos) y produce
-- un reporte con activos encontrados, faltantes, sobrantes.

CREATE TABLE physical_inventory (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                    VARCHAR(30) NOT NULL UNIQUE,     -- ej: TF-2026-001
    name                    VARCHAR(200) NOT NULL,
    scheduled_start_date    DATE NOT NULL,
    scheduled_end_date      DATE NOT NULL,
    actual_start_date       DATE,
    actual_end_date         DATE,
    status                  VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
        -- PLANNED, IN_PROGRESS, COMPLETED, CANCELLED
    responsible_user_id     UUID NOT NULL REFERENCES app_user(id),
    scope_notes             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              UUID NOT NULL REFERENCES app_user(id)
);

-- Alcance: qué centros de costo entran en esta toma
CREATE TABLE physical_inventory_scope (
    inventory_id    UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
    cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
    PRIMARY KEY (inventory_id, cost_center_id)
);

-- Detalle: cada activo escaneado en la toma
CREATE TABLE physical_inventory_item (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id        UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
    asset_id            UUID REFERENCES asset(id),       -- null = sobrante (activo no registrado)
    verification_result VARCHAR(20) NOT NULL,             -- FOUND, MISSING, SURPLUS, MISPLACED
    expected_location_id UUID REFERENCES location(id),
    actual_location_id  UUID REFERENCES location(id),
    expected_condition  asset_physical_condition,
    actual_condition    asset_physical_condition,
    verified_at         TIMESTAMPTZ,
    verified_by         UUID REFERENCES app_user(id),
    notes               TEXT,
    photo_url           TEXT
);

CREATE INDEX idx_inv_item_inventory ON physical_inventory_item(inventory_id);
CREATE INDEX idx_inv_item_asset ON physical_inventory_item(asset_id);
CREATE INDEX idx_inv_item_result ON physical_inventory_item(verification_result);

-- =============================================================================
-- SECCIÓN 8: DEPRECIACIÓN (snapshots contables)
-- =============================================================================
-- Nunca se recalcula sobre la fila del activo; se genera un snapshot mensual/anual
-- que queda inmutable. Así la contabilidad histórica siempre puede reconstruirse.

CREATE TABLE asset_depreciation (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id                    UUID NOT NULL REFERENCES asset(id),
    period_year                 SMALLINT NOT NULL,
    period_month                SMALLINT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    method                      depreciation_method NOT NULL,
    monthly_depreciation        NUMERIC(15,2) NOT NULL,
    accumulated_depreciation    NUMERIC(15,2) NOT NULL,
    book_value                  NUMERIC(15,2) NOT NULL,   -- valor en libros al cierre
    is_closed                   BOOLEAN NOT NULL DEFAULT FALSE,  -- período cerrado contablemente
    calculated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    calculated_by               UUID REFERENCES app_user(id),
    UNIQUE (asset_id, period_year, period_month)
);

CREATE INDEX idx_depreciation_period ON asset_depreciation(period_year, period_month);
CREATE INDEX idx_depreciation_asset ON asset_depreciation(asset_id, period_year DESC, period_month DESC);

-- =============================================================================
-- SECCIÓN 9: AUDITORÍA Y NOTIFICACIONES
-- =============================================================================
-- Todo cambio sensible se registra aquí. Es lo primero que pide una auditoría externa.

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     VARCHAR(50) NOT NULL,             -- ASSET, LOAN, USER, COST_CENTER, ...
    entity_id       UUID NOT NULL,
    action          VARCHAR(20) NOT NULL,             -- CREATE, UPDATE, DELETE, LOGIN, SIGN, EXPORT
    changes         JSONB,                             -- {"field": {"old":..., "new":...}}
    performed_by    UUID REFERENCES app_user(id),
    performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address      INET,
    user_agent      TEXT
);

-- Particionable por mes si crece mucho; por ahora índices simples.
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, performed_at DESC);
CREATE INDEX idx_audit_user ON audit_log(performed_by, performed_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, performed_at DESC);

CREATE TABLE notification (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES app_user(id),
    notification_type VARCHAR(50) NOT NULL,           -- LOAN_REQUEST, LOAN_APPROVAL, LOAN_OVERDUE, INVENTORY_ASSIGNED
    title           VARCHAR(200) NOT NULL,
    body            TEXT,
    entity_type     VARCHAR(50),
    entity_id       UUID,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_recipient_unread ON notification(recipient_user_id, created_at DESC)
    WHERE read_at IS NULL;

-- =============================================================================
-- SECCIÓN 10: CONFIGURACIÓN DEL SISTEMA
-- =============================================================================

CREATE TABLE system_setting (
    key             VARCHAR(100) PRIMARY KEY,
    value           JSONB NOT NULL,
    description     TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID REFERENCES app_user(id)
);

CREATE TABLE code_sequence (
    -- Generación de códigos secuenciales (A0001, A0002, TF-2026-001, etc.)
    sequence_name   VARCHAR(50) PRIMARY KEY,
    prefix          VARCHAR(20),
    current_value   BIGINT NOT NULL DEFAULT 0,
    padding_length  SMALLINT NOT NULL DEFAULT 4,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- SECCIÓN 11: VISTAS ÚTILES
-- =============================================================================

-- Vista que replica el formato Excel actual (para reporte a control interno)
CREATE OR REPLACE VIEW v_asset_report AS
SELECT
    a.id                                            AS mov_id_activo,
    a.barcode                                       AS mov_cod_barras,
    a.description                                   AS mov_descripcion,
    a.model                                         AS mov_modelo,
    a.acquisition_document                          AS mov_num_documento,
    a.serial_number                                 AS mov_num_serie,
    (SELECT file_url FROM asset_photo p
        WHERE p.asset_id = a.id AND p.is_primary LIMIT 1) AS fotografia_activo,
    cc.external_code                                AS mov_id_centro,
    cc.name                                         AS nombre_centro,
    cc.external_code || ' ' || cc.name              AS completo,
    a.acquisition_date                              AS mov_fecha_compra,
    CASE WHEN a.operational_status = 'WRITTEN_OFF' THEN 'SI' ELSE 'NO' END AS mov_debaja,
    a.physical_condition                            AS estado,
    CASE WHEN a.last_verified_at IS NOT NULL THEN 'Si' ELSE 'No' END AS validado_toma_fisica,
    p.first_name || ' ' || p.last_name              AS responsable,
    p.position_title                                AS cargo,
    a.written_off_at                                AS mov_fecha_debaja,
    a.useful_life_years                             AS mov_ano_depre,
    a.notes                                         AS mov_observaciones,
    a.acquisition_price                             AS mov_precio_compra
FROM asset a
LEFT JOIN cost_center cc ON cc.id = a.current_cost_center_id
LEFT JOIN person p       ON p.id = a.current_responsible_id;

-- Vista de activos con préstamo vencido (para alertas a jefes de dependencia)
CREATE OR REPLACE VIEW v_overdue_loans AS
SELECT
    l.id AS loan_id,
    a.internal_code,
    a.description,
    l.target_cost_center_id,
    tcc.name AS target_cost_center,
    l.expected_return_date,
    CURRENT_DATE - l.expected_return_date AS days_overdue,
    p.first_name || ' ' || p.last_name AS current_responsible
FROM asset_loan l
JOIN asset a          ON a.id = l.asset_id
JOIN cost_center tcc  ON tcc.id = l.target_cost_center_id
JOIN person p         ON p.id = l.target_responsible_id
WHERE l.status = 'ACTIVE'
  AND l.expected_return_date < CURRENT_DATE;

-- =============================================================================
-- SECCIÓN 12: TRIGGERS DE INTEGRIDAD
-- =============================================================================

-- updated_at automático en tablas principales
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_asset_touch BEFORE UPDATE ON asset
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_person_touch BEFORE UPDATE ON person
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_cost_center_touch BEFORE UPDATE ON cost_center
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_loan_touch BEFORE UPDATE ON asset_loan
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- =============================================================================
-- SECCIÓN 13: SEED MÍNIMO (roles del sistema, tipos de adquisición)
-- =============================================================================


INSERT INTO acquisition_type (code, name) VALUES
    ('PURCHASE',   'Compra'),
    ('DONATION',   'Donación'),
    ('LEASING',    'Leasing / Arrendamiento financiero'),
    ('GRANT',      'Convenio / Proyecto'),
    ('EXCHANGE',   'Permuta'),
    ('OWN_PROD',   'Producción propia');

INSERT INTO code_sequence (sequence_name, prefix, padding_length) VALUES
    ('asset_internal_code',   'A',    4),
    ('physical_inventory',    'TF-',  3),
    ('loan',                  'PR-',  5);

`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
DROP VIEW IF EXISTS v_overdue_loans;
DROP VIEW IF EXISTS v_asset_report;
DROP TABLE IF EXISTS code_sequence CASCADE;
DROP TABLE IF EXISTS system_setting CASCADE;
DROP TABLE IF EXISTS notification CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS asset_depreciation CASCADE;
DROP TABLE IF EXISTS physical_inventory_item CASCADE;
DROP TABLE IF EXISTS physical_inventory_scope CASCADE;
DROP TABLE IF EXISTS physical_inventory CASCADE;
DROP TABLE IF EXISTS asset_loan CASCADE;
DROP TABLE IF EXISTS asset_movement CASCADE;
DROP TABLE IF EXISTS asset_document CASCADE;
DROP TABLE IF EXISTS asset_photo CASCADE;
DROP TABLE IF EXISTS asset_custom_value CASCADE;
DROP TABLE IF EXISTS asset CASCADE;
DROP TABLE IF EXISTS acquisition_type CASCADE;
DROP TABLE IF EXISTS supplier CASCADE;
DROP TABLE IF EXISTS manufacturer CASCADE;
DROP TABLE IF EXISTS asset_category_field CASCADE;
DROP TABLE IF EXISTS asset_category CASCADE;
DROP TABLE IF EXISTS app_user CASCADE;
DROP TABLE IF EXISTS person CASCADE;
DROP TABLE IF EXISTS cost_center CASCADE;
DROP TABLE IF EXISTS organizational_unit CASCADE;
DROP TABLE IF EXISTS location CASCADE;
DROP TABLE IF EXISTS building CASCADE;
DROP TABLE IF EXISTS campus CASCADE;
DROP FUNCTION IF EXISTS fn_touch_updated_at();
DROP TYPE IF EXISTS depreciation_method;
DROP TYPE IF EXISTS loan_status;
DROP TYPE IF EXISTS movement_type;
DROP TYPE IF EXISTS asset_physical_condition;
DROP TYPE IF EXISTS asset_operational_status;
DROP TYPE IF EXISTS user_status;
`);
  }
}
