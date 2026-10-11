import { RequestContext, requireAuth } from '../middleware/auth.middleware';
import { registerUser, updateUserRole } from '../services/user.service';
import { UserDto } from '../models/types';

export function handleUserRegistration(email: string, tenantId: string, name?: string): UserDto {
  return registerUser(email, tenantId, name);
}

export function handleRoleChange(
  ctx: RequestContext,
  targetUser: UserDto,
  newRole: UserDto['role']
): UserDto {
  requireAuth(ctx);
  return updateUserRole(targetUser, newRole);
}
