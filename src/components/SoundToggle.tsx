import { setMuted, useMuted } from '../audio/soundSettings'
import { t } from '../i18n/i18n'

export function SoundToggle() {
  const muted = useMuted()
  return (
    <button type="button" className={`sound-toggle ${muted ? 'off' : ''}`} aria-pressed={!muted} onClick={() => setMuted(!muted)}>
      {muted ? `🔇 ${t('common.soundOff')}` : `🔊 ${t('common.soundOn')}`}
    </button>
  )
}
