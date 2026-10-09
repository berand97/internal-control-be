import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '../../shared/events/event-bus.module.js';
import { AuditLog } from '../auth/entities/audit-log.entity.js';
import { TypeOrmAuditLogsRepository } from '../auth/repositories/audit-logs.repository.js';
import { FeatureFlag } from './entities/feature-flag.entity.js';
import { FeaturesController } from './features.controller.js';
import { FeatureFlagsService } from './services/feature-flags.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FeatureFlag, AuditLog]), EventBusModule],
  controllers: [FeaturesController],
  // Auditoría del circuito (apertura y recuperación automática). Local: AuthModule ya depende de este módulo.
  providers: [FeatureFlagsService, { provide: 'AuditLogsRepository', useClass: TypeOrmAuditLogsRepository }],
  exports: [FeatureFlagsService],
})
export class FeaturesModule {}
