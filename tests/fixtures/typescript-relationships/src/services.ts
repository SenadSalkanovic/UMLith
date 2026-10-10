import { Auditable as AliasedAuditable, BaseModel as AliasedBaseModel } from './models';
import { computeTax, constrainValue, stringFormatter } from './reexport';
import * as MathUtils from './utils';
import defaultFormatter from './utils';

export interface IOrderProcessor {
  processOrder(orderId: string, amount: number): boolean;
}

export class Repository<T> extends AliasedBaseModel {
  find(id: string): T | null {
    return null;
  }
}

export class OrderRepository extends Repository<{ orderId: string }> {
  override find(id: string): { orderId: string } | null {
    return { orderId: id };
  }
}

export class OrderService extends AliasedBaseModel implements IOrderProcessor, AliasedAuditable {
  createdAt: string = '2026-01-01';
  updatedAt: string = '2026-01-02';

  private repository = new OrderRepository();

  processOrder(orderId: string, amount: number): boolean {
    const tax = computeTax(amount, 0.2);
    const clampedAmount = constrainValue(amount + tax, 0, 10000);
    const formatted = stringFormatter(orderId);
    defaultFormatter(formatted);
    MathUtils.calculateTax(clampedAmount, 0.05);

    const existing = this.repository.find(orderId);
    this['validateStatus']();

    return existing !== null;
  }

  validateStatus(): boolean {
    return true;
  }

  static createDefault(): OrderService {
    return new OrderService();
  }
}
