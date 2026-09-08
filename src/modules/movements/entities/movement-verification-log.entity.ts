import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('movement_verification_log')
export class MovementVerificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'checked_at', type: 'timestamptz' })
  checkedAt!: Date;

  @Column({ name: 'assets_checked', type: 'int' })
  assetsChecked!: number;

  @Column({ name: 'failures', type: 'int' })
  failures!: number;

  @Column({ name: 'details', type: 'jsonb', nullable: true })
  details!: ReadonlyArray<{ readonly assetId: string; readonly movementId: string }> | null;
}
