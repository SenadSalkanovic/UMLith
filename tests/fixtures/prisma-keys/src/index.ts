export interface OrderItemDTO {
  orderId: number;
  itemId: number;
  quantity: number;
  price: number;
  sku: string;
}

export function computeOrderItemTotal(item: OrderItemDTO): number {
  return item.quantity * item.price;
}
