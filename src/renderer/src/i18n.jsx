import { createContext, useContext, useCallback, useMemo } from 'react'
// All string data + the pure lookup live in i18n-strings.js (kept React-free so
// the VSCode extension webview can bundle it); re-exported here so app code
// keeps its existing `from './i18n.jsx'` imports.
import { LANGS, STRINGS, DEFAULT_LANG, translate } from './i18n-strings.js'
export { LANGS, STRINGS, DEFAULT_LANG, translate }

const I18nContext = createContext({ lang: 'en', t: (k) => k, setLang: () => {} })
export const useI18n = () => useContext(I18nContext)

export function I18nProvider({ lang, setLang, children }) {
  // Stable t + memoized value: the provider re-runs on every App render, and a
  // fresh {lang,t,setLang} object here forces every useI18n consumer (Sidebar,
  // Tabs, StatusBar, palette, editors) to re-render per keystroke — defeating
  // their React.memo. Only a real language change should invalidate the context.
  const t = useCallback((key, vars) => translate(lang, key, vars), [lang])
  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
