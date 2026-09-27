import { ApiProperty } from '@nestjs/swagger';
import { STORAGE_DRIVERS } from '../../../modules/documents/dto/document.responses.js';
import { S3_PROVIDERS } from './update-storage-settings.dto.js';

/**
 * Respuesta de GET /storage, GET /storage/status, PATCH /storage y PATCH /storage/settings. Documenta lo que
 * devuelve StorageService.status: cambiar un shape exige cambiar ambos.
 *
 * Las credenciales nunca salen, ni en claro, ni cifradas, ni parciales. Solo se informa si hay una guardada con los
 * indicadores `*Set` (o `*Connected` para los refresh token OAuth). Contrato de guardado (PATCH): una credencial
 * ausente, null, vacía o con el marcador `****` conserva la guardada; solo un valor nuevo la reemplaza.
 */
export class StorageStatusDto {
  @ApiProperty({
    enum: STORAGE_DRIVERS,
    enumName: 'DocumentStorageDriver',
    description: 'Driver activo',
  })
  readonly driver!: (typeof STORAGE_DRIVERS)[number];

  @ApiProperty({
    description:
      'Carpeta del almacenamiento local, fijada al desplegar con STORAGE_PROJECT_PATH (solo lectura)',
  })
  readonly projectPath!: string;

  @ApiProperty({ enum: S3_PROVIDERS, enumName: 'StorageS3Provider' })
  readonly s3Provider!: (typeof S3_PROVIDERS)[number];

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'null: endpoint por defecto del proveedor',
  })
  readonly s3Endpoint!: string | null;

  @ApiProperty()
  readonly s3Region!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly s3Bucket!: string | null;

  @ApiProperty({
    description:
      'Valor guardado de "forzar path style" (MinIO y otros S3 que atienden el bucket en la ruta)',
  })
  readonly s3ForcePathStyle!: boolean;

  @ApiProperty({
    description:
      'true si hay una clave de acceso S3 guardada. Nunca se devuelve el valor',
  })
  readonly s3AccessKeySet!: boolean;

  @ApiProperty({
    description:
      'true si hay una clave secreta S3 guardada. Nunca se devuelve el valor',
  })
  readonly s3SecretKeySet!: boolean;

  @ApiProperty({
    description:
      'true si hay refresh token de Google Drive (la cuenta quedó conectada por OAuth)',
  })
  readonly googleConnected!: boolean;

  @ApiProperty({
    description:
      'true si hay refresh token de OneDrive (la cuenta quedó conectada por OAuth)',
  })
  readonly onedriveConnected!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Client ID de Google enmascarado (dos primeros y dos últimos caracteres, p. ej. "cl****le")',
  })
  readonly googleClientId!: string | null;

  @ApiProperty({
    description:
      'true si hay un Client Secret de Google guardado. Nunca se devuelve el valor',
  })
  readonly googleClientSecretSet!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'ID de la carpeta de Google Drive',
  })
  readonly googleFolderId!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Client ID de OneDrive enmascarado',
  })
  readonly onedriveClientId!: string | null;

  @ApiProperty({
    description:
      'true si hay un Client Secret de OneDrive guardado. Nunca se devuelve el valor',
  })
  readonly onedriveClientSecretSet!: boolean;

  @ApiProperty({
    description:
      'true si el driver activo es Google Drive u OneDrive y aún no está conectado',
  })
  readonly needsOauth!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Siempre null: el state OAuth es de un solo uso y va ligado a una cookie, así que solo lo emiten los endpoints oauth/{google,onedrive}/start',
  })
  readonly authorizationUrl!: string | null;
}
