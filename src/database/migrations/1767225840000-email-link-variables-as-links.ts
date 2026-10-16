import type { MigrationInterface, QueryRunner } from 'typeorm';

export const LINK_VARIABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  USER_INVITATION: { 'auth.loginUrl': 'Iniciar sesión' },
  PASSWORD_RESET: { 'auth.resetUrl': 'Restablecer contraseña' },
  GENERIC_NOTIFICATION: { 'app.loginUrl': 'Abrir Control Interno' },
  LOAN_STATUS_NOTIFICATION: { 'app.loginUrl': 'Abrir Control Interno' },
  INVENTORY_ALERT: { 'app.loginUrl': 'Abrir Control Interno' },
  SIGNATURE_LINK: { 'firma.url': 'Abrir el documento' },
  IMPORT_FINISHED: { 'app.loginUrl': 'Abrir Control Interno' },
};

interface Mark {
  readonly type: string;
  readonly attrs?: { readonly href?: string };
}

interface DocNode {
  readonly type: string;
  readonly text?: string;
  readonly marks?: ReadonlyArray<Mark>;
  readonly content?: ReadonlyArray<DocNode>;
}

interface StoredBlock {
  readonly type: string;
  readonly content?: DocNode;
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const convertText = (node: DocNode, links: Readonly<Record<string, string>>): ReadonlyArray<DocNode> => {
  const text = node.text ?? '';
  const marks = node.marks ?? [];
  const hasLink = marks.some((mark) => mark.type === 'link');
  const out: DocNode[] = [];
  const push = (piece: string, pieceMarks: ReadonlyArray<Mark>): void => {
    if (piece !== '') {
      out.push(pieceMarks.length > 0 ? { type: 'text', text: piece, marks: pieceMarks } : { type: 'text', text: piece });
    }
  };
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    const linkText = links[name];
    if (linkText === undefined) {
      continue;
    }
    push(text.slice(last, match.index), marks);
    push(linkText, hasLink ? marks : [...marks, { type: 'link', attrs: { href: `{{${name}}}` } }]);
    last = match.index + match[0].length;
  }
  if (last === 0) {
    return [node];
  }
  push(text.slice(last), marks);
  return out;
};

const convertParagraph = (paragraph: DocNode, links: Readonly<Record<string, string>>): DocNode =>
  paragraph.content === undefined
    ? paragraph
    : { ...paragraph, content: paragraph.content.flatMap((node) => (node.type === 'text' ? convertText(node, links) : [node])) };

const convertDoc = (doc: DocNode, links: Readonly<Record<string, string>>): DocNode => ({
  ...doc,
  content: (doc.content ?? []).map((block) =>
    block.type === 'paragraph'
      ? convertParagraph(block, links)
      : {
          ...block,
          content: (block.content ?? []).map((item) => ({
            ...item,
            content: (item.content ?? []).map((child) => convertParagraph(child, links)),
          })),
        },
  ),
});

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

export const convertLinkVariables = (
  templateType: string,
  blocks: ReadonlyArray<StoredBlock>,
): ReadonlyArray<StoredBlock> | null => {
  const links = LINK_VARIABLES[templateType];
  if (!links) {
    return null;
  }
  const next = blocks.map((block) =>
    block.type === 'paragraph' && block.content !== undefined ? { ...block, content: convertDoc(block.content, links) } : block,
  );
  return canonical(next) === canonical(blocks) ? null : next;
};

interface VersionRow {
  readonly id: string;
  readonly template_type: string;
  readonly version: number;
  readonly subject: string;
  readonly blocks: ReadonlyArray<StoredBlock>;
  readonly placeholders: ReadonlyArray<string>;
  readonly is_active: boolean;
  readonly created_by: string | null;
  readonly activated_by: string | null;
  readonly has_body: boolean;
}

const SELECT_VERSIONS = `
  SELECT id, template_type, version, subject, blocks, placeholders, is_active, created_by, activated_by,
         body IS NOT NULL AS has_body
  FROM email_template`;

export class EmailLinkVariablesAsLinks1767225840000 implements MigrationInterface {
  name = 'EmailLinkVariablesAsLinks1767225840000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const active = (await queryRunner.query(`${SELECT_VERSIONS} WHERE is_active ORDER BY template_type`)) as VersionRow[];
    for (const row of active) {
      const blocks = convertLinkVariables(row.template_type, row.blocks);
      if (blocks === null) {
        continue;
      }
      await queryRunner.query(`UPDATE email_template SET is_active = FALSE WHERE id = $1`, [row.id]);
      await queryRunner.query(
        `INSERT INTO email_template
           (template_type, version, subject, blocks, placeholders, is_active, created_at, created_by, activated_at, activated_by)
         SELECT $1::varchar, max(version) + 1, $2, $3::jsonb, $4::jsonb, TRUE, now(), NULL, now(), NULL
         FROM email_template WHERE template_type = $1::varchar`,
        [row.template_type, row.subject, JSON.stringify(blocks), JSON.stringify(row.placeholders)],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`${SELECT_VERSIONS} ORDER BY template_type, version DESC`)) as VersionRow[];
    const created = rows.filter((row) => row.created_by === null && row.activated_by === null && !row.has_body);
    for (const row of created) {
      const source = rows.find((other) => {
        if (other.template_type !== row.template_type || other.id === row.id || other.subject !== row.subject) {
          return false;
        }
        const converted = convertLinkVariables(other.template_type, other.blocks);
        return converted !== null && canonical(converted) === canonical(row.blocks);
      });
      if (!source) {
        continue;
      }
      await queryRunner.query(`DELETE FROM email_template WHERE id = $1`, [row.id]);
      if (row.is_active) {
        await queryRunner.query(`UPDATE email_template SET is_active = TRUE WHERE id = $1`, [source.id]);
      }
    }
  }
}
