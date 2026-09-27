import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plantillas de correo: párrafo enriquecido e imágenes subidas.
 *
 * - email_template.blocks: en TODAS las versiones, cada `paragraph { text }` pasa a `paragraph { content }`, un
 *   documento Tiptap/ProseMirror (src/modules/email-templates/domain/rich-text.ts). Cada línea en blanco separa
 *   párrafos y cada salto simple es un `hardBreak`; texto y variables {{...}} quedan intactos (sin pérdida: la vuelta
 *   da el mismo texto). Los demás bloques no cambian.
 * - email_asset: metadatos de las imágenes PNG/JPEG subidas desde el editor. Los bytes NO están en la BD: van al
 *   bucket público del proveedor S3 (clave email-assets/<uuid>.<png|jpg>) y el correo usa public_url. Sin borrado
 *   desde la aplicación: los correos ya enviados siguen apuntando a ellas. sha256 único: la misma imagen devuelve la
 *   existente.
 * - storage_settings.s3_public_assets_bucket y s3_public_assets_base_url: bucket público (distinto del de
 *   documentos, que sigue privado) y su URL pública base. Mismo endpoint y credenciales del proveedor S3; sin
 *   secretos nuevos.
 *
 * down() (con pérdida, documentado): cada `paragraph { content }` vuelve a `paragraph { text }` sin marcas (negrita,
 * cursiva, subrayado); cada ítem de lista queda como una línea "- " o "1. " y cada enlace como "texto (href)". Cada
 * bloque `image` pasa a un párrafo "[Imagen: alt]" (el diseño anterior no conoce imágenes); la tabla email_asset y
 * las dos columnas de storage_settings se eliminan. Los objetos del bucket público NO se borran (down() no toca el
 * almacenamiento): los correos ya enviados siguen mostrando sus imágenes.
 *
 * Las conversiones están copiadas aquí (una migración no importa código vivo); rich-text.spec.ts prueba las vivas y
 * legacy-text-migration.spec.ts estas. TypeORM corre cada migración en una transacción (CLI: 'all'; tests: 'each').
 */

interface StoredBlock {
  readonly type: string;
}

const field = (block: StoredBlock, name: string): unknown => (block as unknown as Record<string, unknown>)[name];

interface DocNode {
  readonly type: string;
  readonly text?: string;
  readonly content?: ReadonlyArray<DocNode>;
  readonly marks?: ReadonlyArray<{ readonly type: string; readonly attrs?: { readonly href?: string } }>;
}

/** Texto → documento: línea en blanco = párrafo nuevo, salto simple = hardBreak. Sin pérdida. */
export const textToDoc = (text: string): DocNode => ({
  type: 'doc',
  content: text
    .replace(/\r\n|\r/g, '\n')
    .split('\n\n')
    .map((part) => {
      const content: DocNode[] = [];
      part.split('\n').forEach((line, index) => {
        if (index > 0) {
          content.push({ type: 'hardBreak' });
        }
        if (line !== '') {
          content.push({ type: 'text', text: line });
        }
      });
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
});

const paragraphToText = (paragraph: DocNode): string =>
  (paragraph.content ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') {
        return '\n';
      }
      const text = node.text ?? '';
      const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
      return href !== undefined && href !== text ? `${text} (${href})` : text;
    })
    .join('');

/** Documento → texto con las variables sin sustituir; pierde las marcas. */
export const docToText = (doc: DocNode): string =>
  (doc.content ?? [])
    .map((block) =>
      block.type === 'paragraph'
        ? paragraphToText(block)
        : (block.content ?? [])
            .map(
              (item, index) =>
                `${block.type === 'orderedList' ? `${index + 1}.` : '-'} ` +
                (item.content ?? []).map(paragraphToText).join('\n'),
            )
            .join('\n'),
    )
    .join('\n\n');

/** up(): paragraph { text } → paragraph { content }. Lo que ya tiene content no se toca (idempotente). */
export const upgradeBlocks = (blocks: ReadonlyArray<StoredBlock>): ReadonlyArray<StoredBlock> =>
  blocks.map((block) =>
    block.type === 'paragraph' && typeof field(block, 'text') === 'string'
      ? { type: 'paragraph', content: textToDoc(field(block, 'text') as string) }
      : block,
  );

/** down(): paragraph { content } → paragraph { text }; image → paragraph "[Imagen: alt]". */
export const downgradeBlocks = (blocks: ReadonlyArray<StoredBlock>): ReadonlyArray<StoredBlock> =>
  blocks.map((block) => {
    const content = field(block, 'content');
    if (block.type === 'paragraph' && typeof content === 'object' && content !== null) {
      return { type: 'paragraph', text: docToText(content as DocNode) };
    }
    if (block.type === 'image') {
      const alt = field(block, 'alt');
      return { type: 'paragraph', text: `[Imagen: ${typeof alt === 'string' ? alt : ''}]` };
    }
    return block;
  });

const convertAll = async (
  queryRunner: QueryRunner,
  convert: (blocks: ReadonlyArray<StoredBlock>) => ReadonlyArray<StoredBlock>,
): Promise<void> => {
  const rows = (await queryRunner.query(`SELECT id, blocks FROM email_template ORDER BY id`)) as Array<{
    id: string;
    blocks: ReadonlyArray<StoredBlock>;
  }>;
  for (const row of rows) {
    const next = convert(row.blocks);
    if (JSON.stringify(next) !== JSON.stringify(row.blocks)) {
      await queryRunner.query(`UPDATE email_template SET blocks = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(next)]);
    }
  }
};

export class EmailRichParagraphAndAssets1767225820000 implements MigrationInterface {
  name = 'EmailRichParagraphAndAssets1767225820000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE email_asset (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        storage_key VARCHAR(200) NOT NULL CONSTRAINT uq_email_asset_storage_key UNIQUE
          CONSTRAINT chk_email_asset_storage_key CHECK (storage_key ~ '^email-assets/[0-9a-f-]{36}[.](png|jpg)$'),
        public_url TEXT NOT NULL CONSTRAINT chk_email_asset_public_url CHECK (public_url ~ '^https?://'),
        mime VARCHAR(20) NOT NULL CONSTRAINT chk_email_asset_mime CHECK (mime IN ('image/png', 'image/jpeg')),
        byte_size INTEGER NOT NULL CONSTRAINT chk_email_asset_byte_size CHECK (byte_size > 0),
        width INTEGER NOT NULL CONSTRAINT chk_email_asset_width CHECK (width BETWEEN 1 AND 2000),
        height INTEGER NOT NULL CONSTRAINT chk_email_asset_height CHECK (height BETWEEN 1 AND 2000),
        sha256 CHAR(64) NOT NULL CONSTRAINT uq_email_asset_sha256 UNIQUE,
        original_name VARCHAR(120) NOT NULL,
        created_by UUID NULL CONSTRAINT fk_email_asset_created_by REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_email_asset_created_at ON email_asset (created_at DESC)`);
    await queryRunner.query(`
      ALTER TABLE storage_settings
        ADD COLUMN s3_public_assets_bucket VARCHAR(63) NULL,
        ADD COLUMN s3_public_assets_base_url TEXT NULL
    `);
    await convertAll(queryRunner, upgradeBlocks);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await convertAll(queryRunner, downgradeBlocks);
    await queryRunner.query(`
      ALTER TABLE storage_settings
        DROP COLUMN IF EXISTS s3_public_assets_base_url,
        DROP COLUMN IF EXISTS s3_public_assets_bucket
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS email_asset`);
  }
}
