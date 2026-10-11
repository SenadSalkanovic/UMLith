import { UserDto } from '../models/types';
import { isValidEmail } from '../utils/validation';

export function registerUser(email: string, tenantId: string, name?: string): UserDto {
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address');
  }
  return {
    id: Math.floor(Math.random() * 10000),
    tenantId,
    email,
    name,
    role: 'CUSTOMER',
  };
}

export function updateUserRole(user: UserDto, newRole: UserDto['role']): UserDto {
  return { ...user, role: newRole };
}
