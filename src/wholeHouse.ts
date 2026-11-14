/*
 * Some bulbs, such as the closet bulb, are not part of the whole house. They
 * are ordinary lights with their own controls, but they stay out of every
 * Zigbee2MQTT group, so whole-house controls, scenes, All on and All off, the
 * PR flash, and Screen colors never reach them.
 */

export const OUTSIDE_WHOLE_HOUSE_NAMES: ReadonlyArray<string> = ['Closet']

export const isOutsideWholeHouse = (name: string): boolean =>
  OUTSIDE_WHOLE_HOUSE_NAMES.includes(name)
