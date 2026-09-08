import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY =
  'allowWhileMustChangePassword';

export const AllowWhileMustChangePassword = (): MethodDecorator =>
  SetMetadata(ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY, true);
