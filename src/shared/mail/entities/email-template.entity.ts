import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
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

  @Column({ name: 'body', type: 'text' })
  body!: string;

  @Column({ name: 'placeholders', type: 'jsonb' })
  placeholders!: ReadonlyArray<string>;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;
}
