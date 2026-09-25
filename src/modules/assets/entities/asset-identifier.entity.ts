import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import {
  AssetIdentifierOrigin,
  AssetIdentifierType,
} from '../enums/asset-identifier.enum.js';

@Entity('asset_identifier')
export class AssetIdentifier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'identifier_type', type: 'varchar', length: 20 })
  identifierType!: AssetIdentifierType;

  @Column({ name: 'value', type: 'varchar', length: 100 })
  value!: string;

  @Column({ name: 'origin', type: 'varchar', length: 20 })
  origin!: AssetIdentifierOrigin;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom!: Date;

  @Column({ name: 'valid_to', type: 'timestamptz', nullable: true })
  validTo!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;
}
