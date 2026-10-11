export interface OrderDto {
  id: string;
  total: number;
}

export function validateOrder(order: OrderDto): boolean {
  return order.total > 0;
}

export async function processOrder(order: OrderDto): Promise<boolean> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order total');
  }
  return true;
}
