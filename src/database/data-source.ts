import 'dotenv/config';
import { DataSource } from 'typeorm';
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
import { AssetImportBatch } from '../modules/assets/entities/asset-import-batch.entity.js';
import { AssetMovement } from '../modules/assets/entities/asset-movement.entity.js';
import { AssetPhoto } from '../modules/assets/entities/asset-photo.entity.js';
import { QrTokenRotationLog } from '../modules/qr-tokens/entities/qr-token-rotation-log.entity.js';
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
import { InitialSchema1767225600000 } from './migrations/1767225600000-initial-schema.js';
import { RbacExtended1767225601000 } from './migrations/1767225601000-rbac-extended.js';
import { RefreshTokenFamily1767225602000 } from './migrations/1767225602000-refresh-token-family.js';
import { PersonEmailUnacRequired1767225603000 } from './migrations/1767225603000-person-email-unac-required.js';
import { Phase1RolesUsers1767225604000 } from './migrations/1767225604000-phase1-roles-users.js';
import { Phase2Structure1767225605000 } from './migrations/1767225605000-phase2-structure.js';
import { Phase3Categories1767225606000 } from './migrations/1767225606000-phase3-categories.js';
import { Phase4Assets1767225607000 } from './migrations/1767225607000-phase4-assets.js';
import { Phase5MovementsLoans1767225608000 } from './migrations/1767225608000-phase5-movements-loans.js';
import { Phase6InventoriesDepreciation1767225609000 } from './migrations/1767225609000-phase6-inventories-depreciation.js';
import { FeatureFlags1767225610000 } from './migrations/1767225610000-feature-flags.js';
import { PhysicalInventory } from '../modules/inventories/entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../modules/inventories/entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from '../modules/inventories/entities/physical-inventory-scope.entity.js';
import { AssetDepreciation } from '../modules/depreciation/entities/asset-depreciation.entity.js';

const dataSource = new DataSource({
  type: 'postgres',
  url:
    process.env['DATABASE_URL'] ??
    'postgres://asset_admin:secret@localhost:5432/asset_management',
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
    QrTokenRotationLog,
    StorageSettings,
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
    AssetDepreciation,
    FeatureFlag,
  ],
  migrations: [
    InitialSchema1767225600000,
    RbacExtended1767225601000,
    RefreshTokenFamily1767225602000,
    PersonEmailUnacRequired1767225603000,
    Phase1RolesUsers1767225604000,
    Phase2Structure1767225605000,
    Phase3Categories1767225606000,
    Phase4Assets1767225607000,
    Phase5MovementsLoans1767225608000,
    Phase6InventoriesDepreciation1767225609000,
    FeatureFlags1767225610000,
  ],
});

export default dataSource;
