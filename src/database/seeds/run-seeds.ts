import 'dotenv/config';
import argon2 from 'argon2';
import dataSource from '../data-source.js';

const firstRowId = (rows: unknown): string => {
  if (Array.isArray(rows) && rows.length > 0) {
    const row: unknown = rows[0];
    if (
      typeof row === 'object' &&
      row !== null &&
      'id' in row &&
      typeof row.id === 'string'
    ) {
      return row.id;
    }
  }
  throw new Error('La inserción no retornó un id');
};

const seedBootstrapAdmin = async (): Promise<void> => {
  const username = process.env['BOOTSTRAP_ADMIN_USERNAME'] ?? 'admin';
  const password = process.env['BOOTSTRAP_ADMIN_PASSWORD'] ?? 'ChangeMe!2026';

  await dataSource.initialize();
  try {
    const existing: unknown = await dataSource.query(
      'SELECT id FROM app_user WHERE username = $1',
      [username],
    );
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`El usuario ${username} ya existe; seed omitido.`);
      return;
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await dataSource.query('BEGIN');
    const personRows: unknown = await dataSource.query(
      `INSERT INTO person (document_type, document_number, first_name, last_name, email, position_title)
       VALUES ('CC', '0000000000', 'Administrador', 'del Sistema', 'admin@unac.edu.co', 'Administrador del sistema')
       RETURNING id`,
    );
    const personId = firstRowId(personRows);

    const userRows: unknown = await dataSource.query(
      `INSERT INTO app_user (person_id, username, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id`,
      [personId, username, passwordHash],
    );
    const userId = firstRowId(userRows);

    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type)
       SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'SUPER_ADMIN'`,
      [userId],
    );
    await dataSource.query('COMMIT');
    console.log(`Usuario bootstrap ${username} creado con rol SUPER_ADMIN.`);
  } catch (error) {
    await dataSource.query('ROLLBACK');
    throw error;
  } finally {
    await dataSource.destroy();
  }
};

await seedBootstrapAdmin();
