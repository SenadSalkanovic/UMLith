import { UserSummary, formatUserName, validateEmail } from './user.service';

export function createUserSummary(id: number, email: string, name?: string): UserSummary {
  if (!validateEmail(email)) {
    throw new Error('Invalid email');
  }
  return { id, email, name };
}

export function greetUser(user: UserSummary): string {
  return `Hello, ${formatUserName(user)}!`;
}
