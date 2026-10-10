export function processItem(item: string): void {}
export function recordFailure(error: unknown): void {}
export function logItem(item: string): void {}
export function performAction(action: string): string {
  return action;
}
export function handleError(error: unknown): void {}

export interface IWorkflowService {
  describeWorkflow(name: string): string;
}

export function processItems(items: string[]): number {
  let processed = 0;
  for (const item of items) {
    if (item.length > 0) {
      logItem(item);
      processed = processed + 1;
    }
  }
  return processed;
}

export function executeWithRecovery(action: string): string {
  try {
    if (action === 'fail') {
      throw new Error('Action failed');
    }
    return performAction(action);
  } catch (err) {
    handleError(err);
    return 'recovered';
  }
}

export function runWorkflow(batches: string[][]): string {
  try {
    for (const batch of batches) {
      if (batch.length === 0) {
        throw new Error('Empty batch');
      }
      for (const item of batch) {
        if (item === 'poison') {
          throw new Error('Poison pill');
        }
        processItem(item);
      }
    }
    return 'completed';
  } catch (error) {
    recordFailure(error);
    return 'failed';
  }
}

export function unsupportedWorkflow(code: number): string {
  switch (code) {
    case 1:
      return 'one';
    default:
      return 'other';
  }
}
