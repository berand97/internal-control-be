import { SetMetadata } from '@nestjs/common';

export const FEATURE_CODE_KEY = 'featureCode';

export const Feature = (code: string): ClassDecorator & MethodDecorator =>
  SetMetadata(FEATURE_CODE_KEY, code);
