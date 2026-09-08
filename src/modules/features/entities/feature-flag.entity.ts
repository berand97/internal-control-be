import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('feature_flag')
export class FeatureFlag {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  code!: string;

  @Column({ type: 'boolean' })
  enabled!: boolean;

  @Column({ name: 'disabled_reason', type: 'varchar', length: 20, nullable: true })
  disabledReason!: string | null;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
