import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { parseDriveFolderId } from '../parse-drive-folder-id.js';

const DRIVERS = ['project', 's3', 'google_drive', 'onedrive'] as const;
const S3_PROVIDERS = [
  'aws',
  'minio',
  'digitalocean',
  'cloudflare',
  'custom',
] as const;

const emptyToNull = ({ value }: { value: unknown }): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
};

export class GoogleStorageCredentialsDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientSecret?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly folderId?: string | null;
}

export class OnedriveStorageCredentialsDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly tenantId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientSecret?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly folderId?: string | null;
}

export class UpdateStorageSettingsDto {
  @ApiPropertyOptional({
    enum: DRIVERS,
    description: 'También acepta google → google_drive y microsoft → onedrive',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'google' || value === 'google-drive') {
      return 'google_drive';
    }
    if (value === 'microsoft' || value === 'ms' || value === 'one-drive') {
      return 'onedrive';
    }
    return value;
  })
  @IsIn(DRIVERS)
  readonly driver?: (typeof DRIVERS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly projectPath?: string;

  @ApiPropertyOptional({ enum: S3_PROVIDERS })
  @IsOptional()
  @IsIn(S3_PROVIDERS)
  readonly s3Provider?: (typeof S3_PROVIDERS)[number];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly s3Endpoint?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly s3Region?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly s3Bucket?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly s3AccessKey?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly s3SecretKey?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly s3ForcePathStyle?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly googleClientId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly googleClientSecret?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly googleFolderId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Alias de googleFolderId si el driver no es onedrive',
  })
  @IsOptional()
  @Transform(emptyToNull)
  readonly folderId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Alias de googleClientId si driver es google_drive',
  })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Alias de googleClientSecret si driver es google_drive',
  })
  @IsOptional()
  @Transform(emptyToNull)
  readonly clientSecret?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly onedriveTenantId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly onedriveClientId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly onedriveClientSecret?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  readonly onedriveFolderId?: string | null;

  @ApiPropertyOptional({ type: GoogleStorageCredentialsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GoogleStorageCredentialsDto)
  readonly google?: GoogleStorageCredentialsDto;

  @ApiPropertyOptional({ type: OnedriveStorageCredentialsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnedriveStorageCredentialsDto)
  readonly onedrive?: OnedriveStorageCredentialsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly provider?: string;

  @Allow()
  readonly googleConnected?: unknown;

  @Allow()
  readonly onedriveConnected?: unknown;

  @Allow()
  readonly needsOauth?: unknown;

  @Allow()
  readonly authorizationUrl?: unknown;
}

const isMaskedSecret = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.includes('****');

const firstUnmasked = (
  ...values: ReadonlyArray<string | null | undefined>
): string | null | undefined => {
  for (const value of values) {
    if (value === undefined || isMaskedSecret(value)) {
      continue;
    }
    return value;
  }
  return undefined;
};

const patchIfPresent = (
  value: string | null | undefined,
): { readonly include: boolean; readonly value: string | null } => ({
  include: value !== undefined,
  value: value ?? null,
});

export const flattenStoragePatch = (dto: UpdateStorageSettingsDto) => {
  const googleAlias = dto.driver === 'onedrive' ? undefined : dto.clientId;
  const googleSecretAlias =
    dto.driver === 'onedrive' ? undefined : dto.clientSecret;
  const onedriveAlias = dto.driver === 'onedrive' ? dto.clientId : undefined;
  const onedriveSecretAlias =
    dto.driver === 'onedrive' ? dto.clientSecret : undefined;
  const googleClientId = firstUnmasked(
    dto.googleClientId,
    dto.google?.clientId,
    googleAlias,
  );
  const googleClientSecret = firstUnmasked(
    dto.googleClientSecret,
    dto.google?.clientSecret,
    googleSecretAlias,
  );
  const googleFolderId = parseDriveFolderId(
    firstUnmasked(
      dto.googleFolderId,
      dto.google?.folderId,
      dto.driver === 'onedrive' ? undefined : dto.folderId,
    ),
  );
  const onedriveTenantId = firstUnmasked(
    dto.onedriveTenantId,
    dto.onedrive?.tenantId,
  );
  const onedriveClientId = firstUnmasked(
    dto.onedriveClientId,
    dto.onedrive?.clientId,
    onedriveAlias,
  );
  const onedriveClientSecret = firstUnmasked(
    dto.onedriveClientSecret,
    dto.onedrive?.clientSecret,
    onedriveSecretAlias,
  );
  const onedriveFolderId = firstUnmasked(
    dto.onedriveFolderId,
    dto.onedrive?.folderId,
  );
  const googleIdPatch = patchIfPresent(googleClientId);
  const googleSecretPatch = patchIfPresent(googleClientSecret);
  const googleFolderPatch = patchIfPresent(googleFolderId);
  const onedriveTenantPatch = patchIfPresent(onedriveTenantId);
  const onedriveIdPatch = patchIfPresent(onedriveClientId);
  const onedriveSecretPatch = patchIfPresent(onedriveClientSecret);
  const onedriveFolderPatch = patchIfPresent(onedriveFolderId);
  return {
    ...(dto.driver !== undefined ? { driver: dto.driver } : {}),
    ...(dto.projectPath !== undefined ? { projectPath: dto.projectPath } : {}),
    ...(dto.s3Provider !== undefined ? { s3Provider: dto.s3Provider } : {}),
    ...(dto.s3Endpoint !== undefined ? { s3Endpoint: dto.s3Endpoint } : {}),
    ...(dto.s3Region !== undefined ? { s3Region: dto.s3Region } : {}),
    ...(dto.s3Bucket !== undefined ? { s3Bucket: dto.s3Bucket } : {}),
    ...(dto.s3AccessKey !== undefined ? { s3AccessKey: dto.s3AccessKey } : {}),
    ...(dto.s3SecretKey !== undefined ? { s3SecretKey: dto.s3SecretKey } : {}),
    ...(dto.s3ForcePathStyle !== undefined
      ? { s3ForcePathStyle: dto.s3ForcePathStyle }
      : {}),
    ...(googleIdPatch.include ? { googleClientId: googleIdPatch.value } : {}),
    ...(googleSecretPatch.include
      ? { googleClientSecret: googleSecretPatch.value }
      : {}),
    ...(googleFolderPatch.include
      ? { googleFolderId: googleFolderPatch.value }
      : {}),
    ...(onedriveTenantPatch.include
      ? { onedriveTenantId: onedriveTenantPatch.value }
      : {}),
    ...(onedriveIdPatch.include
      ? { onedriveClientId: onedriveIdPatch.value }
      : {}),
    ...(onedriveSecretPatch.include
      ? { onedriveClientSecret: onedriveSecretPatch.value }
      : {}),
    ...(onedriveFolderPatch.include
      ? { onedriveFolderId: onedriveFolderPatch.value }
      : {}),
  };
};
