export function calculateTax(amount: number, rate: number): number {
  return amount * rate;
}

export const clamp = (val: number, min: number, max: number): number => {
  return Math.min(Math.max(val, min), max);
};

export default function defaultFormatter(val: string): string {
  return val.trim().toLowerCase();
}
