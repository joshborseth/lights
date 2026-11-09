import { Option, Schema } from 'effect'
import { CustomElement } from 'foldkit'

import { HouseBulb, HouseSelection, RoomId } from './house'
import { type HouseScene } from './houseScene'

const TAG = 'lights-house-scene'

export const houseSceneSpec = CustomElement.define({
  tag: TAG,
  properties: {
    bulbs: Schema.Array(HouseBulb),
    selection: HouseSelection,
  },
  events: {
    'picked-bulb': Schema.Struct({ name: Schema.String }),
    'picked-room': Schema.Struct({ roomId: RoomId }),
    'cleared-pick': Schema.Struct({}),
    'failed-scene': Schema.Struct({ reason: Schema.String }),
  },
})

const STAGE_STYLE =
  'position:relative;display:block;width:100%;height:100%;overflow:hidden'
const LOADING_STYLE =
  'position:absolute;inset:0;display:grid;place-items:center;margin:0;font-size:0.75rem;color:var(--muted-foreground)'

// NOTE: The renderer needs a live element and owns its own frame loop, so it
// lives behind this element. three.js loads on first use, which keeps it out
// of the main bundle for anyone who stays on the other tabs.
class HouseSceneElement extends HTMLElement {
  #bulbs: ReadonlyArray<HouseBulb> = []
  #selection: HouseSelection = HouseSelection.Nothing()
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

  get selection(): HouseSelection {
    return this.#selection
  }

  set selection(selection: HouseSelection) {
    this.#selection = selection
    if (Option.isSome(this.#maybeScene)) {
      this.#maybeScene.value.setSelection(selection)
    }
  }

  connectedCallback(): void {
    this.#mountCount += 1
    const mount = this.#mountCount

    const stage = document.createElement('div')
    stage.setAttribute('style', STAGE_STYLE)
    const loading = document.createElement('p')
    loading.setAttribute('style', LOADING_STYLE)
    loading.textContent = 'Loading the house…'
    stage.append(loading)
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    root.replaceChildren(stage)

    import('./houseScene')
      .then(({ createHouseScene }) => {
        if (mount !== this.#mountCount) {
          return
        }
        const scene = createHouseScene(stage, {
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
        scene.setSelection(this.#selection)
        this.#maybeScene = Option.some(scene)
        loading.remove()
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
