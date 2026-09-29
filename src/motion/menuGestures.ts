import { PoseIndex, type PoseFrame } from '../types/pose'

/** Hold both hands above the head this long to replay from the debrief, hands-free. */
export const REPLAY_HOLD_MS = 1200
/** Ignore the gesture right after the debrief opens, so arms still up from the vault don't trigger it. */
export const REPLAY_ARM_DELAY_MS = 1500

const MIN_VISIBILITY = 0.5

/** Both wrists clearly above the nose: an unmistakable "again!" that no mission pose produces. */
export const bothHandsRaised = (frame: PoseFrame) => {
  const nose = frame.landmarks[PoseIndex.NOSE]
  const left = frame.landmarks[PoseIndex.LEFT_WRIST]
  const right = frame.landmarks[PoseIndex.RIGHT_WRIST]
  if (!nose || !left || !right) return false
  if ((left.visibility ?? 1) < MIN_VISIBILITY || (right.visibility ?? 1) < MIN_VISIBILITY) return false
  return left.y < nose.y && right.y < nose.y
}
