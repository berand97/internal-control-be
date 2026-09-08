import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('asset_custom_value')
export class AssetCustomValue {
  @PrimaryColumn({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @PrimaryColumn({ name: 'field_id', type: 'uuid' })
  fieldId!: string;

  @Column({ name: 'value_text', type: 'text', nullable: true })
  valueText!: string | null;

  @Column({ name: 'value_number', type: 'numeric', nullable: true })
  valueNumber!: string | null;

  @Column({ name: 'value_date', type: 'date', nullable: true })
  valueDate!: string | null;

  @Column({ name: 'value_boolean', type: 'boolean', nullable: true })
  valueBoolean!: boolean | null;

  @Column({ name: 'value_json', type: 'jsonb', nullable: true })
  valueJson!: unknown;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
