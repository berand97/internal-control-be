import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EmailBlock } from '../domain/email-blocks.js';
import type { EmailTemplateType } from '../domain/email-template-catalog.js';

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
