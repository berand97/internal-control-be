import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoModule } from '../../shared/crypto/crypto.module.js';
import { MailModule } from '../../shared/mail/mail.module.js';
import { NavigationModule } from '../navigation/navigation.module.js';
import { AuthController } from './auth.controller.js';
import { AppUser } from './entities/app-user.entity.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { PasswordResetToken } from './entities/password-reset-token.entity.js';
import { Person } from './entities/person.entity.js';
import { RefreshTokenFamily } from './entities/refresh-token-family.entity.js';
import { Role } from './entities/role.entity.js';
import { UserRole } from './entities/user-role.entity.js';
import { TypeOrmAuditLogsRepository } from './repositories/audit-logs.repository.js';
import { TypeOrmAuthUsersRepository } from './repositories/auth-users.repository.js';
import { TypeOrmMfaCredentialsRepository } from './repositories/mfa-credentials.repository.js';
import { TypeOrmPasswordResetTokensRepository } from './repositories/password-reset-tokens.repository.js';
import { TypeOrmRefreshTokenFamiliesRepository } from './repositories/refresh-token-families.repository.js';
import { AuthService } from './services/auth.service.js';
import { MfaAccountService } from './services/mfa-account.service.js';
import { MfaService } from './services/mfa.service.js';
import { RefreshCookieService } from './services/refresh-cookie.service.js';
import { TokenService } from './services/token.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    PassportModule.register({ session: false }),
    CryptoModule,
    MailModule,
    NavigationModule,
    TypeOrmModule.forFeature([
      Person,
      AppUser,
      Role,
      UserRole,
      AuditLog,
      RefreshTokenFamily,
      PasswordResetToken,
    ]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    MfaService,
    MfaAccountService,
    RefreshCookieService,
    JwtStrategy,
    { provide: 'AuthUsersRepository', useClass: TypeOrmAuthUsersRepository },
    {
      provide: 'RefreshTokenFamiliesRepository',
      useClass: TypeOrmRefreshTokenFamiliesRepository,
    },
    { provide: 'AuditLogsRepository', useClass: TypeOrmAuditLogsRepository },
    {
      provide: 'MfaCredentialsRepository',
      useClass: TypeOrmMfaCredentialsRepository,
    },
    {
      provide: 'PasswordResetTokensRepository',
      useClass: TypeOrmPasswordResetTokensRepository,
    },
  ],
  exports: [
    AuthService,
    MfaAccountService,
    'AuthUsersRepository',
    'RefreshTokenFamiliesRepository',
    'AuditLogsRepository',
    'PasswordResetTokensRepository',
    TypeOrmModule,
  ],
})
export class AuthModule {}
