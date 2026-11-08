// Presets live in /app/data/presets.json. Recall sends a normal color command
// to the group that was asked, so bulbs that cannot store a Zigbee scene still
// follow. Rainbow cannot be stored as a Zigbee scene, so the coordinator cycles
// hue on that group until another preset or a manual command takes over.
// Bedroom is intentionally absent: recalling a scene on Rest of the House must
// not address the bedroom lights.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const PRESETS_FILE = process.env.LIGHTS_PRESETS_FILE ?? '/app/data/presets.json'
const PRESET_GROUPS = ['All Lights', 'Rest of the House']
const NAMED_PRESET_GROUP = 'All Lights'
const MAX_NAME_LENGTH = 40
const MIN_BRIGHTNESS = 1
const MAX_BRIGHTNESS = 254
const MIN_COLOR_TEMP = 153
const MAX_COLOR_TEMP = 555

export default class LightPresets {
  constructor(
    zigbee,
    mqtt,
    state,
    publishEntityState,
    eventBus,
    enableDisableExtension,
    restartCallback,
    addExtension,
    settings,
    logger,
  ) {
    this.mqtt = mqtt
    this.eventBus = eventBus
    this.logger = logger
    this.settings = settings
    this.applying = false
    this.loops = new Map()
  }

  async start() {
    this.eventBus.onMQTTMessage(this, data => this.onMessage(data))
    const names = Object.keys(this.loadPresets().byName)
    this.logger.info(
      `Light presets loaded from presets.json: ${names.join(', ')}`,
    )
    await this.publishList()
  }

  stop() {
    for (const group of this.loops.keys()) {
      this.stopLoop(group)
    }
    this.eventBus.removeListeners(this)
  }

  loadPresets() {
    const raw = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'))
    const byName = {}
    const bySceneId = {}
    for (const [name, preset] of Object.entries(raw)) {
      byName[name] = preset
      if (preset.scene_id != null) {
        bySceneId[String(preset.scene_id)] = name
      }
    }
    // The existing Full red button is Zigbee scene 1.
    if (byName['Full red'] && bySceneId['1'] == null) {
      bySceneId['1'] = 'Full red'
    }
    return { byName, bySceneId }
  }

  async onMessage(data) {
    if (this.applying) {
      return
    }
    const topic = data.topic || ''
    const body = this.parse(data.message)
    if (!body || typeof body !== 'object') {
      return
    }
    const base = this.baseTopic()
    if (topic === `${base}/preset/set` && body.name) {
      const group = body.group ?? NAMED_PRESET_GROUP
      if (!PRESET_GROUPS.includes(group)) {
        this.logger.error(`Refusing to apply a preset to ${group}`)
        return
      }
      await this.apply(group, body.name)
      return
    }
    if (topic === `${base}/preset/save`) {
      await this.save(body)
      return
    }
    if (topic === `${base}/preset/delete`) {
      await this.remove(body)
      return
    }
    const group = this.groupFromSetTopic(topic)
    if (!group) {
      return
    }
    if (body.scene_recall != null) {
      const { bySceneId } = this.loadPresets()
      const name = bySceneId[String(body.scene_recall)]
      if (name) {
        await this.apply(group, name)
      } else if (this.loopState(group).active != null) {
        this.stopLoop(group)
      }
      return
    }
    if (this.loopState(group).active != null && !this.ownEcho(group, body)) {
      this.logger.info(
        `Stopping rainbow loop on ${group} because the group received another command`,
      )
      this.stopLoop(group)
    }
  }

  groupFromSetTopic(topic) {
    const base = this.baseTopic()
    const prefix = `${base}/`
    const suffix = '/set'
    if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) {
      return null
    }
    const name = topic.slice(prefix.length, -suffix.length)
    return PRESET_GROUPS.includes(name) ? name : null
  }

  readRaw() {
    return JSON.parse(readFileSync(PRESETS_FILE, 'utf8'))
  }

  writeRaw(entries) {
    const temporary = `${PRESETS_FILE}.tmp`
    writeFileSync(
      temporary,
      `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`,
    )
    renameSync(temporary, PRESETS_FILE)
  }

  async publishList() {
    const list = Object.entries(this.readRaw()).map(([name, preset]) => ({
      name,
      brightness: preset.brightness,
      color: preset.color,
      color_temp: preset.color_temp,
      loop: preset.loop,
    }))
    await this.mqtt.publish('preset/list', JSON.stringify(list), {
      clientOptions: { retain: true },
    })
  }

  async save(body) {
    const preset = validatedPreset(body)
    if (!preset) {
      this.logger.error('Refusing to save an invalid preset')
      return
    }
    const name = body.name.trim()
    const previous =
      typeof body.previous_name === 'string' ? body.previous_name : null
    const entries = Object.entries(this.readRaw())
    const original =
      previous === null
        ? undefined
        : entries.find(([key]) => key === previous)?.[1]
    if (previous !== null && original === undefined) {
      this.logger.error(`Refusing to edit unknown preset '${previous}'`)
      return
    }
    if (original?.loop) {
      this.logger.error(`Refusing to edit loop preset '${previous}'`)
      return
    }
    if (name !== previous && entries.some(([key]) => key === name)) {
      this.logger.error(`Refusing to overwrite preset '${name}'`)
      return
    }
    const sceneId = original?.scene_id ?? nextSceneId(entries)
    const saved = { ...preset, scene_id: sceneId }
    const next =
      original === undefined
        ? [...entries, [name, saved]]
        : entries.map(([key, value]) =>
            key === previous ? [name, saved] : [key, value],
          )
    this.writeRaw(next)
    this.logger.info(`Saved light preset '${name}'`)
    await this.publishList()
  }

  async remove(body) {
    const entries = Object.entries(this.readRaw())
    const found = entries.find(([key]) => key === body.name)
    if (!found) {
      this.logger.error(`Refusing to delete unknown preset '${body.name}'`)
      return
    }
    if (found[1].loop) {
      this.logger.error(`Refusing to delete loop preset '${body.name}'`)
      return
    }
    this.writeRaw(entries.filter(([key]) => key !== body.name))
    this.logger.info(`Deleted light preset '${body.name}'`)
    await this.publishList()
  }

  async apply(group, name) {
    this.stopLoop(group)
    const { byName } = this.loadPresets()
    const preset = byName[name]
    if (!preset) {
      this.logger.error(`Unknown light preset '${name}'`)
      return
    }
    if (preset.loop?.type === 'rainbow') {
      const loop = this.loopState(group)
      const generation = loop.generation
      loop.active = generation
      this.logger.info(
        `Applying light preset '${name}' to ${group} from the coordinator`,
      )
      await this.runRainbow(group, preset, generation)
      return
    }
    const payload = {
      state: preset.state ?? 'ON',
      brightness: preset.brightness,
    }
    // Full red sends color. Nice lighting sends color_temp so the
    // white LEDs are used instead of a mixed RGB tint.
    if (preset.color != null) {
      payload.color = preset.color
    }
    if (preset.color_temp != null) {
      payload.color_temp = preset.color_temp
    }
    this.logger.info(
      `Applying light preset '${name}' to ${group} from the coordinator`,
    )
    await this.publish(group, payload)
  }

  async runRainbow(group, preset, generation) {
    // IKEA color bulbs freeze and drop new colors until a fade finishes.
    // Any transition above 0 starts that freeze, and a step faster than
    // the bulb can apply looks like the light is stuck. Color only, no fade.
    const interval = Math.max(400, Number(preset.loop.interval_ms) || 600)
    const step = Number(preset.loop.hue_step) || 20
    let hue = 0
    let primed = false
    const tick = async () => {
      const loop = this.loopState(group)
      if (loop.generation !== generation) {
        return
      }
      const hex = hueToHex(hue)
      this.rememberHex(group, hex)
      const payload = { color: { hex } }
      if (!primed) {
        payload.state = preset.state ?? 'ON'
        payload.brightness = preset.brightness ?? 254
        primed = true
      }
      try {
        await this.publish(group, payload)
      } catch (error) {
        this.logger.error(`Rainbow frame failed on ${group}: ${error}`)
      }
      if (this.loopState(group).generation !== generation) {
        return
      }
      hue = (hue + step) % 360
      loop.timer = setTimeout(tick, interval)
    }
    this.logger.info(
      `Rainbow loop on ${group}: ${step} degrees every ${interval}ms`,
    )
    await tick()
  }

  loopState(group) {
    let loop = this.loops.get(group)
    if (!loop) {
      loop = { generation: 0, active: null, timer: null, recentHex: [] }
      this.loops.set(group, loop)
    }
    return loop
  }

  stopLoop(group) {
    const loop = this.loopState(group)
    loop.generation += 1
    loop.active = null
    if (loop.timer) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
  }

  rememberHex(group, hex) {
    const recent = this.loopState(group).recentHex
    recent.push(hex)
    if (recent.length > 48) {
      recent.shift()
    }
  }

  ownEcho(group, body) {
    const hex = body?.color?.hex
    if (typeof hex !== 'string') {
      return false
    }
    return this.loopState(group).recentHex.includes(hex.toUpperCase())
  }

  async publish(group, payload) {
    if (!PRESET_GROUPS.includes(group)) {
      throw new Error(`Refusing to publish a preset to ${group}`)
    }
    this.applying = true
    try {
      await this.mqtt.publish(`${group}/set`, JSON.stringify(payload), {
        skipReceive: false,
      })
    } finally {
      this.applying = false
    }
  }

  baseTopic() {
    return this.settings.get().mqtt.base_topic
  }

  parse(message) {
    if (message == null) {
      return null
    }
    if (typeof message === 'object') {
      return message
    }
    try {
      return JSON.parse(message)
    } catch {
      return null
    }
  }
}

function validatedPreset(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '' || name.length > MAX_NAME_LENGTH || name === '__proto__') {
    return null
  }
  const brightness = body.brightness
  if (
    !Number.isInteger(brightness) ||
    brightness < MIN_BRIGHTNESS ||
    brightness > MAX_BRIGHTNESS
  ) {
    return null
  }
  const hex = body.color?.hex
  if (
    typeof hex === 'string' &&
    /^#[0-9a-f]{6}$/i.test(hex) &&
    body.color_temp === undefined
  ) {
    return { state: 'ON', brightness, color: { hex: hex.toUpperCase() } }
  }
  const colorTemp = body.color_temp
  if (
    Number.isInteger(colorTemp) &&
    colorTemp >= MIN_COLOR_TEMP &&
    colorTemp <= MAX_COLOR_TEMP &&
    body.color === undefined
  ) {
    return { state: 'ON', brightness, color_temp: colorTemp }
  }
  return null
}

function nextSceneId(entries) {
  return (
    entries.reduce(
      (highest, [, preset]) => Math.max(highest, preset.scene_id ?? 0),
      0,
    ) + 1
  )
}

function hueToHex(hue) {
  const h = ((hue % 360) + 360) % 360
  const c = 1
  const x = 1 - Math.abs(((h / 60) % 2) - 1)
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
    b = 0
  } else if (h < 120) {
    r = x
    g = c
    b = 0
  } else if (h < 180) {
    r = 0
    g = c
    b = x
  } else if (h < 240) {
    r = 0
    g = x
    b = c
  } else if (h < 300) {
    r = x
    g = 0
    b = c
  } else {
    r = c
    g = 0
    b = x
  }
  const byte = n =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${byte(r)}${byte(g)}${byte(b)}`
}
