import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { DocumentType } from '../domain/placeholder-catalog.js';

@Entity('document_template')
export class DocumentTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'document_type', type: 'varchar', length: 40 })
  documentType!: DocumentType;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'file_hash', type: 'varchar', length: 64 })
  fileHash!: string;

  @Column({ name: 'original_filename', type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ name: 'placeholders', type: 'jsonb' })
  placeholders!: ReadonlyArray<string>;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}

@Entity('generated_document')
export class GeneratedDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'document_type', type: 'varchar', length: 40 })
  documentType!: DocumentType;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'file_hash', type: 'varchar', length: 64 })
  fileHash!: string;

  @Column({ name: 'act_number', type: 'varchar', length: 40 })
  actNumber!: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 40 })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}
