import { sl, en, type MessageKey } from './messages.ts';

export type Locale = 'sl' | 'en';
export type MessageValues = Record<string, string | number>;
export const messages = { sl, en };
export function resolveLocale(value: unknown): Locale { return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'sl'; }
export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}
export function errorText(error: unknown, locale: Locale): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = (Object.keys(sl) as MessageKey[]).find(key => sl[key] === message || en[key] === message);
  return key ? translate(locale, key) : message;
}
