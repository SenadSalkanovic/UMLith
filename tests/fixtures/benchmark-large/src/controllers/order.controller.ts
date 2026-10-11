import { RequestContext, requireAuth } from '../middleware/auth.middleware';
import { OrderDto, OrderItemDto, ProductDto } from '../models/types';
import { createOrder } from '../services/order.service';

export function handleCreateOrder(
  ctx: RequestContext,
  items: OrderItemDto[],
  products: Map<number, ProductDto>
): OrderDto {
  const user = requireAuth(ctx);
  return createOrder(user, items, products);
}
