-- Limpieza única de los datos de ejemplo que sembraban phase2-structure y
-- phase3-categories en bases creadas antes del commit "Remove example data
-- from migrations". No es una migración: se corre una sola vez, a mano.
--
-- Ensayo (siempre termina en ROLLBACK):
--   psql "$DATABASE_URL" -f scripts/cleanup-example-data.sql
-- Aplicar de verdad:
--   psql "$DATABASE_URL" -v commit=1 -f scripts/cleanup-example-data.sql
--
-- Solo borra filas con el código sembrado Y el created_at de la corrida de
-- migraciones (el mismo del campus 'MED'), y solo si nada las referencia.
-- Lo que esté referenciado se queda y aparece en el reporte final.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE seed_time ON COMMIT DROP AS
SELECT created_at AS ts FROM campus WHERE code = 'MED';

CREATE TEMP TABLE seed_codes (kind text, code text) ON COMMIT DROP;
INSERT INTO seed_codes VALUES
  ('location', 'A-101'), ('location', 'A-102'), ('location', 'A-201'), ('location', 'A-202'),
  ('location', 'A-203'), ('location', 'A-301'), ('location', 'A-302'), ('location', 'A-401'),
  ('location', 'B-101'), ('location', 'B-102'), ('location', 'B-201'), ('location', 'B-202'),
  ('location', 'B-301'), ('location', 'B-HALL'), ('location', 'C-101'), ('location', 'C-102'),
  ('location', 'C-103'), ('location', 'C-201'), ('location', 'C-202'), ('location', 'C-CAFE'),
  ('building', 'A'), ('building', 'B'), ('building', 'C'),
  ('campus', 'MED'),
  ('cost_center', '1100'), ('cost_center', '4100'), ('cost_center', '4200'), ('cost_center', '4330'),
  ('org_unit', 'REC'), ('org_unit', 'VAC'), ('org_unit', 'VAD'), ('org_unit', 'VDE'),
  ('org_unit', 'VIN'), ('org_unit', 'FING'), ('org_unit', 'FCED'), ('org_unit', 'DTH'),
  ('org_unit', 'DCI'), ('org_unit', 'DFIN'), ('org_unit', 'DSIS'),
  ('category', 'COMPUTADORES'), ('category', 'MUEBLES'), ('category', 'EQUIPOS_RED'),
  ('category', 'IMPRESORAS'), ('category', 'AUDIOVISUAL'), ('category', 'LABORATORIO'),
  ('category', 'VEHICULOS'), ('category', 'OTROS'), ('category', 'PORTATILES'),
  ('category', 'ESCRITORIO'), ('category', 'SILLAS'), ('category', 'MESAS'),
  ('category', 'SILLAS_ERGONOMICAS');

-- Ubicaciones -> edificios -> campus
DELETE FROM location l
USING building b, campus c, seed_time t
WHERE l.building_id = b.id AND b.campus_id = c.id
  AND c.code = 'MED' AND l.created_at = t.ts
  AND l.code IN (SELECT code FROM seed_codes WHERE kind = 'location')
  AND NOT EXISTS (SELECT 1 FROM asset WHERE current_location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM asset_loan WHERE target_location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM asset_movement WHERE l.id IN (from_location_id, to_location_id))
  AND NOT EXISTS (SELECT 1 FROM physical_inventory_item WHERE l.id IN (actual_location_id, expected_location_id))
  AND NOT EXISTS (SELECT 1 FROM physical_inventory WHERE scope_type = 'LOCATION' AND scope_id = l.id);

DELETE FROM building b
USING campus c, seed_time t
WHERE b.campus_id = c.id AND c.code = 'MED' AND b.created_at = t.ts
  AND b.code IN (SELECT code FROM seed_codes WHERE kind = 'building')
  AND NOT EXISTS (SELECT 1 FROM location WHERE building_id = b.id);

DELETE FROM campus c
USING seed_time t
WHERE c.code = 'MED' AND c.created_at = t.ts
  AND NOT EXISTS (SELECT 1 FROM building WHERE campus_id = c.id);

-- Centros de costo (antes que las unidades, porque las referencian)
DELETE FROM cost_center cc
USING seed_time t
WHERE cc.created_at = t.ts
  AND cc.external_code IN (SELECT code FROM seed_codes WHERE kind = 'cost_center')
  AND NOT EXISTS (SELECT 1 FROM asset WHERE current_cost_center_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM asset_loan WHERE cc.id IN (source_cost_center_id, target_cost_center_id))
  AND NOT EXISTS (SELECT 1 FROM asset_loan_item WHERE source_cost_center_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM asset_movement WHERE cc.id IN (from_cost_center_id, to_cost_center_id))
  AND NOT EXISTS (SELECT 1 FROM cost_center child WHERE child.parent_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM person WHERE cost_center_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM physical_inventory_item WHERE expected_cost_center_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM physical_inventory_scope WHERE cost_center_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM physical_inventory WHERE scope_type = 'COST_CENTER' AND scope_id = cc.id)
  AND NOT EXISTS (SELECT 1 FROM user_role WHERE scope_type = 'COST_CENTER' AND scope_id = cc.id);

-- Unidades organizacionales: de las hojas hacia la raíz (profundidad máxima 4)
DO $$
BEGIN
  FOR i IN 1..4 LOOP
    DELETE FROM organizational_unit ou
    USING seed_time t
    WHERE ou.created_at = t.ts
      AND ou.code IN (SELECT code FROM seed_codes WHERE kind = 'org_unit')
      AND NOT EXISTS (SELECT 1 FROM organizational_unit child WHERE child.parent_id = ou.id)
      AND NOT EXISTS (SELECT 1 FROM cost_center WHERE organizational_unit_id = ou.id)
      AND NOT EXISTS (SELECT 1 FROM person WHERE organizational_unit_id = ou.id)
      AND NOT EXISTS (SELECT 1 FROM physical_inventory WHERE scope_type = 'ORG_UNIT' AND scope_id = ou.id)
      AND NOT EXISTS (SELECT 1 FROM user_role WHERE scope_type = 'ORG_UNIT' AND scope_id = ou.id);
  END LOOP;
END $$;

-- Campos dinámicos sembrados (sin valores capturados) y categorías, de hojas a raíz
DELETE FROM asset_category_field f
USING asset_category c, seed_time t
WHERE f.category_id = c.id AND c.created_at = t.ts
  AND c.code IN (SELECT code FROM seed_codes WHERE kind = 'category')
  AND f.field_code IN ('procesador', 'ramGB', 'hostname', 'sistemaOperativo', 'tamanoPantallaPulgadas')
  AND NOT EXISTS (SELECT 1 FROM asset_custom_value WHERE field_id = f.id);

DO $$
BEGIN
  FOR i IN 1..3 LOOP
    DELETE FROM asset_category c
    USING seed_time t
    WHERE c.created_at = t.ts
      AND c.code IN (SELECT code FROM seed_codes WHERE kind = 'category')
      AND NOT EXISTS (SELECT 1 FROM asset_category child WHERE child.parent_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM asset WHERE category_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM asset_category_field WHERE category_id = c.id);
  END LOOP;
END $$;

-- Reporte: filas sembradas que quedaron porque algo las referencia
SELECT 'campus' AS tabla, code AS codigo FROM campus WHERE code = 'MED'
UNION ALL SELECT 'building', code FROM building WHERE code IN (SELECT code FROM seed_codes WHERE kind = 'building')
UNION ALL SELECT 'location', code FROM location WHERE code IN (SELECT code FROM seed_codes WHERE kind = 'location')
UNION ALL SELECT 'cost_center', external_code FROM cost_center WHERE external_code IN (SELECT code FROM seed_codes WHERE kind = 'cost_center')
UNION ALL SELECT 'organizational_unit', code FROM organizational_unit WHERE code IN (SELECT code FROM seed_codes WHERE kind = 'org_unit')
UNION ALL SELECT 'asset_category', code FROM asset_category WHERE code IN (SELECT code FROM seed_codes WHERE kind = 'category')
ORDER BY 1, 2;

\if :{?commit}
COMMIT;
\echo 'Cambios aplicados (COMMIT).'
\else
ROLLBACK;
\echo 'Ensayo: nada se guardó (ROLLBACK). Para aplicar: -v commit=1'
\endif
