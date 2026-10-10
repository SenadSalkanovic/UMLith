export interface AppUser {
  id: number;
  email: string;
}

export function formatUser(user: AppUser): string {
  return `${user.id}:${user.email}`;
}
