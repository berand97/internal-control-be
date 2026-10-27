import type { MigrationInterface, QueryRunner } from 'typeorm';

const PERMISSION_DESCRIPTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['org_unit:read:global', 'Consultar unidades organizacionales', 'Consultar dependencias'],
  ['org_unit:manage:global', 'Crear, editar y desactivar unidades organizacionales', 'Crear, editar y archivar dependencias'],
  ['asset:read:org_unit', 'Ver activos de su unidad', 'Ver activos de su dependencia'],
  ['asset:update:org_unit', 'Modificar activos de su unidad', 'Modificar activos de su dependencia'],
  ['loan:read:org_unit', 'Ver préstamos de su unidad', 'Ver préstamos de su dependencia'],
  ['loan:approve:org_unit', 'Aprobar préstamos de su unidad', 'Aprobar préstamos de su dependencia'],
];

const ROLE_DESCRIPTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['DEPARTMENT_HEAD', 'Gestiona activos de su unidad', 'Gestiona activos de su dependencia'],
];

const NAVIGATION_LABELS: ReadonlyArray<readonly [string, string, string]> = [
  ['/organizational-units', 'Unidades organizacionales', 'Dependencias'],
];

export class DependenciaLabels1767226090000 implements MigrationInterface {
  name = 'DependenciaLabels1767226090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, (from, to) => [from, to]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, (from, to) => [to, from]);
  }

  private async apply(
    queryRunner: QueryRunner,
    direction: (from: string, to: string) => readonly [string, string],
  ): Promise<void> {
    for (const [code, from, to] of PERMISSION_DESCRIPTIONS) {
      const [current, next] = direction(from, to);
      await queryRunner.query('UPDATE permission SET description = $3 WHERE code = $1 AND description = $2', [code, current, next]);
    }
    for (const [code, from, to] of ROLE_DESCRIPTIONS) {
      const [current, next] = direction(from, to);
      await queryRunner.query('UPDATE role SET description = $3 WHERE code = $1 AND description = $2', [code, current, next]);
    }
    for (const [path, from, to] of NAVIGATION_LABELS) {
      const [current, next] = direction(from, to);
      await queryRunner.query('UPDATE navigation_item SET label = $3 WHERE path = $1 AND label = $2', [path, current, next]);
    }
  }
}
