export enum Priority {
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
}

export interface Identifiable {
  id: string;
}

export interface Auditable extends Identifiable {
  createdAt: string;
}

export interface TaskHandler {
  handle(task: string): boolean;
  handle(tasks: string[]): boolean;
}
