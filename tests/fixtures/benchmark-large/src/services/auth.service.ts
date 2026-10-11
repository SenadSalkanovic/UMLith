import { UserDto } from '../models/types';
import { isValidEmail } from '../utils/validation';
import { logInfo } from '../utils/logger';

export function authenticate(email: string, token: string): boolean {
  if (!isValidEmail(email)) return false;
  return token.length > 8;
}

export function buildSessionToken(user: UserDto): string {
  logInfo(`Session token created for ${user.email}`);
  return `token_${user.id}_${Date.now()}`;
}
