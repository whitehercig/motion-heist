import { STRINGS, type StringKey } from './strings'

export type Lang = 'ru' | 'en'
export type { StringKey }

const STORAGE_KEY = 'motion-heist-lang'
const LANG_INDEX: Record<Lang, 0 | 1> = { en: 0, ru: 1 }

const readStoredLang = (): Lang => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'en' || stored === 'ru' ? stored : 'ru'
  } catch {
    return 'ru'
  }
}

let current: Lang = readStoredLang()
const listeners = new Set<() => void>()

const syncDocument = () => {
  try {
    document.documentElement.lang = current
  } catch {
    // No document (tests / SSR): nothing to sync.
  }
}
syncDocument()

export const getLang = () => current

export const setLang = (lang: Lang) => {
  if (lang === current) return
  current = lang
  try {
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Storage blocked: the choice still holds for this session.
  }
  syncDocument()
  listeners.forEach((listener) => listener())
}

export const subscribeLang = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export type Params = Record<string, string | number>

/**
 * Module-level translate: callable from React, canvas render loops and plain
 * modules (the error analyzer) alike. `{name}` placeholders are filled from params.
 */
export const t = (key: StringKey, params?: Params): string => {
  const template: string = STRINGS[key][LANG_INDEX[current]]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Russian needs three plural forms (1 аномалия, 2 аномалии, 5 аномалий); English two. */
export const plural = (count: number, one: StringKey, few: StringKey, many: StringKey) => {
  if (current === 'en') return t(count === 1 ? one : many, { n: count })
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return t(one, { n: count })
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return t(few, { n: count })
  return t(many, { n: count })
}
