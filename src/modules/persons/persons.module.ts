import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module.js';
import { PersonsController } from './persons.controller.js';
import { PersonDirectoryService } from './services/person-directory.service.js';

@Module({
  imports: [RolesModule],
  controllers: [PersonsController],
  providers: [PersonDirectoryService],
})
export class PersonsModule {}
