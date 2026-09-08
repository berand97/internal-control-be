import type { Request } from 'express';
import type { AuthenticatedUser } from './authenticated-user.type.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
