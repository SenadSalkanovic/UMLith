export type ID = string | number;

export interface TenantDto {
  id: string;
  name: string;
  domain: string;
}

export interface UserDto {
  id: number;
  tenantId: string;
  email: string;
  name?: string;
  role: 'ADMIN' | 'MANAGER' | 'CUSTOMER';
}

export interface ProductDto {
  id: number;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

export interface OrderItemDto {
  productId: number;
  quantity: number;
  unitPrice: number;
}

export interface OrderDto {
  id: number;
  userId: number;
  status: 'PENDING' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  items: OrderItemDto[];
  totalAmount: number;
}
