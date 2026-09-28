# MOTION: HEIST

> **YOUR BODY IS THE CONTROLLER**

MOTION: HEIST is a browser-based cinematic vault infiltration game created for the Admit Hackathon **Motion / Camera instead of joystick** case. The player completes one short mission with a webcam: scan access, dodge two laser beams, duck under a low beam, and open the vault.

The application uses MediaPipe only to obtain body landmarks. Gesture recognition, temporal validation, error diagnosis, mission flow, scoring, and feedback are implemented in project code.

## Run locally

Requirements: Node.js 20+ and a webcam. Camera permissions work on `localhost` and HTTPS deployments.

```bash
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). Click **START HEIST**, allow camera access, step back so shoulders, hips, knees, and ankles are in frame, then hold still briefly for calibration.

Production verification:

```bash
npm run build
npm run preview
```

## Mission flow

1. **SCAN ACCESS** - raise the right hand above the right shoulder.
2. **DODGE LEFT** - lean the torso to the left.
3. **DODGE RIGHT** - lean the torso to the right.
4. **DUCK UNDER LASER** - squat deeply enough to lower the hips and flex both knees.
5. **OPEN VAULT** - hold both hands forward toward the camera.

The main game loop lasts 90 seconds. **Jury Demo Mode** is enabled by default on the landing screen and runs the identical five-step sequence in 55 seconds, keeping the full flow quick during a presentation. A slow phase shows a non-blocking mission warning instead of ending the mission. Finished runs show a scorecard and persist the local top 10 leaderboard in `localStorage`.

## Gesture engine

```
Webcam -> MediaPipe Pose Landmarker -> normalized landmarks
       -> feature extraction -> temporal gesture engine -> mission state machine
                                      |                         |
                                      v                         v
                               error analyzer              score / effects
```

All browser video is processed locally. No video frames or pose data are sent to a server.

### Normalization and features

The detector returns 33 landmarks in normalized image space. The project mirrors that coordinate space to match the mirrored camera preview, then derives body-relative features:

- `shoulderWidth` and `torso` provide user-size normalization.
- Right-hand lift is `(rightShoulder.y - rightWrist.y) / torso`.
- Torso lean is the signed angle between shoulder-midpoint -> hip-midpoint and vertical.
- Squat depth is the calibrated hip drop divided by torso height; knee flex uses the hip-knee-ankle angle on both sides.
- Vault activation combines both wrist depth values, hand height symmetry, and wrist spread normalized by shoulder width.
- Landmark visibility is averaged into a confidence score. Low-confidence frames cannot trigger an action.

Thresholds live in [`src/motion/gestureConfig.ts`](src/motion/gestureConfig.ts), not in the UI. The engine in [`src/motion/gestureEngine.ts`](src/motion/gestureEngine.ts) requires a sustained valid position before it emits success:

| Gesture | Hold | Key conditions |
| --- | ---: | --- |
| Right hand up | 620 ms | 42% torso lift above shoulder |
| Lean left/right | 560 ms | 15 degree signed torso tilt |
| Squat | 720 ms | 17% calibrated hip drop + both knees <= 154 degrees |
| Hands forward | 800 ms | both hands forward, level, and shoulder-width apart |

The per-target temporal state machine is effectively `IDLE -> ATTEMPT -> VALIDATING -> SUCCESS -> COOLDOWN`. Releasing the posture resets validation. A short cooldown prevents a valid hold from producing duplicate actions.

## Error mode

Error feedback is intentionally diagnostic, not a generic "gesture not recognized" message. After a sustained near-attempt, [`src/errors/errorAnalyzer.ts`](src/errors/errorAnalyzer.ts) selects an actionable reason and the Canvas highlights the relevant skeleton joints.

| Target | Possible correction |
| --- | --- |
| Right hand up | `RIGHT HAND TOO LOW` - raise it above the shoulder |
| Lean left/right | `TORSO TILT TOO SMALL` or `WRONG DODGE DIRECTION` - with current and target angle |
| Squat | `HIPS TOO HIGH` or `BEND YOUR KNEES` - with depth or knee-angle target |
| Hands forward | `LEFT/RIGHT HAND TOO FAR BACK` or `HANDS OUT OF SYNC` |

The overlay includes an arrow, concrete body instruction, current versus target measurement, warning sound, and highlighted landmarks. A correction remains worth completing: it applies only a small score penalty and records correction time.

## Architecture

```text
src/
  audio/       Web Audio API cues with a no-audio fallback
  errors/      Gesture-specific diagnostic hints
  game/        Five-stage mission definition
  hooks/       Camera lifecycle, requestAnimationFrame loop, Canvas skeleton
  motion/      Geometry, thresholds, calibration, custom gesture engine
  scoring/     Transparent score calculations and local leaderboard storage
  types/       Pose, game, and feedback contracts
  App.tsx      Screen-level state machine and HUD
```

The camera hook isolates the expensive pose loop from React rendering. It runs inference at approximately 30 FPS via `requestAnimationFrame`, draws the skeleton on a Canvas, throttles UI-state updates, and closes MediaPipe plus all camera tracks on exit. It first tries the GPU delegate and falls back to CPU if WebGL is unavailable.

## Scoring

Every completed motion earns a base score, a reaction bonus, a confidence/hold precision bonus, and a growing combo bonus (up to x5). A diagnosed mistake costs 120 points and resets the combo; a corrected movement still receives its full completion reward. The results screen derives motion style from accuracy and error count.

## Demo protocol

For a reliable jury demo, use a laptop in a well-lit room and frame the player from head to ankles:

1. Start the heist and wait for **BODY LOCKED**.
2. Raise the right hand, then lean left and right.
3. During **DUCK UNDER LASER**, first make a shallow squat to show the `HIPS TOO HIGH` correction; then squat lower.
4. Hold both hands toward the camera for the vault-open animation and results screen.

The sequence deliberately makes real-time recognition, Canvas feedback, a concrete error correction, a completed scenario, and the local leaderboard visible in one run.

## Mobile and accessibility

- Responsive HUD handles narrow portrait screens; the camera fills the viewport and the five-step indicator remains in one row.
- The app reports missing body tracking, camera denial, no camera, insecure context, and model initialization failure in plain language.
- Important text uses high contrast; controls use accessible labels; `prefers-reduced-motion` reduces visual animation.
- Audio uses browser-native Web Audio only after a user action and never blocks gameplay when unavailable.

## Known limitations

- The initial MediaPipe model and WASM runtime are loaded from Google/jsDelivr CDNs, so the first run needs an internet connection.
- Forward-hand detection uses pose depth estimates; it performs best with both wrists visible, adequate front lighting, and the player facing the camera.
- This is a single-player local experience. The leaderboard lives only in the current browser profile and has no backend sync.
