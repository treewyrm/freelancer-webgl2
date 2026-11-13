/**
 * Retail cutscenes put on the menu for a capture, each held at its end: the script as retail wrote it
 * but an hour long, so it plays once and every event's last write stays, as a script that doesn't
 * loop leaves its entities. On the menu it is the room's ambient scene: looping, exporting, `C = I`.
 * Test-only.
 */
import * as thn from '@treewyrm/freelancer/thn'
import * as thnScene from '@treewyrm/freelancer/thn/scene'
import { write } from '@treewyrm/freelancer/thn/text'

export interface ReferenceCutscene {
  /** Under `DATA`. */
  script: string
  /** When to press F9: past every event's end. */
  capture: number
}

export const cutscenes: ReadonlyMap<string, ReferenceCutscene> = new Map([
  // M8: the one story cutscene with no character in it: ships, the hypergate, its effects. 86.5 s.
  ['cutscene_m13', { script: 'SCRIPTS/STORY/m13_hypergate_scene.thn', capture: 90 }],
])

const HELD = 3600

/** The script read, and an hour long. */
export const heldScript = (bytes: Uint8Array): thnScene.Script => ({
  ...thnScene.read(thn.read(bytes)),
  duration: HELD,
})

/** As text, for the lab install. */
export const heldText = (bytes: Uint8Array): string => write(thnScene.write(heldScript(bytes)))
