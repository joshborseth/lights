import { Option, Schema } from 'effect'
import { CustomElement } from 'foldkit'

import { HouseBulb, HouseFocus } from './house'
import { RoomId } from './housePlan'
import { type HouseScene } from './houseScene'

const TAG = 'lights-house-scene'

export const houseSceneSpec = CustomElement.define({
  tag: TAG,
  properties: {
    bulbs: Schema.Array(HouseBulb),
    houseFocus: HouseFocus,
  },
  events: {
    'picked-bulb': Schema.Struct({ name: Schema.String }),
    'picked-room': Schema.Struct({ roomId: RoomId }),
    'cleared-pick': Schema.Struct({}),
    'failed-scene': Schema.Struct({ reason: Schema.String }),
  },
})

const STAGE_STYLE =
  'position:absolute;inset:0;display:block;width:100%;height:100%;overflow:hidden'

// NOTE: The renderer needs a live element and owns its own frame loop, so it
// lives behind this element. three.js loads as its own chunk, so the first
// paint of the page does not wait for it. Children stay in the light DOM, where
// the view can render and style them, and the renderer only moves the ones
// marked with data-anchor to the screen position of a spot in the house.
class HouseSceneElement extends HTMLElement {
  #bulbs: ReadonlyArray<HouseBulb> = []
  #houseFocus: HouseFocus = HouseFocus.Overview()
  #maybeScene: Option.Option<HouseScene> = Option.none()
  #mountCount = 0

  get bulbs(): ReadonlyArray<HouseBulb> {
    return this.#bulbs
  }

  set bulbs(bulbs: ReadonlyArray<HouseBulb>) {
    this.#bulbs = bulbs
    if (Option.isSome(this.#maybeScene)) {
      this.#maybeScene.value.setBulbs(bulbs)
    }
  }

  get houseFocus(): HouseFocus {
    return this.#houseFocus
  }

  set houseFocus(houseFocus: HouseFocus) {
    this.#houseFocus = houseFocus
    if (Option.isSome(this.#maybeScene)) {
      this.#maybeScene.value.setFocus(houseFocus)
    }
  }

  connectedCallback(): void {
    this.#mountCount += 1
    const mount = this.#mountCount

    const stage = document.createElement('div')
    stage.setAttribute('style', STAGE_STYLE)
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    root.replaceChildren(stage, document.createElement('slot'))

    import('./houseScene')
      .then(({ createHouseScene }) => {
        if (mount !== this.#mountCount) {
          return
        }
        const scene = createHouseScene(stage, this, {
          onPickBulb: name => {
            this.#emit('picked-bulb', { name })
          },
          onPickRoom: roomId => {
            this.#emit('picked-room', { roomId })
          },
          onClearPick: () => {
            this.#emit('cleared-pick', {})
          },
        })
        scene.setBulbs(this.#bulbs)
        scene.setFocus(this.#houseFocus)
        this.#maybeScene = Option.some(scene)
      })
      .catch((error: unknown) => {
        if (mount === this.#mountCount) {
          this.#emit('failed-scene', {
            reason: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      })
  }

  disconnectedCallback(): void {
    this.#mountCount += 1
    if (Option.isSome(this.#maybeScene)) {
      this.#maybeScene.value.dispose()
    }
    this.#maybeScene = Option.none()
  }

  #emit(name: string, detail: object): void {
    this.dispatchEvent(new CustomEvent(name, { detail }))
  }
}

export const registerHouseSceneElement = (): void => {
  if (customElements.get(TAG) === undefined) {
    customElements.define(TAG, HouseSceneElement)
  }
}
