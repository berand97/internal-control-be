import 'dotenv/config';
import { DataSource } from 'typeorm';
import { guardDatabaseUrl } from '../config/database-host-guard.js';
import { AppUser } from '../modules/auth/entities/app-user.entity.js';
import { AuditLog } from '../modules/auth/entities/audit-log.entity.js';
import { PasswordResetToken } from '../modules/auth/entities/password-reset-token.entity.js';
import { Person } from '../modules/auth/entities/person.entity.js';
import { RefreshTokenFamily } from '../modules/auth/entities/refresh-token-family.entity.js';
import { Role } from '../modules/auth/entities/role.entity.js';
import { UserRole } from '../modules/auth/entities/user-role.entity.js';
import { Building } from '../modules/buildings/entities/building.entity.js';
import { Campus } from '../modules/campus/entities/campus.entity.js';
import { AssetCategory } from '../modules/categories/entities/asset-category.entity.js';
import { CostCenter } from '../modules/cost-centers/entities/cost-center.entity.js';
import { AcquisitionType } from '../modules/assets/entities/acquisition-type.entity.js';
import { Asset } from '../modules/assets/entities/asset.entity.js';
import { AssetCustomValue } from '../modules/assets/entities/asset-custom-value.entity.js';
import { AssetIdentifier } from '../modules/assets/entities/asset-identifier.entity.js';
import { AssetPriceZeroReason } from '../modules/assets/entities/asset-price-zero-reason.entity.js';
import { AssetImportBatch } from '../modules/assets/entities/asset-import-batch.entity.js';
import { AssetMovement } from '../modules/assets/entities/asset-movement.entity.js';
import { AssetPhoto } from '../modules/assets/entities/asset-photo.entity.js';
import { QrTokenRotationLog } from '../modules/qr-tokens/entities/qr-token-rotation-log.entity.js';
import { EmailTemplate } from '../modules/email-templates/entities/email-template.entity.js';
import { EmailAsset } from '../modules/email-templates/entities/email-asset.entity.js';
import { MailSettings } from '../shared/mail/entities/mail-settings.entity.js';
import { StorageSettings } from '../shared/storage/entities/storage-settings.entity.js';
import { DocumentTemplate, GeneratedDocument } from '../modules/document-templates/entities/document-template.entity.js';
import { MovementVerificationLog } from '../modules/movements/entities/movement-verification-log.entity.js';
import { AssetLoan } from '../modules/loans/entities/asset-loan.entity.js';
import {
  AssetLoanEvent,
  AssetLoanItem,
  LoanAttachment,
} from '../modules/loans/entities/asset-loan-item.entity.js';
import { FeatureFlag } from '../modules/features/entities/feature-flag.entity.js';
import { AssetCategoryField } from '../modules/dynamic-fields/entities/asset-category-field.entity.js';
import { CostCenterSyncLog } from '../modules/cost-centers/entities/cost-center-sync-log.entity.js';
import { Location } from '../modules/locations/entities/location.entity.js';
import { OrganizationalUnit } from '../modules/organizational-units/entities/organizational-unit.entity.js';
import { Permission } from '../modules/roles/entities/permission.entity.js';
import { RolePermission } from '../modules/roles/entities/role-permission.entity.js';
import { RoleSeparationOfDuties } from '../modules/roles/entities/role-separation-of-duties.entity.js';
import { MIGRATIONS } from './migration-list.js';
import { NavigationItemEntity } from '../modules/navigation/entities/navigation-item.entity.js';
import { PhysicalInventory } from '../modules/inventories/entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../modules/inventories/entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from '../modules/inventories/entities/physical-inventory-scope.entity.js';
import { PhysicalInventoryAct } from '../modules/inventories/entities/physical-inventory-act.entity.js';
import { InventoryFindingCategory } from '../modules/inventories/entities/inventory-finding-category.entity.js';
import { InventoryMissingCause } from '../modules/inventories/entities/inventory-missing-cause.entity.js';
import { InventoryItemCorrection } from '../modules/inventories/entities/inventory-item-correction.entity.js';
import { AssetDepreciation } from '../modules/depreciation/entities/asset-depreciation.entity.js';

// El CLI de migraciones (y el de staging) no pasa por ConfigModule: misma guarda que la app.
// Fuera de producción se niega a conectarse a un host no local salvo ALLOW_REMOTE_DATABASE=true.
const databaseUrl = guardDatabaseUrl(
  process.env['DATABASE_URL'] ??
    'postgres://asset_admin:secret@localhost:5432/asset_management',
  process.env,
  (message) => console.warn(`[Database] ${message}`),
);

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  logging: process.env['DATABASE_LOGGING'] === 'true',
  synchronize: false,
  entities: [
    Person,
    AppUser,
    Role,
    UserRole,
    AuditLog,
    RefreshTokenFamily,
    PasswordResetToken,
    Permission,
    RolePermission,
    RoleSeparationOfDuties,
    Campus,
    Building,
    Location,
    OrganizationalUnit,
    CostCenter,
    CostCenterSyncLog,
    AssetCategory,
    AssetCategoryField,
    AcquisitionType,
    Asset,
    AssetCustomValue,
    AssetMovement,
    AssetPhoto,
    AssetImportBatch,
    AssetIdentifier,
    AssetPriceZeroReason,
    QrTokenRotationLog,
    StorageSettings,
    MailSettings,
    EmailTemplate,
    EmailAsset,
    DocumentTemplate,
    GeneratedDocument,
    MovementVerificationLog,
    AssetLoan,
    AssetLoanItem,
    AssetLoanEvent,
    LoanAttachment,
    PhysicalInventory,
    PhysicalInventoryItem,
    PhysicalInventoryScope,
    PhysicalInventoryAct,
    InventoryFindingCategory,
    InventoryMissingCause,
    InventoryItemCorrection,
    AssetDepreciation,
    FeatureFlag,
    NavigationItemEntity,
  ],
  migrations: [...MIGRATIONS],
});

export default dataSource;
