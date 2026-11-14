/*
 * A fixed light is a plain bright white light with only an on and off switch,
 * such as the closet bulb, which has to light up the whole closet. Nothing
 * changes its color or brightness, and it stays out of every group, so group
 * controls, scenes, the PR flash, and Screen colors never reach it.
 */

export const FIXED_LIGHT_NAMES: ReadonlyArray<string> = ['Closet']

export const FIXED_LIGHT_BRIGHTNESS = 254

/** 4000 K, a neutral white that shows clothes in their real colors. */
export const FIXED_LIGHT_COLOR_TEMP = 250

export const isFixedLight = (name: string): boolean =>
  FIXED_LIGHT_NAMES.includes(name)

export const fixedLightOnPayload = {
  state: 'ON',
  brightness: FIXED_LIGHT_BRIGHTNESS,
  color_temp: FIXED_LIGHT_COLOR_TEMP,
}

export const fixedLightWhitePayload = {
  color_temp: FIXED_LIGHT_COLOR_TEMP,
}
