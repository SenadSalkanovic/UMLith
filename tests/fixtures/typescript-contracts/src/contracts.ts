export interface Identifiable<TKey = string> {
  id: TKey;
  displayName?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Queryable<T> {
  query(id: string): Promise<T | null>;
  query(ids: string[]): Promise<T[]>;
  query(filter: { tag: string }, limit?: number): Promise<T[]>;
}

export interface Transformer<TInput, TOutput> {
  (input: TInput, options?: { strict?: boolean }): TOutput;
}

export interface Builder<TInstance> {
  new (initialConfig?: Record<string, unknown>): TInstance;
}

export function formatValue(value: string): string;
export function formatValue(value: number, precision?: number): string;
export function formatValue(value: string | number, precision?: number): string {
  return typeof value === 'number' ? value.toFixed(precision ?? 2) : String(value);
}

export function processBatch<T extends Identifiable<string>>(
  items: T[],
  batchSize: number = 10,
  options?: { dryRun?: boolean }
): Promise<{ processed: T[]; count: number }> {
  return Promise.resolve({ processed: items.slice(0, batchSize), count: items.length });
}

export const transformList = <T, R>(list: T[], mapper?: (item: T) => R): R[] => {
  return mapper ? list.map(mapper) : [];
};

export interface Item extends Identifiable<string> {
  name: string;
  price?: number;
}

export class ItemService implements Queryable<Item> {
  private _active: boolean = true;
  constructor(public readonly region?: string) {}

  get active(): boolean {
    return this._active;
  }
  set active(val: boolean) {
    this._active = val;
  }

  async query(id: string): Promise<Item | null>;
  async query(ids: string[]): Promise<Item[]>;
  async query(filter: { tag: string }, limit?: number): Promise<Item[]>;
  async query(arg: string | string[] | { tag: string }, limit?: number): Promise<Item | null | Item[]> {
    return null;
  }

  validateItem = (item: Item, checkPrice?: boolean): boolean => {
    return Boolean(item.id && (!checkPrice || item.price !== undefined));
  };
}
