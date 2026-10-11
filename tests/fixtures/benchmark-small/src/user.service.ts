export interface UserSummary {
  id: number;
  email: string;
  name?: string;
}

export function formatUserName(user: UserSummary): string {
  return user.name ?? user.email;
}

export function validateEmail(email: string): boolean {
  return email.includes('@') && email.includes('.');
}
