import { useSyncExternalStore } from 'react'
import { getLang, subscribeLang } from './i18n'

/** Re-renders the calling component whenever the language changes. */
export const useLang = () => useSyncExternalStore(subscribeLang, getLang, getLang)
