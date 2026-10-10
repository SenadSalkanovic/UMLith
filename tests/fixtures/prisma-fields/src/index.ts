export interface UserDTO {
  id: number;
  email: string;
  name?: string;
  role: string;
  active: boolean;
}

export function formatUserDTO(user: UserDTO): string {
  return `${user.id}: ${user.name ?? 'anonymous'} <${user.email}> [${user.role}]`;
}
