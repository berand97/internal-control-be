import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('mail_settings')
export class MailSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'host', type: 'text', nullable: true })
  host!: string | null;

  @Column({ name: 'port', type: 'int' })
  port!: number;

  @Column({ name: 'secure', type: 'boolean' })
  secure!: boolean;

  @Column({ name: 'username', type: 'text', nullable: true })
  username!: string | null;

  @Column({ name: 'password', type: 'text', nullable: true })
  password!: string | null;

  @Column({ name: 'from_name', type: 'text', nullable: true })
  fromName!: string | null;

  @Column({ name: 'from_email', type: 'text', nullable: true })
  fromEmail!: string | null;

  @Column({ name: 'enabled', type: 'boolean' })
  enabled!: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;
}
