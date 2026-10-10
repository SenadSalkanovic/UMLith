import { MissingTarget } from './absent-module';

export function callMissing(): void {
  const target: MissingTarget = null as any;
  target.perform();
}
