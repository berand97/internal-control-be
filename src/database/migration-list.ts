import type { MigrationInterface } from 'typeorm';
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
import { UserInvitationTempPassword1767225611000 } from './migrations/1767225611000-user-invitation-temp-password.js';
import { AlignUserManageCapabilityAction1767225612000 } from './migrations/1767225612000-align-user-manage-capability-action.js';
import { RestoreRoleScopedNavigation1767225613000 } from './migrations/1767225613000-restore-role-scoped-navigation.js';
import { AdministrableNavigationAndPermissions1767225614000 } from './migrations/1767225614000-administrable-navigation-and-permissions.js';
import { PermissionResourceLabelsEs1767225615000 } from './migrations/1767225615000-permission-resource-labels-es.js';
import { RolePrivilegeHierarchyLevels1767225616000 } from './migrations/1767225616000-role-privilege-hierarchy-levels.js';
import { RoleSuperiorHierarchy1767225617000 } from './migrations/1767225617000-role-superior-hierarchy.js';
import { PersonAffiliationAndMailSettings1767225618000 } from './migrations/1767225618000-person-affiliation-and-mail-settings.js';
import { EmailTemplates1767225619000 } from './migrations/1767225619000-email-templates.js';
import { MailSettingsEncryptedText1767225620000 } from './migrations/1767225620000-mail-settings-encrypted-text.js';
import { PersonDocumentOptional1767225621000 } from './migrations/1767225621000-person-document-optional.js';
import { InvitationRoleToken1767225622000 } from './migrations/1767225622000-invitation-role-token.js';
import { RevokeDirectorStorage1767225623000 } from './migrations/1767225623000-revoke-director-storage.js';
import { AssetIdentifier1767225624000 } from './migrations/1767225624000-asset-identifier.js';
import { RelaxAssetConstraints1767225625000 } from './migrations/1767225625000-relax-asset-constraints.js';
import { ExcelStaging1767225626000 } from './migrations/1767225626000-excel-staging.js';
import { ExcelImport1767225627000 } from './migrations/1767225627000-excel-import.js';
import { DocumentEngine1767225628000 } from './migrations/1767225628000-document-engine.js';
import { AssetSearchIndexes1767225629000 } from './migrations/1767225629000-asset-search-indexes.js';
import { DocumentAssetLink1767225630000 } from './migrations/1767225630000-document-asset-link.js';
import { InternalSignature1767225631000 } from './migrations/1767225631000-internal-signature.js';
import { SignatureReassignment1767225632000 } from './migrations/1767225632000-signature-reassignment.js';
import { AssetConditionUnverified1767225633000 } from './migrations/1767225633000-asset-condition-unverified.js';
import { ReassignmentReissueHashes1767225634000 } from './migrations/1767225634000-reassignment-reissue-hashes.js';
import { DocumentLifecycle1767225635000 } from './migrations/1767225635000-document-lifecycle.js';
import { AssetHandover1767225640000 } from './migrations/1767225640000-asset-handover.js';
import { LoanDeliveryDocument1767225650000 } from './migrations/1767225650000-loan-delivery-document.js';
import { MfaRecovery1767225660000 } from './migrations/1767225660000-mfa-recovery.js';
import { SigningChannels1767225670000 } from './migrations/1767225670000-signing-channels.js';
import { PersonsImportAndCostCenterHeads1767225680000 } from './migrations/1767225680000-persons-import-and-cost-center-heads.js';
import { LoanSignaturesAndHandoverCancel1767225690000 } from './migrations/1767225690000-loan-signatures-and-handover-cancel.js';
import { ImportTemplates1767225710000 } from './migrations/1767225710000-import-templates.js';
import { ImportJobsAndMailOutbox1767225720000 } from './migrations/1767225720000-import-jobs-and-mail-outbox.js';
import { AdministrableDocumentFormats1767225730000 } from './migrations/1767225730000-administrable-document-formats.js';
import { NavigationIconsAndNewItems1767225740000 } from './migrations/1767225740000-navigation-icons-and-new-items.js';
import { RbacInheritanceHardening1767225750000 } from './migrations/1767225750000-rbac-inheritance-hardening.js';
import { AuthAttemptLockout1767225751000 } from './migrations/1767225751000-auth-attempt-lockout.js';
import { PersonEmailSingleLine1767225760000 } from './migrations/1767225760000-person-email-single-line.js';
import { InvitationExpiryAndTotpStep1767225770000 } from './migrations/1767225770000-invitation-expiry-and-totp-step.js';
import { EncryptMfaSecrets1767225771000 } from './migrations/1767225771000-encrypt-mfa-secrets.js';
import { StorageSecretsAndOauthState1767225780000 } from './migrations/1767225780000-storage-secrets-and-oauth-state.js';
import { EmailTemplateBlocks1767225800000 } from './migrations/1767225800000-email-template-blocks.js';
import { EmailTemplatesSuperAdmin1767225810000 } from './migrations/1767225810000-email-templates-super-admin.js';
import { EmailRichParagraphAndAssets1767225820000 } from './migrations/1767225820000-email-rich-paragraph-and-assets.js';
import { EmailAssetImagesPrefix1767225830000 } from './migrations/1767225830000-email-asset-images-prefix.js';
import { EmailLinkVariablesAsLinks1767225840000 } from './migrations/1767225840000-email-link-variables-as-links.js';
import { InventorySchedule1767225860000 } from './migrations/1767225860000-inventory-schedule.js';
import { InventoryFindingsAndCorrections1767225870000 } from './migrations/1767225870000-inventory-findings-and-corrections.js';
import { InventoryValuationSurplusAndAct1767225880000 } from './migrations/1767225880000-inventory-valuation-surplus-and-act.js';
import { CostCenterStructureHistory1767225890000 } from './migrations/1767225890000-cost-center-structure-history.js';
import { RevokeSuperAdminInventoryCatalog1767225895000 } from './migrations/1767225895000-revoke-super-admin-inventory-catalog.js';
import { RoleGrantsAuditPermission1767225900000 } from './migrations/1767225900000-role-grants-audit-permission.js';
import { RoleGrantsHistoryMenu1767225910000 } from './migrations/1767225910000-role-grants-history-menu.js';
import { AssetTransfersAndSignerSeparation1767225920000 } from './migrations/1767225920000-asset-transfers-and-signer-separation.js';
import { AssetRequests1767225930000 } from './migrations/1767225930000-asset-requests.js';
import { ControlSignerPermission1767225940000 } from './migrations/1767225940000-control-signer-permission.js';
import { EventStream1767225950000 } from './migrations/1767225950000-event-stream.js';
import { ScheduledLoansRequestReaderAndInventoryAttendee1767225980000 } from './migrations/1767225980000-scheduled-loans-request-reader-and-inventory-attendee.js';
import { RejectedScheduledLoansAndFindingCategories1767225990000 } from './migrations/1767225990000-rejected-scheduled-loans-and-finding-categories.js';
import { InventoryActsPerCostCenterAndPriceZero1767226000000 } from './migrations/1767226000000-inventory-acts-per-cost-center-and-price-zero.js';
import { CustodianRetirementLoanCancelAndSurplusCenter1767226010000 } from './migrations/1767226010000-custodian-retirement-loan-cancel-and-surplus-center.js';
import { OrgChartStructure1767226020000 } from './migrations/1767226020000-org-chart-structure.js';
import { UnitHeadCostCenterCode1767226030000 } from './migrations/1767226030000-unit-head-cost-center-code.js';
import { CostCenterPlacementMode1767226040000 } from './migrations/1767226040000-cost-center-placement-mode.js';
import { OrgChartImportConfirmedBy1767226050000 } from './migrations/1767226050000-org-chart-import-confirmed-by.js';
import { FeatureFlagNotify1767226060000 } from './migrations/1767226060000-feature-flag-notify.js';
import { OrgUnitColor1767226070000 } from './migrations/1767226070000-org-unit-color.js';

type MigrationClass = new () => MigrationInterface;

/**
 * Migraciones en orden de ejecución. La usan el CLI de TypeORM (data-source.ts) y la revisión de arranque
 * (pending-migrations.ts): una migración nueva se agrega aquí, al final.
 */
export const MIGRATIONS: ReadonlyArray<MigrationClass> = [
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
  UserInvitationTempPassword1767225611000,
  AlignUserManageCapabilityAction1767225612000,
  RestoreRoleScopedNavigation1767225613000,
  AdministrableNavigationAndPermissions1767225614000,
  PermissionResourceLabelsEs1767225615000,
  RolePrivilegeHierarchyLevels1767225616000,
  RoleSuperiorHierarchy1767225617000,
  PersonAffiliationAndMailSettings1767225618000,
  EmailTemplates1767225619000,
  MailSettingsEncryptedText1767225620000,
  PersonDocumentOptional1767225621000,
  InvitationRoleToken1767225622000,
  RevokeDirectorStorage1767225623000,
  AssetIdentifier1767225624000,
  RelaxAssetConstraints1767225625000,
  ExcelStaging1767225626000,
  ExcelImport1767225627000,
  DocumentEngine1767225628000,
  AssetSearchIndexes1767225629000,
  DocumentAssetLink1767225630000,
  InternalSignature1767225631000,
  SignatureReassignment1767225632000,
  AssetConditionUnverified1767225633000,
  ReassignmentReissueHashes1767225634000,
  DocumentLifecycle1767225635000,
  AssetHandover1767225640000,
  LoanDeliveryDocument1767225650000,
  MfaRecovery1767225660000,
  SigningChannels1767225670000,
  PersonsImportAndCostCenterHeads1767225680000,
  LoanSignaturesAndHandoverCancel1767225690000,
  ImportTemplates1767225710000,
  ImportJobsAndMailOutbox1767225720000,
  AdministrableDocumentFormats1767225730000,
  NavigationIconsAndNewItems1767225740000,
  RbacInheritanceHardening1767225750000,
  AuthAttemptLockout1767225751000,
  PersonEmailSingleLine1767225760000,
  InvitationExpiryAndTotpStep1767225770000,
  EncryptMfaSecrets1767225771000,
  StorageSecretsAndOauthState1767225780000,
  EmailTemplateBlocks1767225800000,
  EmailTemplatesSuperAdmin1767225810000,
  EmailRichParagraphAndAssets1767225820000,
  EmailAssetImagesPrefix1767225830000,
  EmailLinkVariablesAsLinks1767225840000,
  InventorySchedule1767225860000,
  InventoryFindingsAndCorrections1767225870000,
  InventoryValuationSurplusAndAct1767225880000,
  CostCenterStructureHistory1767225890000,
  RevokeSuperAdminInventoryCatalog1767225895000,
  RoleGrantsAuditPermission1767225900000,
  RoleGrantsHistoryMenu1767225910000,
  AssetTransfersAndSignerSeparation1767225920000,
  AssetRequests1767225930000,
  ControlSignerPermission1767225940000,
  EventStream1767225950000,
  ScheduledLoansRequestReaderAndInventoryAttendee1767225980000,
  RejectedScheduledLoansAndFindingCategories1767225990000,
  InventoryActsPerCostCenterAndPriceZero1767226000000,
  CustodianRetirementLoanCancelAndSurplusCenter1767226010000,
  OrgChartStructure1767226020000,
  UnitHeadCostCenterCode1767226030000,
  CostCenterPlacementMode1767226040000,
  OrgChartImportConfirmedBy1767226050000,
  FeatureFlagNotify1767226060000,
  OrgUnitColor1767226070000,
];
