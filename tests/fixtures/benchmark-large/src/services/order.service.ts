import { OrderDto, OrderItemDto, ProductDto, UserDto } from '../models/types';
import { checkStockAvailability, reserveInventory } from './inventory.service';
import { notifyOrderPlaced } from './notification.service';
import { isPositiveNumber } from '../utils/validation';

export function calculateOrderTotal(items: OrderItemDto[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

export function createOrder(
  user: UserDto,
  items: OrderItemDto[],
  products: Map<number, ProductDto>
): OrderDto {
  if (items.length === 0) {
    throw new Error('Cannot create empty order');
  }
  for (const item of items) {
    if (!isPositiveNumber(item.quantity) || !isPositiveNumber(item.unitPrice)) {
      throw new Error('Invalid item quantity or price');
    }
    const product = products.get(item.productId);
    if (!product || !checkStockAvailability(product, item.quantity)) {
      throw new Error(`Product ${item.productId} unavailable`);
    }
    reserveInventory(product, item.quantity);
  }
  const totalAmount = calculateOrderTotal(items);
  const order: OrderDto = {
    id: Math.floor(Math.random() * 10000),
    userId: user.id,
    status: 'CONFIRMED',
    items,
    totalAmount,
  };
  notifyOrderPlaced(order.id, user.email);
  return order;
}
