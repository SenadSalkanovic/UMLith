import { ProductDto } from '../models/types';
import { logInfo } from '../utils/logger';

export function checkStockAvailability(product: ProductDto, requestedQty: number): boolean {
  return product.stock >= requestedQty;
}

export function reserveInventory(product: ProductDto, qty: number): ProductDto {
  if (!checkStockAvailability(product, qty)) {
    throw new Error(`Insufficient stock for product ${product.sku}`);
  }
  logInfo(`Reserved ${qty} units of ${product.sku}`);
  return { ...product, stock: product.stock - qty };
}
