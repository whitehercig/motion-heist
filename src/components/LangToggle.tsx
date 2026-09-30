import { setLang, type Lang } from '../i18n/i18n'
import { useLang } from '../i18n/useLang'

const LANGS: Lang[] = ['ru', 'en']

export function LangToggle({ className = '' }: { className?: string }) {
  const lang = useLang()
  return (
    <div className={`lang-toggle ${className}`} role="group" aria-label="Language / Язык">
      {LANGS.map((option) => (
        <button key={option} type="button" className={option === lang ? 'active' : ''} aria-pressed={option === lang} onClick={() => setLang(option)}>
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
