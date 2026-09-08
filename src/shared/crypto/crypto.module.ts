import { Module } from '@nestjs/common';
import { HashService } from './hash.service.js';

@Module({
  providers: [HashService],
  exports: [HashService],
})
export class CryptoModule {}
