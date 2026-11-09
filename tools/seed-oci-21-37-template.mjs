import 'dotenv/config';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(root, 'templates/formats/OCI-21-37-v2.docx');
const buffer = readFileSync(templatePath);

const { readDocxPlaceholders } = await import(
  resolve(root, 'dist/modules/document-templates/domain/docx-template.js')
);
const { documentTemplateKey } = await import(
  resolve(root, 'dist/shared/storage/storage-keys.js')
);

const effectiveDate = '2020-01-01';
const sgcVersion = '2';
const id = randomUUID();
const storageKey = documentTemplateKey({
  formatKey: 'OCI-21-37',
  effectiveDate,
  version: sgcVersion,
  id,
});
const storageRoot = resolve(root, process.env.STORAGE_PROJECT_PATH || 'storage');
const absolute = resolve(storageRoot, storageKey);
mkdirSync(dirname(absolute), { recursive: true });
writeFileSync(absolute, buffer);
const hash = createHash('sha256').update(buffer).digest('hex');
const placeholders = readDocxPlaceholders(buffer);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const adminRow = (
    await client.query(
      `SELECT id FROM app_user
       WHERE username = ANY($1)
       ORDER BY array_position($1, username)
       LIMIT 1`,
      [[process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin', 'controlinterno', 'afpatinob']],
    )
  ).rows[0];
  const adminId = adminRow?.id ?? null;
  const existing = (
    await client.query(
      `SELECT id FROM document_template_version WHERE format_key = 'OCI-21-37' AND effective_date = $1`,
      [effectiveDate],
    )
  ).rows;
  if (existing.length === 0) {
    await client.query(
      `INSERT INTO document_template_version
         (format_key, sgc_code, sgc_version, effective_date, storage_driver, storage_key,
          file_hash, original_filename, placeholders, uploaded_by)
       VALUES ('OCI-21-37', 'OCI-21-37', $1, $2, 'project', $3, $4, $5, $6::jsonb, $7)`,
      [
        sgcVersion,
        effectiveDate,
        storageKey,
        hash,
        'OCI-21-37-v2.docx',
        JSON.stringify(placeholders),
        adminId ?? null,
      ],
    );
    console.log('template uploaded', storageKey);
  } else {
    console.log('template already present', existing[0].id);
  }

  const failed = (
    await client.query(
      `SELECT dr.id
       FROM document_request dr
       JOIN physical_inventory_act a ON a.document_request_id = dr.id
       JOIN physical_inventory i ON i.id = a.inventory_id
       WHERE i.code = 'TF-2026-001' AND dr.status = 'FAILED'`,
    )
  ).rows;
  for (const row of failed) {
    await client.query(
      `UPDATE document_request
       SET status = 'PENDING', attempts = 0, last_error = NULL, processed_at = NULL, document_id = NULL
       WHERE id = $1`,
      [row.id],
    );
    console.log('reset request', row.id);
  }
} finally {
  await client.end();
}
