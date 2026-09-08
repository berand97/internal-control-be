import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Role } from '../auth/entities/role.entity.js';
import { UserRole } from '../auth/entities/user-role.entity.js';
import { Permission } from './entities/permission.entity.js';
import { RolePermission } from './entities/role-permission.entity.js';
import { RoleSeparationOfDuties } from './entities/role-separation-of-duties.entity.js';
import { PermissionsController } from './permissions.controller.js';
import { RolesController } from './roles.controller.js';
import { TypeOrmPermissionsRepository } from './repositories/permissions.repository.js';
import { TypeOrmRolesRepository } from './repositories/roles.repository.js';
import { PermissionsCache } from './services/permissions-cache.service.js';
import { PermissionsService } from './services/permissions.service.js';
import { RolesService } from './services/roles.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      Role,
      UserRole,
      Permission,
      RolePermission,
      RoleSeparationOfDuties,
    ]),
  ],
  controllers: [RolesController, PermissionsController],
  providers: [
    PermissionsCache,
    PermissionsService,
    RolesService,
    { provide: 'PermissionsRepository', useClass: TypeOrmPermissionsRepository },
    { provide: 'RolesRepository', useClass: TypeOrmRolesRepository },
  ],
  exports: [PermissionsService, RolesService],
})
export class RolesModule {}
