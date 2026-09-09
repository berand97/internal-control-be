import { Module } from '@nestjs/common';
import { HashService } from './hash.service.js';
import { SecretCipherService } from './secret-cipher.service.js';

@Module({
  providers: [HashService, SecretCipherService],
  exports: [HashService, SecretCipherService],
})
export class CryptoModule {}
