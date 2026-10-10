import { Priority, Auditable, TaskHandler } from './models';

export const formatPriority = (priority: Priority): string => {
  return priority.toLowerCase();
};

export function processInput(input: string): string;
export function processInput(input: number): number;
export function processInput(input: string | number): string | number {
  if (typeof input === 'string') {
    return input.trim();
  }
  return input * 2;
}

export class BaseService implements Auditable {
  id = 'base-1';
  createdAt = '2026-01-01';

  constructor(public name: string) {}

  getName(): string {
    return this.name;
  }
}

export class TaskService extends BaseService implements TaskHandler {
  private _status = 'idle';

  get status(): string {
    return this._status;
  }

  set status(val: string) {
    this._status = val;
  }

  validator = (task: string): boolean => {
    return task.length > 0;
  };

  handle(task: string): boolean;
  handle(tasks: string[]): boolean;
  handle(taskOrTasks: string | string[]): boolean {
    if (Array.isArray(taskOrTasks)) {
      return taskOrTasks.every(t => this.validator(t));
    }
    return this.validator(taskOrTasks);
  }

  static Helper = class Helper {
    static format(text: string): string {
      return text.toUpperCase();
    }
  };

  createRunner() {
    class LocalRunner {
      run(): string {
        return 'running';
      }
    }
    const runner = new LocalRunner();
    return runner.run();
  }
}

export { Priority } from './models';
