import { CoreService, computeValue } from '@core/service';

export function handleRequest(val: number): string {
  const service = new CoreService();
  const doubled = computeValue(val);
  return `${service.execute()}:${doubled}`;
}
