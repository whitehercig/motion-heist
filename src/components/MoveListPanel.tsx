import { useEffect } from 'react'
import { MISSION } from '../game/mission'
import { t } from '../i18n/i18n'
import { useLang } from '../i18n/useLang'
import type { GestureId } from '../types/game'
import { PoseGlyph, type GlyphDecor } from './PoseGlyph'

interface MoveListPanelProps {
  onClose: () => void
  onTraining?: () => void
}

type Obstacle = 'LOW_BEAM' | 'WALL' | 'DIAMOND' | 'SEARCHLIGHT'

const OBSTACLES: Array<{ id: Obstacle; gesture: GestureId; decor: GlyphDecor }> = [
  { id: 'LOW_BEAM', gesture: 'SQUAT', decor: 'beam' },
  { id: 'WALL', gesture: 'LEAN_RIGHT', decor: 'wallLeft' },
  { id: 'DIAMOND', gesture: 'RIGHT_HAND_UP', decor: 'diamond' },
  { id: 'SEARCHLIGHT', gesture: 'FREEZE', decor: 'light' },
]

/** "How do I play?" in one screen: every story move and arcade obstacle, standing and seated. */
export function MoveListPanel({ onClose, onTraining }: MoveListPanelProps) {
  useLang()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="move-list-backdrop" role="dialog" aria-modal="true" aria-labelledby="move-list-title" onClick={onClose}>
      <section className="move-list" onClick={(event) => event.stopPropagation()}>
        <header className="move-list-head">
          <div>
            <p className="eyebrow"><span className="live-dot" /> MOTION: HEIST</p>
            <h2 id="move-list-title">{t('moves.title')}</h2>
            <p className="move-list-sub">{t('moves.subtitle')}</p>
          </div>
          <button className="quiet-button move-list-close" onClick={onClose}>{t('common.close')} ✕</button>
        </header>

        <h3>{t('moves.story')}</h3>
        <ol className="move-grid">
          {MISSION.map((action, index) => (
            <li key={action.gesture} className="move-card">
              <PoseGlyph gesture={action.gesture} size={92} />
              <div>
                <span className="move-index">{t('act.label', { n: action.act })} · 0{index + 1}</span>
                <b>{t(`move.${action.gesture}.name`)}</b>
                <p>{t(`move.${action.gesture}.pose`)}</p>
                {action.gesture === 'SQUAT' && <p className="move-desk"><em>{t('moves.sitting')}:</em> {t('move.SQUAT.deskHint')}</p>}
                <p className="move-tip"><em>{t('moves.tip')}:</em> {t(`move.${action.gesture}.tip`)}</p>
              </div>
            </li>
          ))}
        </ol>

        <h3>{t('moves.arcade')}</h3>
        <ul className="move-grid">
          {OBSTACLES.map((obstacle) => (
            <li key={obstacle.id} className="move-card obstacle">
              <PoseGlyph gesture={obstacle.gesture} decor={obstacle.decor} size={92} />
              <div>
                <b>{t(`obs.${obstacle.id}.name`)}</b>
                <p>{t(`obs.${obstacle.id}.desc`)}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="move-card menu-gesture">
          <PoseGlyph gesture="FREEZE" decor="handsUp" size={92} />
          <div>
            <b>{t('moves.menu')}</b>
            <p>{t('moves.menuDesc')}</p>
          </div>
          {onTraining && <button className="primary-button compact" onClick={onTraining}>{t('moves.training')}</button>}
        </div>
      </section>
    </div>
  )
}
