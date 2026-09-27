import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-06: person.email es destinatario de correos (enlaces de firma). La regla anterior, chk_person_email_unac
 * ('@unac\.edu\.co$'), solo mira el final de la cadena, así que un correo con saltos de línea terminado en
 * @unac.edu.co pasaba. La importación y el cliente SMTP ya lo rechazan; esta restricción es la tercera capa:
 * ninguna ruta puede guardar un correo con caracteres de control ([[:cntrl:]] incluye NUL, CR, LF y TAB).
 *
 * NOT VALID: no revisa filas existentes (no se modifican datos personales en una migración). Para comprobar si hay
 * alguna y, tras corregirlas a mano, validar la restricción:
 *   SELECT id FROM person WHERE email ~ '[[:cntrl:]]';
 *   ALTER TABLE person VALIDATE CONSTRAINT chk_person_email_single_line;
 */
export class PersonEmailSingleLine1767225760000 implements MigrationInterface {
  name = 'PersonEmailSingleLine1767225760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
ALTER TABLE person DROP CONSTRAINT IF EXISTS chk_person_email_single_line;
ALTER TABLE person ADD CONSTRAINT chk_person_email_single_line
    CHECK (email !~ '[[:cntrl:]]') NOT VALID;
`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE person DROP CONSTRAINT IF EXISTS chk_person_email_single_line;');
  }
}
