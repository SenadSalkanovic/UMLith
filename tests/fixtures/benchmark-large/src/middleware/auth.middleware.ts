import { UserDto } from '../models/types';

export interface RequestContext {
  user?: UserDto;
  tenantId?: string;
}

export function requireAuth(ctx: RequestContext): UserDto {
  if (!ctx.user) {
    throw new Error('Unauthorized');
  }
  return ctx.user;
}

export function requireRole(ctx: RequestContext, allowedRoles: UserDto['role'][]): void {
  const user = requireAuth(ctx);
  if (!allowedRoles.includes(user.role)) {
    throw new Error('Forbidden: insufficient permissions');
  }
}
