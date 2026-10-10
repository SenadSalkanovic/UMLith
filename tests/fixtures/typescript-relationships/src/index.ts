import { OrderService, IOrderProcessor as AliasedOrderProcessor } from './services';

export function runWorkflow(): boolean {
  const service = OrderService.createDefault();
  const processor: AliasedOrderProcessor = service;
  return processor.processOrder('ORD-123', 500);
}
