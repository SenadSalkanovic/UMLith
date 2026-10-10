export class CoreService {
  execute(): string {
    return 'executed-core';
  }
}

export function computeValue(input: number): number {
  return input * 2;
}
