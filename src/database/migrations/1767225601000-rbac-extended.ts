import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RbacExtended1767225601000 implements MigrationInterface {
  name = 'RbacExtended1767225601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
-- =============================================================================
-- RBAC EXTENDIDO - Reemplaza la sección 3 (roles/permisos) del schema.sql
-- =============================================================================
-- Cubre NIST RBAC0 + RBAC1 (jerarquía) + RBAC2 (constraints/SoD).
-- Agrega: scope por recurso, vigencia temporal, delegación, RLS y vista de
-- permisos efectivos.
-- =============================================================================

-- Se asume que ya existen: app_user, organizational_unit, cost_center.
-- Si vas a re-aplicar, elimina primero las tablas antiguas:
--   DROP TABLE user_role, role_permission, permission, role CASCADE;

-- =============================================================================
-- 1. ROLES CON JERARQUÍA (RBAC1)
-- =============================================================================
CREATE TABLE role (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(50) NOT NULL UNIQUE,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    parent_role_id      UUID REFERENCES role(id),           -- herencia: hereda permisos del padre
    hierarchy_level     SMALLINT NOT NULL DEFAULT 0,        -- 0 = raíz. Se calcula al insertar.
    is_system           BOOLEAN NOT NULL DEFAULT FALSE,     -- no se puede borrar
    is_assignable       BOOLEAN NOT NULL DEFAULT TRUE,      -- roles abstractos = false
    max_concurrent_users INTEGER,                            -- cardinalidad (ej: 1 solo Director)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_no_self_parent CHECK (parent_role_id <> id)
);

CREATE INDEX idx_role_parent ON role(parent_role_id);

-- Función para prevenir ciclos en la jerarquía de roles
CREATE OR REPLACE FUNCTION fn_check_role_hierarchy_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
    v_current UUID;
BEGIN
    IF NEW.parent_role_id IS NULL THEN
        RETURN NEW;
    END IF;
    v_current := NEW.parent_role_id;
    WHILE v_current IS NOT NULL LOOP
        IF v_current = NEW.id THEN
            RAISE EXCEPTION 'Ciclo detectado en jerarquía de roles para %', NEW.code;
        END IF;
        SELECT parent_role_id INTO v_current FROM role WHERE id = v_current;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_role_no_cycle
    BEFORE INSERT OR UPDATE OF parent_role_id ON role
    FOR EACH ROW EXECUTE FUNCTION fn_check_role_hierarchy_no_cycle();

-- =============================================================================
-- 2. PERMISOS ESTRUCTURADOS (acción + recurso + scope)
-- =============================================================================
-- Antes: 'ASSET_UPDATE' como string opaco.
-- Ahora: acción sobre un tipo de recurso, con un nivel de scope declarado.

CREATE TYPE permission_scope_level AS ENUM (
    'GLOBAL',           -- todo el sistema
    'ORG_UNIT',         -- limitado a una unidad organizacional (y descendientes)
    'COST_CENTER',      -- limitado a un centro de costos
    'OWN'               -- sólo recursos asignados al usuario
);

CREATE TABLE permission (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(100) NOT NULL UNIQUE,           -- ej: asset:update:org_unit
    module          VARCHAR(50) NOT NULL,                    -- ASSET, LOAN, INVENTORY, USER, AUDIT
    resource_type   VARCHAR(50) NOT NULL,                    -- asset, loan, cost_center, user
    action          VARCHAR(30) NOT NULL,                    -- create, read, update, delete, approve, sign, export
    scope_level     permission_scope_level NOT NULL DEFAULT 'GLOBAL',
    description     TEXT,
    UNIQUE (resource_type, action, scope_level)
);

CREATE INDEX idx_permission_module ON permission(module);
CREATE INDEX idx_permission_resource ON permission(resource_type, action);

-- =============================================================================
-- 3. ASIGNACIÓN ROLE ↔ PERMISSION (con condiciones opcionales)
-- =============================================================================
CREATE TABLE role_permission (
    role_id         UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
    -- Condición opcional evaluada a nivel de aplicación o RLS.
    -- Ejemplo: {"asset.acquisition_price": {"lte": 5000000}}
    -- para permitir aprobar bajas sólo de activos bajo cierto monto.
    conditions      JSONB,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by      UUID REFERENCES app_user(id),
    PRIMARY KEY (role_id, permission_id)
);

-- =============================================================================
-- 4. ASIGNACIÓN USER ↔ ROLE (con scope, vigencia y delegación)
-- =============================================================================
CREATE TABLE user_role (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role_id                 UUID NOT NULL REFERENCES role(id),

    -- SCOPE POLIMÓRFICO: el rol aplica a este recurso específico.
    -- scope_type = 'GLOBAL' (scope_id null), 'ORG_UNIT' (id de organizational_unit),
    -- 'COST_CENTER' (id de cost_center).
    scope_type              VARCHAR(20) NOT NULL DEFAULT 'GLOBAL',
    scope_id                UUID,                            -- null si scope_type = GLOBAL

    -- VIGENCIA TEMPORAL: crítico para auditores externos, contratistas, delegaciones.
    valid_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until             TIMESTAMPTZ,                     -- null = indefinido

    -- DELEGACIÓN: si este rol fue delegado por otro usuario.
    is_delegated            BOOLEAN NOT NULL DEFAULT FALSE,
    delegated_from_user_id  UUID REFERENCES app_user(id),
    delegation_reason       TEXT,

    granted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by              UUID REFERENCES app_user(id),
    revoked_at              TIMESTAMPTZ,
    revoked_by              UUID REFERENCES app_user(id),
    revocation_reason       TEXT,

    CONSTRAINT chk_scope_consistency CHECK (
        (scope_type = 'GLOBAL' AND scope_id IS NULL) OR
        (scope_type <> 'GLOBAL' AND scope_id IS NOT NULL)
    ),
    CONSTRAINT chk_validity_range CHECK (valid_until IS NULL OR valid_until > valid_from),
    CONSTRAINT chk_delegation_consistency CHECK (
        (is_delegated = FALSE AND delegated_from_user_id IS NULL) OR
        (is_delegated = TRUE AND delegated_from_user_id IS NOT NULL)
    )
);

-- Un mismo user no puede tener dos veces el mismo rol activo con el mismo scope
CREATE UNIQUE INDEX idx_user_role_unique_active
    ON user_role(user_id, role_id, scope_type, COALESCE(scope_id::text, ''))
    WHERE revoked_at IS NULL;

CREATE INDEX idx_user_role_active
    ON user_role(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_role_scope
    ON user_role(scope_type, scope_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_role_expiring
    ON user_role(valid_until) WHERE valid_until IS NOT NULL AND revoked_at IS NULL;

-- =============================================================================
-- 5. SEPARATION OF DUTIES (RBAC2)
-- =============================================================================
-- Declara pares de roles mutuamente excluyentes: un usuario no puede tener ambos.
-- Ejemplo canónico en control interno: quien REGISTRA activos no puede APROBAR
-- sus propias bajas. Quien SOLICITA préstamos no puede APROBARLOS.

CREATE TABLE role_separation_of_duties (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_a_id           UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    role_b_id           UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    constraint_type     VARCHAR(20) NOT NULL,   -- STATIC (nunca ambos) o DYNAMIC (no en misma sesión/acción)
    reason              TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_different_roles CHECK (role_a_id <> role_b_id),
    UNIQUE (role_a_id, role_b_id)
);

-- Trigger que impide asignar un rol si el usuario ya tiene el rol excluyente
CREATE OR REPLACE FUNCTION fn_check_sod_violation()
RETURNS TRIGGER AS $$
DECLARE
    v_conflict_role UUID;
BEGIN
    IF NEW.revoked_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT sod.role_b_id INTO v_conflict_role
    FROM role_separation_of_duties sod
    JOIN user_role ur ON ur.role_id = sod.role_b_id
    WHERE sod.role_a_id = NEW.role_id
      AND ur.user_id = NEW.user_id
      AND ur.revoked_at IS NULL
      AND sod.constraint_type = 'STATIC'
    LIMIT 1;

    IF v_conflict_role IS NOT NULL THEN
        RAISE EXCEPTION 'Violación de Separación de Funciones: rol % conflictúa con rol % ya asignado al usuario', NEW.role_id, v_conflict_role;
    END IF;

    -- Chequear también la dirección inversa
    SELECT sod.role_a_id INTO v_conflict_role
    FROM role_separation_of_duties sod
    JOIN user_role ur ON ur.role_id = sod.role_a_id
    WHERE sod.role_b_id = NEW.role_id
      AND ur.user_id = NEW.user_id
      AND ur.revoked_at IS NULL
      AND sod.constraint_type = 'STATIC'
    LIMIT 1;

    IF v_conflict_role IS NOT NULL THEN
        RAISE EXCEPTION 'Violación de Separación de Funciones: rol % conflictúa con rol % ya asignado al usuario', NEW.role_id, v_conflict_role;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_sod
    BEFORE INSERT OR UPDATE ON user_role
    FOR EACH ROW EXECUTE FUNCTION fn_check_sod_violation();

-- =============================================================================
-- 6. VISTA DE PERMISOS EFECTIVOS
-- =============================================================================
-- Materializa qué puede hacer cada usuario, resolviendo:
--   - Roles activos (no revocados, dentro de vigencia)
--   - Herencia de roles (padre → hijo)
--   - Scope aplicable
-- La aplicación consulta ESTA vista, no las tablas base. Y se puede convertir
-- en MATERIALIZED VIEW con refresh disparado por triggers si el volumen crece.

CREATE OR REPLACE VIEW v_user_effective_permissions AS
WITH RECURSIVE role_hierarchy AS (
    -- Rol directo del usuario
    SELECT
        ur.user_id,
        ur.role_id,
        r.code AS role_code,
        ur.scope_type,
        ur.scope_id,
        ur.valid_from,
        ur.valid_until,
        ur.is_delegated
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.revoked_at IS NULL
      AND ur.valid_from <= NOW()
      AND (ur.valid_until IS NULL OR ur.valid_until > NOW())

    UNION

    -- Roles heredados (padres del rol actual)
    SELECT
        rh.user_id,
        r.parent_role_id AS role_id,
        pr.code AS role_code,
        rh.scope_type,
        rh.scope_id,
        rh.valid_from,
        rh.valid_until,
        rh.is_delegated
    FROM role_hierarchy rh
    JOIN role r  ON r.id = rh.role_id
    JOIN role pr ON pr.id = r.parent_role_id
    WHERE r.parent_role_id IS NOT NULL
)
SELECT DISTINCT
    rh.user_id,
    p.id            AS permission_id,
    p.code          AS permission_code,
    p.module,
    p.resource_type,
    p.action,
    p.scope_level,
    rh.scope_type   AS user_scope_type,
    rh.scope_id     AS user_scope_id,
    rp.conditions,
    rh.is_delegated,
    rh.valid_until
FROM role_hierarchy rh
JOIN role_permission rp ON rp.role_id = rh.role_id
JOIN permission p       ON p.id = rp.permission_id;

-- Función helper para la aplicación
CREATE OR REPLACE FUNCTION fn_user_has_permission(
    p_user_id           UUID,
    p_permission_code   VARCHAR,
    p_scope_type        VARCHAR DEFAULT NULL,
    p_scope_id          UUID DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM v_user_effective_permissions
        WHERE user_id = p_user_id
          AND permission_code = p_permission_code
          AND (
              user_scope_type = 'GLOBAL'
              OR (p_scope_type IS NOT NULL
                  AND user_scope_type = p_scope_type
                  AND (user_scope_id = p_scope_id OR user_scope_id IS NULL))
          )
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 7. ROW-LEVEL SECURITY EN TABLAS SENSIBLES
-- =============================================================================
-- Con RLS activo, aunque la app envíe un SELECT sin WHERE, Postgres filtra
-- automáticamente por el scope del usuario. Es la última línea de defensa.
-- Se asume que la app fija current_setting('app.current_user_id') al inicio
-- de cada transacción/conexión.

ALTER TABLE asset ENABLE ROW LEVEL SECURITY;

-- Los super admins ven todo
CREATE POLICY asset_super_admin_all ON asset
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM v_user_effective_permissions
            WHERE user_id = current_setting('app.current_user_id', TRUE)::UUID
              AND permission_code = 'asset:read:global'
        )
    );

-- Los usuarios con scope ORG_UNIT sólo ven activos cuyo centro de costos pertenezca
-- a su unidad organizacional (o descendientes vía hierarchy_path)
CREATE POLICY asset_org_unit_scope ON asset
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM v_user_effective_permissions vep
            JOIN cost_center cc ON cc.id = asset.current_cost_center_id
            JOIN organizational_unit ou_asset ON ou_asset.id = cc.organizational_unit_id
            JOIN organizational_unit ou_user  ON ou_user.id = vep.user_scope_id
            WHERE vep.user_id = current_setting('app.current_user_id', TRUE)::UUID
              AND vep.permission_code IN ('asset:read:org_unit', 'asset:update:org_unit')
              AND vep.user_scope_type = 'ORG_UNIT'
              AND ou_asset.hierarchy_path LIKE ou_user.hierarchy_path || '%'
        )
    );

-- Nota: idénticas policies para asset_movement, asset_loan, physical_inventory
-- cuando sea el momento. Se dejan como TODO explícito.

-- =============================================================================
-- 8. SEED DE ROLES Y PERMISOS
-- =============================================================================

-- --- Roles con jerarquía -----------------------------------------------------
-- SUPER_ADMIN (raíz técnica)
--    └── INTERNAL_CONTROL_DIRECTOR
--          └── AUDITOR
--                └── VIEWER
--    └── DEPARTMENT_HEAD
--          └── CUSTODIAN

INSERT INTO role (code, name, description, is_system, max_concurrent_users) VALUES
    ('SUPER_ADMIN',               'Super Administrador',        'Control total técnico',                TRUE, 2),
    ('INTERNAL_CONTROL_DIRECTOR', 'Director/a Control Interno', 'Máxima autoridad funcional',           TRUE, 1),
    ('AUDITOR',                   'Auditor',                    'Lectura completa + reportes',          TRUE, NULL),
    ('DEPARTMENT_HEAD',           'Jefe de Dependencia',        'Gestiona activos de su unidad',        TRUE, NULL),
    ('CUSTODIAN',                 'Custodio de Activos',        'Responsable físico de activos',        TRUE, NULL),
    ('VIEWER',                    'Consulta',                   'Sólo lectura',                         TRUE, NULL);

-- Herencia: se resuelve por UPDATE porque los IDs se generaron arriba.
UPDATE role SET parent_role_id = (SELECT id FROM role WHERE code = 'AUDITOR')
    WHERE code = 'INTERNAL_CONTROL_DIRECTOR';
UPDATE role SET parent_role_id = (SELECT id FROM role WHERE code = 'VIEWER')
    WHERE code = 'AUDITOR';
UPDATE role SET parent_role_id = (SELECT id FROM role WHERE code = 'CUSTODIAN')
    WHERE code = 'DEPARTMENT_HEAD';
UPDATE role SET parent_role_id = (SELECT id FROM role WHERE code = 'VIEWER')
    WHERE code = 'CUSTODIAN';

-- --- Permisos por módulo -----------------------------------------------------
INSERT INTO permission (code, module, resource_type, action, scope_level, description) VALUES
    -- Assets
    ('asset:read:global',       'ASSET', 'asset', 'read',    'GLOBAL',      'Ver cualquier activo'),
    ('asset:read:org_unit',     'ASSET', 'asset', 'read',    'ORG_UNIT',    'Ver activos de su unidad'),
    ('asset:create:global',     'ASSET', 'asset', 'create',  'GLOBAL',      'Registrar activos'),
    ('asset:update:global',     'ASSET', 'asset', 'update',  'GLOBAL',      'Modificar cualquier activo'),
    ('asset:update:org_unit',   'ASSET', 'asset', 'update',  'ORG_UNIT',    'Modificar activos de su unidad'),
    ('asset:write_off:global',  'ASSET', 'asset', 'delete',  'GLOBAL',      'Dar de baja activos'),
    ('asset:sign_qr:global',    'ASSET', 'asset', 'sign',    'GLOBAL',      'Firmar QR (verificación)'),
    ('asset:export:global',     'ASSET', 'asset', 'export',  'GLOBAL',      'Exportar inventario'),
    -- Loans
    ('loan:read:global',        'LOAN',  'loan',  'read',    'GLOBAL',      'Ver todos los préstamos'),
    ('loan:read:org_unit',      'LOAN',  'loan',  'read',    'ORG_UNIT',    'Ver préstamos de su unidad'),
    ('loan:request:own',        'LOAN',  'loan',  'create',  'OWN',         'Solicitar préstamos'),
    ('loan:approve:org_unit',   'LOAN',  'loan',  'approve', 'ORG_UNIT',    'Aprobar préstamos de su unidad'),
    -- Physical inventory
    ('inventory:create:global', 'INVENTORY', 'physical_inventory', 'create', 'GLOBAL', 'Programar tomas físicas'),
    ('inventory:execute:global','INVENTORY', 'physical_inventory', 'update', 'GLOBAL', 'Ejecutar tomas físicas'),
    -- Users & roles
    ('user:manage:global',      'USER',  'user',  'update',  'GLOBAL',      'Gestionar usuarios'),
    ('role:assign:global',      'USER',  'role',  'update',  'GLOBAL',      'Asignar roles'),
    -- Audit
    ('audit:read:global',       'AUDIT', 'audit_log', 'read', 'GLOBAL',     'Consultar bitácora'),
    ('audit:export:global',     'AUDIT', 'audit_log', 'export','GLOBAL',    'Exportar bitácora');

-- --- Asignación role → permission --------------------------------------------
-- VIEWER: sólo lectura básica
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'VIEWER' AND p.code IN ('asset:read:org_unit', 'loan:read:org_unit');

-- CUSTODIAN: hereda de VIEWER + puede solicitar préstamos
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'CUSTODIAN' AND p.code IN ('loan:request:own');

-- DEPARTMENT_HEAD: hereda de CUSTODIAN + aprueba préstamos y edita activos de su unidad
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'DEPARTMENT_HEAD'
  AND p.code IN ('asset:update:org_unit', 'loan:approve:org_unit', 'asset:read:org_unit');

-- AUDITOR: hereda de VIEWER + lectura global + exports + bitácora
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'AUDITOR'
  AND p.code IN ('asset:read:global', 'loan:read:global', 'asset:export:global',
                 'audit:read:global', 'audit:export:global');

-- INTERNAL_CONTROL_DIRECTOR: hereda de AUDITOR + operaciones sensibles
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR'
  AND p.code IN ('asset:create:global', 'asset:update:global', 'asset:write_off:global',
                 'asset:sign_qr:global', 'inventory:create:global', 'inventory:execute:global');

-- SUPER_ADMIN: gestión de usuarios y roles (no debería tener permisos operativos)
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.code = 'SUPER_ADMIN'
  AND p.code IN ('user:manage:global', 'role:assign:global', 'audit:read:global');

-- --- Separation of Duties ----------------------------------------------------
-- Regla clave de control interno: quien opera técnicamente el sistema
-- (SUPER_ADMIN) no puede tener rol operativo con firma sobre activos.
INSERT INTO role_separation_of_duties (role_a_id, role_b_id, constraint_type, reason)
SELECT r1.id, r2.id, 'STATIC',
       'El administrador técnico no puede firmar verificaciones ni aprobar bajas de activos'
FROM role r1, role r2
WHERE r1.code = 'SUPER_ADMIN' AND r2.code = 'INTERNAL_CONTROL_DIRECTOR';

-- El custodio no puede aprobar sus propias solicitudes de préstamo
INSERT INTO role_separation_of_duties (role_a_id, role_b_id, constraint_type, reason)
SELECT r1.id, r2.id, 'DYNAMIC',
       'Quien solicita un préstamo no puede aprobarlo en la misma acción'
FROM role r1, role r2
WHERE r1.code = 'CUSTODIAN' AND r2.code = 'DEPARTMENT_HEAD';

`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
DROP VIEW IF EXISTS v_user_effective_permissions CASCADE;
DROP FUNCTION IF EXISTS fn_user_has_permission(UUID, VARCHAR, VARCHAR, UUID);
DROP TABLE IF EXISTS role_separation_of_duties CASCADE;
DROP TABLE IF EXISTS user_role CASCADE;
DROP TABLE IF EXISTS role_permission CASCADE;
DROP TABLE IF EXISTS permission CASCADE;
DROP TABLE IF EXISTS role CASCADE;
DROP FUNCTION IF EXISTS fn_check_sod_violation();
DROP FUNCTION IF EXISTS fn_check_role_hierarchy_no_cycle();
DROP TYPE IF EXISTS permission_scope_level;
`);
  }
}
