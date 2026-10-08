export interface Order { id: string; total: number }
export function checkStock(items: string[]): boolean { return items.length > 0; }
export async function placeOrder(userId: string, items: string[]): Promise<Order> {
  if (items.length === 0) { throw new Error("Cart is empty"); }
  if (!checkStock(items)) { throw new Error("Insufficient stock"); }
  for (const item of items) { console.log(item); }
  return { id: userId, total: items.length * 10 };
}
