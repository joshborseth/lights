import { Effect, Equal, Match as M, Option, Schema as S, Stream, pipe } from 'effect'
import { Slider as FoldkitSlider } from '@foldkit/ui'
import { Update } from 'foldkit'
import { childAttributes, type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'
import * as Subscription from 'foldkit/subscription'

import { cn } from '@/lib/utils'

/**
 * foldcn gap vs upstream: single value / single thumb only (upstream is
 * multi-thumb; foldcn renders one thumb). Vertical orientation and
 * edge-aligned thumb/range geometry are owned by this module's view until
 * foldkit/ui gains parity (see foldcn issue tracker).
 *
 * Local gap vs upstream: a finger or pen can only grab the knob, so a swipe
 * across the track always scrolls the page. Even on the knob a press changes
 * nothing: the browser keeps scrolling along the cross axis, and the value only
 * follows a pointer that has clearly moved along the track. A mouse keeps
 * upstream's press-to-set behavior.
 */

const TouchGesture = defineTaggedUnion({
  Idle: {},
  Deciding: {
    pointerId: S.Number,
    startAlong: S.Number,
    startAcross: S.Number,
    originValue: S.Number,
  },
  Sliding: {
    pointerId: S.Number,
    startAlong: S.Number,
    originValue: S.Number,
  },
})
type TouchGesture = typeof TouchGesture.Type

export const Model = S.Struct({
  ...FoldkitSlider.Model.fields,
  touchGesture: TouchGesture,
})
export type Model = typeof Model.Type

export const init = (config: InitConfig): Model => ({
  ...FoldkitSlider.init(config),
  touchGesture: TouchGesture.Idle(),
})

export const Message = defineMessageUnion({
  PressedThumb: { originValue: S.Number },
  PressedPointer: { value: S.Number, originValue: S.Number },
  MovedDragPointer: { value: S.Number },
  ReleasedDragPointer: {},
  CancelledDrag: {},
  PressedKeyboardNavigation: {
    direction: S.Literals([
      'StepDecrement',
      'StepIncrement',
      'PageDecrement',
      'PageIncrement',
      'Min',
      'Max',
    ]),
    value: S.Number,
  },
  PressedTouch: {
    pointerId: S.Number,
    along: S.Number,
    across: S.Number,
    originValue: S.Number,
  },
  MovedTouch: {
    pointerId: S.Number,
    along: S.Number,
    across: S.Number,
    valuePerPixel: S.Number,
  },
  ReleasedTouch: { pointerId: S.Number },
})
export type Message = typeof Message.Type
export const OutMessage = FoldkitSlider.OutMessage
export type OutMessage = typeof OutMessage.Type

export const snapAndClamp = FoldkitSlider.snapAndClamp
export const fractionOfValue = FoldkitSlider.fractionOfValue
export const reflectRange = FoldkitSlider.reflectRange

export type InitConfig = FoldkitSlider.InitConfig
export type SliderAttributes = FoldkitSlider.SliderAttributes

/** Upstream SliderPrimitive.Control string. */
export const sliderRootClass =
  'data-horizontal:h-6 data-vertical:min-h-40 relative flex w-full items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col'

/** A slim track. The `after:` layer stretches its pointer target to 44px tall. */
export const sliderTrackClass =
  'bg-white/12 rounded-full cursor-pointer data-horizontal:h-2 data-horizontal:w-full data-vertical:h-full data-vertical:w-2 relative grow select-none after:absolute data-horizontal:after:inset-x-0 data-horizontal:after:-inset-y-4.5 data-vertical:after:inset-y-0 data-vertical:after:-inset-x-4.5'

/** Eases to values reported by the bulb, and tracks the pointer exactly mid-drag. */
export const sliderFilledTrackClass =
  'bg-primary rounded-full select-none data-horizontal:h-full data-vertical:w-full transition-[width] duration-200 ease-out data-dragging:transition-none motion-reduce:transition-none'

/** A round knob sized by `THUMB_SIZE_PX` to match the power switch's knob. The
 *  disabled: variants are inert under foldkit (aria-/data- twins are inlined at
 *  style resolution). */
export const sliderThumbClass =
  'ring-white/15 relative cursor-grab after:absolute after:-inset-2.5 after:rounded-full rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.45)] transition-[left,box-shadow,scale] duration-200 ease-out hover:ring-4 focus-visible:ring-4 focus-visible:ring-ring focus-visible:outline-hidden data-dragging:scale-110 data-dragging:ring-6 data-dragging:transition-[box-shadow,scale] motion-reduce:transition-none aria-disabled:pointer-events-none aria-disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50'

export const sliderLabelClass = 'text-sm font-medium'

export const sliderValueClass = 'text-sm tabular-nums text-muted-foreground'

/** Floats above the knob, and shows only while the knob is being dragged. */
export const sliderDragValueClass =
  'pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 rounded-md bg-popover px-2 py-1 text-xs font-medium whitespace-nowrap tabular-nums text-popover-foreground shadow-md in-data-dragging:block'

export const sliderRowClass = 'flex flex-col gap-2 w-full'

export const sliderHeaderClass = 'flex items-center justify-between'

const LEFT_MOUSE_BUTTON = 0
const THUMB_SIZE_PX = 24
const THUMB_SIZE = `${String(THUMB_SIZE_PX)}px`
const TOUCH_SLOP_PX = 12
const TOUCH_SIDEWAYS_RATIO = 2

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

const percentString = (fraction: number): string => `${String(Math.round(fraction * 10000) / 100)}%`

const labelId = (id: string): string => `${id}-label`

type KeyboardDirection =
  | 'StepDecrement'
  | 'StepIncrement'
  | 'PageDecrement'
  | 'PageIncrement'
  | 'Min'
  | 'Max'

const keyToDirection = (key: string): Option.Option<KeyboardDirection> =>
  M.value(key).pipe(
    M.withReturnType<KeyboardDirection>(),
    M.whenOr('ArrowRight', 'ArrowUp', () => 'StepIncrement' as const),
    M.whenOr('ArrowLeft', 'ArrowDown', () => 'StepDecrement' as const),
    M.when('PageUp', () => 'PageIncrement' as const),
    M.when('PageDown', () => 'PageDecrement' as const),
    M.when('Home', () => 'Min' as const),
    M.when('End', () => 'Max' as const),
    M.option,
  )

const isVerticalTrack = (element: Element): boolean =>
  element.hasAttribute('data-vertical') || element.closest('[data-vertical]') !== null

const trackElement = (id: string, root: Document | ShadowRoot): Option.Option<Element> =>
  Option.fromNullishOr(root.querySelector(`[data-slider-track-id="${CSS.escape(id)}"]`))

export const valueFromPointer = (
  clientX: number,
  clientY: number,
  track: Element,
  min: number,
  max: number,
): number => {
  const rect = track.getBoundingClientRect()
  if (isVerticalTrack(track)) {
    if (rect.height === 0) return min
    const fraction = clamp(1 - (clientY - rect.top) / rect.height, 0, 1)
    return min + fraction * (max - min)
  }
  const thumbTravel = rect.width - THUMB_SIZE_PX
  if (thumbTravel <= 0) return min
  const fraction = clamp((clientX - rect.left - THUMB_SIZE_PX / 2) / thumbTravel, 0, 1)
  return min + fraction * (max - min)
}

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const upstreamUpdate = (model: Model, message: FoldkitSlider.Message): UpdateReturn => {
  const upstream = FoldkitSlider.update(model, message)
  return Update.withOutMessage(
    { model: modifyFields(model, { dragState: () => upstream.model.dragState }) },
    upstream.outMessage,
  )
}

const isTrackedTouch = (gesture: TouchGesture, pointerId: number): boolean =>
  gesture._tag !== 'Idle' && gesture.pointerId === pointerId

const decidedTouchGesture = (
  deciding: typeof TouchGesture.Deciding.Type,
  along: number,
  across: number,
): TouchGesture => {
  const alongDistance = Math.abs(along - deciding.startAlong)
  const acrossDistance = Math.abs(across - deciding.startAcross)
  if (Math.max(alongDistance, acrossDistance) < TOUCH_SLOP_PX) {
    return deciding
  }
  return alongDistance >= acrossDistance * TOUCH_SIDEWAYS_RATIO
    ? TouchGesture.Sliding({
        pointerId: deciding.pointerId,
        startAlong: along,
        originValue: deciding.originValue,
      })
    : TouchGesture.Idle()
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tag('PressedTouch', ({ pointerId, along, across, originValue }) =>
      model.touchGesture._tag === 'Idle'
        ? {
            model: modifyFields(model, {
              touchGesture: () =>
                TouchGesture.Deciding({
                  pointerId,
                  startAlong: along,
                  startAcross: across,
                  originValue,
                }),
            }),
          }
        : { model },
    ),
    M.tag('MovedTouch', ({ pointerId, along, across, valuePerPixel }) => {
      if (!isTrackedTouch(model.touchGesture, pointerId)) {
        return { model }
      }
      return TouchGesture.match<UpdateReturn>(model.touchGesture, {
        Idle: () => ({ model }),
        Deciding: (deciding) => ({
          model: modifyFields(model, {
            touchGesture: () => decidedTouchGesture(deciding, along, across),
          }),
        }),
        Sliding: ({ startAlong, originValue }) => ({
          model,
          outMessage: OutMessage.ChangedValue({
            value: snapAndClamp(
              originValue + (along - startAlong) * valuePerPixel,
              model.min,
              model.max,
              model.step,
            ),
          }),
        }),
      })
    }),
    M.tag('ReleasedTouch', ({ pointerId }) =>
      isTrackedTouch(model.touchGesture, pointerId)
        ? { model: modifyFields(model, { touchGesture: () => TouchGesture.Idle() }) }
        : { model },
    ),
    M.orElse((upstreamMessage) => upstreamUpdate(model, upstreamMessage)),
  )

/** Whether this slider is mid-gesture and must stay in the parent's Model. */
export const isInteracting = (model: Model): boolean =>
  model.dragState._tag === 'Dragging' || model.touchGesture._tag !== 'Idle'

const touchAxes = (
  clientX: number,
  clientY: number,
  isVertical: boolean,
): Readonly<{ along: number; across: number }> =>
  isVertical ? { along: -clientY, across: clientX } : { along: clientX, across: clientY }

const valuePerPixel = (track: Element, min: number, max: number): number => {
  const rect = track.getBoundingClientRect()
  const travel = isVerticalTrack(track) ? rect.height : rect.width - THUMB_SIZE_PX
  return travel <= 0 ? 0 : (max - min) / travel
}

const DragActivity = S.Literals(['Idle', 'Active'])

const dragActivityFromModel = (model: Model): 'Idle' | 'Active' =>
  M.value(model.dragState).pipe(
    M.withReturnType<'Idle' | 'Active'>(),
    M.tag('Dragging', (): 'Idle' | 'Active' => 'Active'),
    M.orElse((): 'Idle' | 'Active' => 'Idle'),
  )

const touchActivityFromModel = (model: Model): 'Idle' | 'Active' =>
  model.touchGesture._tag === 'Idle' ? 'Idle' : 'Active'

const streamTouchEnds = (type: 'pointerup' | 'pointercancel'): Stream.Stream<Message> =>
  Stream.fromEventListener(document, type).pipe(
    Stream.filter((event): event is PointerEvent => event instanceof PointerEvent),
    Stream.map((event) => Message.ReleasedTouch({ pointerId: event.pointerId })),
  )

/** Drag subscriptions that map pointer position along the track axis, including
 *  vertical sliders marked with `data-vertical`. Pending foldkit upstream (#27).
 */
export const subscriptionsForRoot = (getTrackRoot: () => Document | ShadowRoot) =>
  Subscription.make<Model, Message>()((entry) => ({
    dragPointer: entry(
      {
        dragActivity: DragActivity,
        id: S.String,
        min: S.Number,
        max: S.Number,
      },
      {
        modelToDependencies: (model) => ({
          dragActivity: dragActivityFromModel(model),
          id: model.id,
          min: model.min,
          max: model.max,
        }),
        dependenciesToStream: ({ dragActivity, id, min, max }): Stream.Stream<Message> => {
          const pointerEvents = Stream.merge(
            Stream.fromEventListener(document, 'pointermove').pipe(
              Stream.mapEffect((event) =>
                Effect.sync(() => {
                  if (!(event instanceof PointerEvent)) return Option.none()
                  return Option.flatMap(trackElement(id, getTrackRoot()), (element) =>
                    Option.some(
                      Message.MovedDragPointer({
                        value: valueFromPointer(event.clientX, event.clientY, element, min, max),
                      }),
                    ),
                  )
                }),
              ),
              Stream.filter(Option.isSome),
              Stream.map((option) => option.value),
            ),
            Stream.fromEventListener(document, 'pointerup').pipe(
              Stream.map(() => Message.ReleasedDragPointer()),
            ),
          )

          const documentDragStyles = Stream.callback(() =>
            Effect.acquireRelease(
              Effect.sync(() => {
                document.documentElement.style.setProperty('user-select', 'none')
                document.documentElement.style.setProperty('-webkit-user-select', 'none')
                const cursorStyle = document.createElement('style')
                cursorStyle.textContent = '* { cursor: grabbing !important; }'
                document.head.appendChild(cursorStyle)
                return cursorStyle
              }),
              (cursorStyle) =>
                Effect.sync(() => {
                  document.documentElement.style.removeProperty('user-select')
                  document.documentElement.style.removeProperty('-webkit-user-select')
                  cursorStyle.remove()
                }),
            ).pipe(Effect.flatMap(() => Effect.never)),
          )

          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stream.when widens the element type
          return Stream.when(
            Stream.merge(pointerEvents, documentDragStyles),
            Effect.sync(() => dragActivity === 'Active'),
          ) as Stream.Stream<Message>
        },
      },
    ),
    // NOTE: pointercancel is how the browser reports that this touch became a
    // page scroll, so it ends the gesture without touching the value.
    touchPointer: entry(
      {
        touchActivity: DragActivity,
        id: S.String,
        min: S.Number,
        max: S.Number,
      },
      {
        modelToDependencies: (model) => ({
          touchActivity: touchActivityFromModel(model),
          id: model.id,
          min: model.min,
          max: model.max,
        }),
        dependenciesToStream: ({ touchActivity, id, min, max }): Stream.Stream<Message> =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stream.when widens the element type
          Stream.when(
            Stream.mergeAll(
              [
                Stream.fromEventListener(document, 'pointermove').pipe(
                  Stream.filter((event): event is PointerEvent => event instanceof PointerEvent),
                  Stream.map((event) =>
                    Option.map(trackElement(id, getTrackRoot()), (element) =>
                      Message.MovedTouch({
                        pointerId: event.pointerId,
                        ...touchAxes(event.clientX, event.clientY, isVerticalTrack(element)),
                        valuePerPixel: valuePerPixel(element, min, max),
                      }),
                    ),
                  ),
                  Stream.filter(Option.isSome),
                  Stream.map((option) => option.value),
                ),
                streamTouchEnds('pointerup'),
                streamTouchEnds('pointercancel'),
              ],
              { concurrency: 'unbounded' },
            ),
            Effect.sync(() => touchActivity === 'Active'),
          ) as Stream.Stream<Message>,
      },
    ),
    dragEscape: entry(
      { dragActivity: DragActivity },
      {
        modelToDependencies: (model) => ({
          dragActivity: dragActivityFromModel(model),
        }),
        dependenciesToStream: ({ dragActivity }): Stream.Stream<Message> =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stream.when widens the element type
          Stream.when(
            Stream.fromEventListener(document, 'keydown').pipe(
              Stream.filter(
                (event): event is KeyboardEvent =>
                  event instanceof KeyboardEvent && event.key === 'Escape',
              ),
              Stream.map(() => Message.CancelledDrag()),
            ),
            Effect.sync(() => dragActivity === 'Active'),
          ) as Stream.Stream<Message>,
      },
    ),
  }))

export const subscriptions = subscriptionsForRoot(() => document)

type Orientation = 'horizontal' | 'vertical'

const touchActionOf = (orientation: Orientation): string =>
  orientation === 'vertical' ? 'pan-x' : 'pan-y'

const filledTrackStyle = (
  orientation: Orientation,
  fraction: number,
): Readonly<Record<string, string>> => {
  if (orientation === 'vertical') {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: style bag must be Record<string,string> for h.Style; literal evidence is intentionally widened to the style contract
    return {
      position: 'absolute',
      bottom: '0',
      left: '0',
      right: '0',
      height: percentString(fraction),
      width: '100%',
      'pointer-events': 'none',
    }
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: style bag must be Record<string,string> for h.Style; literal evidence is intentionally widened to the style contract
  return {
    position: 'absolute',
    left: '0',
    top: '0',
    bottom: '0',
    width: `calc((100% - ${THUMB_SIZE}) * ${fraction} + ${THUMB_SIZE})`,
    'pointer-events': 'none',
  }
}

const thumbStyle = (
  orientation: Orientation,
  fraction: number,
): Readonly<Record<string, string>> => {
  if (orientation === 'vertical') {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: style bag must be Record<string,string> for h.Style; literal evidence is intentionally widened to the style contract
    return {
      position: 'absolute',
      bottom: percentString(fraction),
      left: '50%',
      transform: 'translateX(-50%) translateY(-50%)',
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      'touch-action': touchActionOf(orientation),
    }
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: style bag must be Record<string,string> for h.Style; literal evidence is intentionally widened to the style contract
  return {
    position: 'absolute',
    left: `calc((100% - ${THUMB_SIZE}) * ${fraction})`,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    'touch-action': touchActionOf(orientation),
  }
}

/** Per-render view inputs passed to `view` via `h.submodel`'s `viewInputs` field. */
export type ViewInputs = Readonly<{
  value: number
  toView: (attributes: SliderAttributes) => Html
  orientation?: Orientation
  ariaLabel?: string
  ariaLabelledBy?: string
  formatValue?: (value: number) => string
  isDisabled?: boolean
  isReadOnly?: boolean
  ignoresTouch?: boolean
  name?: string
  getTrackRoot?: () => Document | ShadowRoot
}>

/** Renders an accessible slider with upstream edge-aligned geometry and
 *  vertical orientation support, delegating shadcn layout to `toView`. */
export const view = defineView<Model, Message, ViewInputs>((model, viewInputs, h) => {
  const {
    value,
    formatValue,
    isDisabled = false,
    isReadOnly = false,
    ignoresTouch = false,
    name,
    orientation = 'horizontal',
    getTrackRoot = () => document,
  } = viewInputs
  const { id, min, max } = model
  const isDragging = model.dragState._tag === 'Dragging' || model.touchGesture._tag === 'Sliding'
  const fraction = fractionOfValue(value, min, max)
  const isInteractive = !isDisabled && !isReadOnly

  const handleKeyDown = (key: string) =>
    Option.map(keyToDirection(key), (direction) =>
      Message.PressedKeyboardNavigation({ direction, value }),
    )

  const pointerAtPointer = (clientX: number, clientY: number) =>
    Option.flatMap(trackElement(id, getTrackRoot()), (element) =>
      Option.some(
        Message.PressedPointer({
          value: valueFromPointer(clientX, clientY, element, min, max),
          originValue: value,
        }),
      ),
    )

  const pressedByTouch = (
    clientX: number,
    clientY: number,
    pointerId: number,
  ): Option.Option<Message> =>
    ignoresTouch
      ? Option.none()
      : Option.some(
          Message.PressedTouch({
            pointerId,
            ...touchAxes(clientX, clientY, orientation === 'vertical'),
            originValue: value,
          }),
        )

  const trackPointerHandler = (
    pointerType: string,
    button: number,
    _screenX: number,
    _screenY: number,
    _timeStamp: number,
    clientX: number,
    clientY: number,
  ): Option.Option<Message> =>
    pointerType === 'mouse' && button === LEFT_MOUSE_BUTTON
      ? pointerAtPointer(clientX, clientY)
      : Option.none()

  const thumbPointerHandler = (
    pointerType: string,
    button: number,
    _screenX: number,
    _screenY: number,
    _timeStamp: number,
    clientX: number,
    clientY: number,
    pointerId: number,
  ): Option.Option<Message> =>
    pipe(
      button,
      Option.liftPredicate(Equal.equals(LEFT_MOUSE_BUTTON)),
      Option.flatMap(
        (): Option.Option<Message> =>
          pointerType === 'mouse'
            ? Option.some(Message.PressedThumb({ originValue: value }))
            : pressedByTouch(clientX, clientY, pointerId),
      ),
    )

  const stateAttributes = [
    ...(isDragging ? [h.DataAttribute('dragging', '')] : []),
    ...(isDisabled ? [h.DataAttribute('disabled', '')] : []),
    ...(isReadOnly ? [h.DataAttribute('readonly', '')] : []),
  ]

  const rootAttributes = [
    h.DataAttribute('slider-id', id),
    h.DataAttribute('orientation', orientation),
    h.DataAttribute(orientation, ''),
    ...stateAttributes,
  ]

  const trackInteractionAttributes = isInteractive ? [h.OnPointerDown(trackPointerHandler)] : []

  const trackAttributes = [
    h.DataAttribute('slider-track-id', id),
    h.DataAttribute('orientation', orientation),
    h.DataAttribute(orientation, ''),
    h.Style({ position: 'relative' }),
    ...stateAttributes,
    ...trackInteractionAttributes,
  ]

  const filledTrackAttributes = [
    h.Style(filledTrackStyle(orientation, fraction)),
    ...stateAttributes,
  ]

  const thumbLabelAttributes =
    viewInputs.ariaLabel !== undefined
      ? [h.AriaLabel(viewInputs.ariaLabel)]
      : viewInputs.ariaLabelledBy !== undefined
        ? [h.AriaLabelledBy(viewInputs.ariaLabelledBy)]
        : [h.AriaLabelledBy(labelId(id))]

  const maybeAriaValuetext = formatValue !== undefined ? [h.AriaValuetext(formatValue(value))] : []

  const thumbInteractionAttributes = isInteractive
    ? [h.OnPointerDown(thumbPointerHandler), h.OnKeyDownPreventDefault(handleKeyDown)]
    : []

  const thumbAttributes = [
    h.Id(`${id}-thumb`),
    h.Role('slider'),
    h.Tabindex(0),
    h.AriaOrientation(orientation),
    h.AriaValuemin(min),
    h.AriaValuemax(max),
    h.AriaValuenow(value),
    ...maybeAriaValuetext,
    ...thumbLabelAttributes,
    ...(isDisabled ? [h.AriaDisabled(true)] : []),
    ...(isReadOnly ? [h.AriaReadonly(true)] : []),
    h.Style(thumbStyle(orientation, fraction)),
    ...stateAttributes,
    ...thumbInteractionAttributes,
  ]

  const labelAttributes = [h.Id(labelId(id))]

  const hiddenInputAttributes =
    name !== undefined ? [h.Type('hidden'), h.Name(name), h.Value(value.toString())] : []

  return viewInputs.toView({
    root: childAttributes(rootAttributes),
    track: childAttributes(trackAttributes),
    filledTrack: childAttributes(filledTrackAttributes),
    thumb: childAttributes(thumbAttributes),
    label: childAttributes(labelAttributes),
    hiddenInput: childAttributes(hiddenInputAttributes),
  })
})

export type StyledViewInputs = Readonly<{
  value: number
  min?: number
  max?: number
  orientation?: Orientation
  label?: string
  formatValue?: (value: number) => string
  showsValueWhileDragging?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  isDisabled?: boolean
  isReadOnly?: boolean
  ignoresTouch?: boolean
  name?: string
  getTrackRoot?: () => Document | ShadowRoot
  rootClass?: string
  trackClass?: string
  filledTrackClass?: string
  thumbClass?: string
  rowClass?: string
  labelClass?: string
  valueClass?: string
  headerClass?: string
}>

/** Build styled `Slider.ViewInputs`. Pass your view's `h`. */
export const styledViewInputs = <M>(
  viewInputs: StyledViewInputs,
  h: HtmlBuilder<M>,
): ViewInputs => {
  const orientation = viewInputs.orientation ?? 'horizontal'

  return {
    ...viewInputs,
    orientation,
    toView: (attributes): Html => {
      const maybeHeader: Html =
        viewInputs.label === undefined
          ? h.empty
          : h.div(
              [h.Class(cn(sliderHeaderClass, viewInputs.headerClass))],
              [
                h.label(
                  [...attributes.label, h.Class(cn(sliderLabelClass, viewInputs.labelClass))],
                  [viewInputs.label],
                ),
                h.span(
                  [h.Class(cn(sliderValueClass, viewInputs.valueClass))],
                  [
                    viewInputs.formatValue === undefined
                      ? String(viewInputs.value)
                      : viewInputs.formatValue(viewInputs.value),
                  ],
                ),
              ],
            )

      const maybeDragValue: Html =
        viewInputs.showsValueWhileDragging === true && viewInputs.formatValue !== undefined
          ? h.span(
              [h.AriaHidden(true), h.Class(sliderDragValueClass)],
              [viewInputs.formatValue(viewInputs.value)],
            )
          : h.empty

      const maybeHiddenInput: Html =
        attributes.hiddenInput.length > 0 ? h.input([...attributes.hiddenInput]) : h.empty

      return h.div(
        [h.Class(cn(sliderRowClass, viewInputs.rowClass))],
        [
          maybeHeader,
          h.div(
            [
              ...attributes.root,
              h.DataAttribute('slot', 'slider'),
              h.Class(cn(sliderRootClass, viewInputs.rootClass)),
            ],
            [
              h.div(
                [
                  ...attributes.track,
                  h.DataAttribute('slot', 'slider-track'),
                  h.Class(cn(sliderTrackClass, viewInputs.trackClass)),
                ],
                [
                  h.div([
                    ...attributes.filledTrack,
                    h.DataAttribute('slot', 'slider-range'),
                    h.Class(cn(sliderFilledTrackClass, viewInputs.filledTrackClass)),
                  ]),
                ],
              ),
              h.div(
                [
                  ...attributes.thumb,
                  h.DataAttribute('slot', 'slider-thumb'),
                  h.Class(cn(sliderThumbClass, viewInputs.thumbClass)),
                ],
                [maybeDragValue],
              ),
            ],
          ),
          maybeHiddenInput,
        ],
      )
    },
  }
}
