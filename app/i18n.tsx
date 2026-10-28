'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { resolveLocale, translate, type Locale, type MessageValues } from './lib/i18n';
import type { MessageKey } from './lib/messages';

const LANGUAGE_KEY = 'umlith-language';
const I18nContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: (key: MessageKey, values?: MessageValues) => string } | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, updateLocale] = useState<Locale>('sl');
  const [ready, setReady] = useState(false);
  const t = useCallback((key: MessageKey, values?: MessageValues) => translate(locale, key, values), [locale]);
  useEffect(() => {
    queueMicrotask(() => {
      let language = resolveLocale(navigator.language);
      try { const saved = localStorage.getItem(LANGUAGE_KEY); if (saved === 'sl' || saved === 'en') language = saved; } catch { /* Language selection still works without storage. */ }
      updateLocale(language); setReady(true);
    });
  }, []);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = locale;
    document.title = t('appTitle');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('appDescription'));
  }, [locale, ready, t]);
  function setLocale(next: Locale) {
    updateLocale(next);
    try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Keep the selected language for this page. */ }
  }
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{ready ? children : <main className="workspace" aria-busy="true"/>}</I18nContext.Provider>;
}
export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is required');
  return value;
}
