import { Schema } from 'effect'
import { CustomElement } from 'foldkit'

const TAG = 'lights-sheet-grabber'
const PANEL_SELECTOR = '[data-scene-panel]'
const DISMISS_DISTANCE_PX = 88
const DISMISS_SPEED_PX_PER_MS = 0.6
const SETTLE_MS = 180

export const sheetGrabberSpec = CustomElement.define({
  tag: TAG,
  properties: {},
  events: { dismissed: Schema.Struct({}) },
})

type Drag = Readonly<{
  pointerId: number
  startY: number
  startedAt: number
  panel: HTMLElement
}>

// NOTE: Dragging follows the finger every frame, far faster than the Model
// needs to know about. It reports only the outcome, a dismissal.
class SheetGrabberElement extends HTMLElement {
  #maybeDrag: Drag | undefined = undefined

  connectedCallback(): void {
    this.addEventListener('pointerdown', this.#handleDown)
    this.addEventListener('pointermove', this.#handleMove)
    this.addEventListener('pointerup', this.#handleUp)
    this.addEventListener('pointercancel', this.#handleCancel)
  }

  disconnectedCallback(): void {
    this.removeEventListener('pointerdown', this.#handleDown)
    this.removeEventListener('pointermove', this.#handleMove)
    this.removeEventListener('pointerup', this.#handleUp)
    this.removeEventListener('pointercancel', this.#handleCancel)
    this.#maybeDrag = undefined
  }

  #distance(event: PointerEvent, drag: Drag): number {
    return Math.max(0, event.clientY - drag.startY)
  }

  #handleDown = (event: PointerEvent): void => {
    const panel = this.closest<HTMLElement>(PANEL_SELECTOR)
    if (panel === null || !event.isPrimary) {
      return
    }
    this.setPointerCapture(event.pointerId)
    panel.style.transition = 'none'
    this.#maybeDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: event.timeStamp,
      panel,
    }
  }

  #handleMove = (event: PointerEvent): void => {
    const drag = this.#maybeDrag
    if (drag?.pointerId === event.pointerId) {
      drag.panel.style.transform = `translateY(${this.#distance(event, drag)}px)`
    }
  }

  #handleUp = (event: PointerEvent): void => {
    const drag = this.#maybeDrag
    if (drag?.pointerId !== event.pointerId) {
      return
    }
    this.#maybeDrag = undefined
    const distance = this.#distance(event, drag)
    const speed = distance / Math.max(1, event.timeStamp - drag.startedAt)
    if (
      distance >= DISMISS_DISTANCE_PX ||
      (speed >= DISMISS_SPEED_PX_PER_MS && distance > 12)
    ) {
      this.#finish(drag.panel, 'translateY(100%)', () => {
        this.dispatchEvent(new CustomEvent('dismissed', { detail: {} }))
      })
    } else {
      this.#finish(drag.panel, 'translateY(0)', () => {
        drag.panel.style.removeProperty('transform')
        drag.panel.style.removeProperty('transition')
      })
    }
  }

  #handleCancel = (): void => {
    const drag = this.#maybeDrag
    this.#maybeDrag = undefined
    if (drag !== undefined) {
      this.#finish(drag.panel, 'translateY(0)', () => {
        drag.panel.style.removeProperty('transform')
        drag.panel.style.removeProperty('transition')
      })
    }
  }

  #finish(panel: HTMLElement, transform: string, done: () => void): void {
    panel.style.transition = `transform ${SETTLE_MS}ms ease-out`
    panel.style.transform = transform
    window.setTimeout(done, SETTLE_MS)
  }
}

export const registerSheetGrabberElement = (): void => {
  if (customElements.get(TAG) === undefined) {
    customElements.define(TAG, SheetGrabberElement)
  }
}
