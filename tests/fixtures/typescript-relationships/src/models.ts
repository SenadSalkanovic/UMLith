export interface Identifiable {
  id: string;
}

export interface Auditable extends Identifiable {
  createdAt: string;
  updatedAt: string;
}

export class BaseModel implements Identifiable {
  id: string = 'base-id';
}
