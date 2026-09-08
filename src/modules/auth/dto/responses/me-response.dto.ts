import { ApiProperty } from '@nestjs/swagger';
import { applyFeatureFlags } from '../../../../common/authorization/apply-feature-flags.js';
import { buildAccessProfile } from '../../../../common/authorization/build-access-profile.js';
import type { GrantedPermission } from '../../../../common/authorization/granted-permission.type.js';
import type { TokenScope } from '../../../../common/types/authenticated-user.type.js';
import type { FeatureSnapshot } from '../../../features/feature-catalog.js';
import { FeatureResponseDto } from '../../../features/dto/feature.response.dto.js';
import type { AppUser } from '../../entities/app-user.entity.js';
import type { AuditLog } from '../../entities/audit-log.entity.js';
import { LoginEventResponseDto } from './login-event.response.dto.js';
import { NavigationItemResponseDto } from './navigation-item.response.dto.js';
import { ResourceCapabilityResponseDto } from './resource-capability.response.dto.js';
import { TokenScopeResponseDto } from './token-scope.response.dto.js';

export class MeResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Identificador del usuario' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombre de usuario', example: 'juliana.perez' })
  readonly username!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Identificador de la persona asociada',
  })
  readonly personId!: string;

  @ApiProperty({
    description: 'Nombre completo de la persona',
    example: 'Juliana Pérez',
  })
  readonly fullName!: string;

  @ApiProperty({
    description: 'Correo electrónico institucional (dominio @unac.edu.co)',
    example: 'juliana.perez@unac.edu.co',
  })
  readonly email!: string;

  @ApiProperty({
    description: 'Estado de la cuenta',
    enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_ACTIVATION'],
  })
  readonly status!: string;

  @ApiProperty({ description: 'Indica si el segundo factor está activado' })
  readonly mfaEnabled!: boolean;

  @ApiProperty({
    description:
      'True cuando la cuenta se creó por invitación y aún debe reemplazar la contraseña temporal',
  })
  readonly mustChangePassword!: boolean;

  @ApiProperty({
    description:
      'Códigos de roles activos. Solo informativo; la UI no debe ramificar por rol.',
    type: [String],
    example: ['INTERNAL_CONTROL_DIRECTOR'],
  })
  readonly roles!: ReadonlyArray<string>;

  @ApiProperty({
    description: 'Ámbitos activos derivados de los roles asignados',
    type: [TokenScopeResponseDto],
  })
  readonly scopes!: ReadonlyArray<TokenScopeResponseDto>;

  @ApiProperty({
    description: 'Últimos inicios de sesión exitosos (más recientes primero)',
    type: [LoginEventResponseDto],
  })
  readonly lastLogins!: ReadonlyArray<LoginEventResponseDto>;

  @ApiProperty({
    description: 'Códigos de permiso efectivos (compatibilidad)',
    type: [String],
  })
  readonly permissions!: ReadonlyArray<string>;

  @ApiProperty({
    description:
      'Acciones permitidas por recurso, ya filtradas si el módulo está apagado. Fuente de verdad para botones y guards de UI.',
    type: [ResourceCapabilityResponseDto],
  })
  readonly capabilities!: ReadonlyArray<ResourceCapabilityResponseDto>;

  @ApiProperty({
    description:
      'Menú ya filtrado por permisos y por módulos activos. El frontend solo renderiza; no decide por rol ni por flag.',
    type: [NavigationItemResponseDto],
  })
  readonly navigation!: ReadonlyArray<NavigationItemResponseDto>;

  @ApiProperty({
    description:
      'Estado de cada módulo. Si enabled=false, ocultar rutas y no llamar al API. Si llega MODULE_UNAVAILABLE, no mostrar toast.',
    type: [FeatureResponseDto],
  })
  readonly features!: ReadonlyArray<FeatureResponseDto>;

  static from(
    user: AppUser,
    roles: ReadonlyArray<string>,
    scopes: ReadonlyArray<TokenScope>,
    lastLogins: ReadonlyArray<AuditLog>,
    granted: ReadonlyArray<GrantedPermission>,
    features: ReadonlyArray<FeatureSnapshot>,
  ): MeResponseDto {
    const person = user.person;
    const access = applyFeatureFlags(buildAccessProfile(granted), features);
    return {
      id: user.id,
      username: user.username,
      personId: user.personId,
      fullName: person ? `${person.firstName} ${person.lastName}` : '',
      email: person?.email ?? '',
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword === true,
      roles,
      scopes: scopes.map((scope): TokenScopeResponseDto => ({
        type: scope.type,
        id: scope.id,
      })),
      lastLogins: lastLogins.map((entry): LoginEventResponseDto =>
        LoginEventResponseDto.from(entry),
      ),
      permissions: access.permissions,
      capabilities: access.capabilities.map(ResourceCapabilityResponseDto.from),
      navigation: access.navigation.map(NavigationItemResponseDto.from),
      features: features.map(FeatureResponseDto.from),
    };
  }
}
