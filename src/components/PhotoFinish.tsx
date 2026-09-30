import { useMemo } from 'react'
import { t } from '../i18n/i18n'
import { useLang } from '../i18n/useLang'
import { renderWantedPoster } from '../render/wantedPoster'

interface PhotoFinishProps {
  snapshot: HTMLCanvasElement | null
  name: string
  score: number
  crime: 'story' | 'arcade'
  /** Optional line under the poster, e.g. the rank. */
  caption?: string
  compact?: boolean
}

const fileName = (name: string) => `motion-heist-${name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-') || 'wanted'}.png`

export function PhotoFinish({ snapshot, name, score, crime, caption, compact = false }: PhotoFinishProps) {
  const lang = useLang()
  const url = useMemo(() => {
    try {
      const poster = renderWantedPoster(snapshot, {
        wanted: t('photo.wanted'),
        name,
        reward: t('photo.reward'),
        rewardValue: t('photo.points', { n: score.toLocaleString() }),
        crime: t('photo.crime', { what: t(crime === 'story' ? 'photo.crimeStory' : 'photo.crimeArcade') }),
        footer: `MOTION: HEIST · ${new Date().toLocaleDateString()}`,
      })
      return poster.toDataURL('image/png')
    } catch {
      return null
    }
    // `lang` is read through t(); listing it re-renders the poster after a language switch.
  }, [snapshot, name, score, crime, lang])

  if (!url) return null
  return (
    <figure className={`photo-finish ${compact ? 'compact' : ''}`}>
      {!compact && <figcaption>{t('photo.title')}</figcaption>}
      <img src={url} alt={`${t('photo.wanted')}: ${name}`} />
      {caption && <p className="photo-caption">{caption}</p>}
      {!compact && (
        <>
          <a className="photo-download" href={url} download={fileName(name)}>{t('photo.download')}</a>
          <small>{t('photo.local')}</small>
        </>
      )}
    </figure>
  )
}
