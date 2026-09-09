import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { FeatureGuard } from './common/guards/feature.guard.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { MustChangePasswordGuard } from './common/guards/must-change-password.guard.js';
import { FeatureCircuitInterceptor } from './common/interceptors/feature-circuit.interceptor.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MailModule } from './shared/mail/mail.module.js';
import { StorageModule } from './shared/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BuildingsModule } from './modules/buildings/buildings.module.js';
import { CampusModule } from './modules/campus/campus.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { CostCentersModule } from './modules/cost-centers/cost-centers.module.js';
import { DynamicFieldsModule } from './modules/dynamic-fields/dynamic-fields.module.js';
import { FeaturesModule } from './modules/features/features.module.js';
import { AssetsModule } from './modules/assets/assets.module.js';
import { QrTokensModule } from './modules/qr-tokens/qr-tokens.module.js';
import { MovementsModule } from './modules/movements/movements.module.js';
import { DocumentTemplatesModule } from './modules/document-templates/document-templates.module.js';
import { LoansModule } from './modules/loans/loans.module.js';
import { InventoriesModule } from './modules/inventories/inventories.module.js';
import { DepreciationModule } from './modules/depreciation/depreciation.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { OrganizationalUnitsModule } from './modules/organizational-units/organizational-units.module.js';
import { NavigationModule } from './modules/navigation/navigation.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const nestObserveImports =
  process.env['OBSERVE_APP_KEY'] && process.env['OBSERVE_APP_SECRET']
    ? [
        ObserveModule.forRoot({
          appKey: process.env['OBSERVE_APP_KEY'],
          appSecret: process.env['OBSERVE_APP_SECRET'],
          serviceId: 'control-interno-be',
        }),
      ]
    : [];

@Module({
  imports: [
    ...nestObserveImports,
    AppConfigModule,
    DatabaseModule,
    FeaturesModule,
    ScheduleModule.forRoot(),
    StorageModule,
    MailModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule,
    RolesModule,
    NavigationModule,
    UsersModule,
    CampusModule,
    BuildingsModule,
    LocationsModule,
    OrganizationalUnitsModule,
    CostCentersModule,
    CategoriesModule,
    DynamicFieldsModule,
    AssetsModule,
    QrTokensModule,
    MovementsModule,
    DocumentTemplatesModule,
    LoansModule,
    InventoriesModule,
    DepreciationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: FeatureCircuitInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
