import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoModule } from '../../shared/crypto/crypto.module.js';
import { MailModule } from '../../shared/mail/mail.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AppUser } from '../auth/entities/app-user.entity.js';
import { Person } from '../auth/entities/person.entity.js';
import { Role } from '../auth/entities/role.entity.js';
import { UserRole } from '../auth/entities/user-role.entity.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { LoansModule } from '../loans/loans.module.js';
import { OrganizationalUnitsModule } from '../organizational-units/organizational-units.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { TypeOrmUsersRepository } from './repositories/users.repository.js';
import { UsersService } from './services/users.service.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    AuthModule,
    RolesModule,
    OrganizationalUnitsModule,
    CostCentersModule,
    LoansModule,
    CryptoModule,
    MailModule,
    TypeOrmModule.forFeature([Person, AppUser, Role, UserRole]),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: 'UsersRepository', useClass: TypeOrmUsersRepository },
  ],
  exports: [UsersService],
})
export class UsersModule {}
