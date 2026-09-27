import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EmailBlock } from '../domain/email-blocks.js';
import type { EmailTemplateType } from '../domain/email-template-catalog.js';

/**
 * Versión de una plantilla de correo. Cada guardado crea una fila (version + 1); una sola activa por tipo
 * (índice único parcial uq_email_template_active). La columna legada `body` (texto de antes de los bloques) sigue en
 * la tabla, sin mapear, solo para que la migración 1767225800000 sea reversible sin pérdida.
 */
@Entity('email_template')
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'template_type', type: 'varchar', length: 40 })
  templateType!: EmailTemplateType;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'subject', type: 'varchar', length: 200 })
  subject!: string;

  @Column({ name: 'blocks', type: 'jsonb' })
  blocks!: ReadonlyArray<EmailBlock>;

  @Column({ name: 'placeholders', type: 'jsonb' })
  placeholders!: ReadonlyArray<string>;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ name: 'activated_by', type: 'uuid', nullable: true })
  activatedBy!: string | null;
}
