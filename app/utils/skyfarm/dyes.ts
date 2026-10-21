/*
 * Dyes, Minecraft's colours and recipes. Brown is missing: in Minecraft it
 * only comes from cocoa beans, which grow on jungle trees a skyblock doesn't
 * have. A sheep's colour is saved as its place in this list: append only.
 */

/** Each colour and its tint (Minecraft's DyeColor diffuse colour), white first. */
export const DYE_COLORS = [
    ['white', 0xf9fffe], ['orange', 0xf9801d], ['magenta', 0xc74ebd], ['light_blue', 0x3ab3da], ['yellow', 0xfed83d],
    ['lime', 0x80c71f], ['pink', 0xf38baa], ['gray', 0x474f52], ['light_gray', 0x9d9d97], ['cyan', 0x169c9c],
    ['purple', 0x8932b8], ['blue', 0x3c44aa], ['green', 0x5e7c16], ['red', 0xb02e26], ['black', 0x1d1d21]
] as const

export type DyeColor = typeof DYE_COLORS[number][0]

export const dyeKey = (color: DyeColor) => `${color}_dye`
export const woolKey = (color: DyeColor) => `${color}_wool`

/** The colour a dye item gives, or null if `key` isn't a dye. */
export function dyeColor(key: string): DyeColor | null {
    if (!key.endsWith('_dye')) return null
    const color = key.slice(0, -4)
    return DYE_COLORS.some(([c]) => c === color) ? color as DyeColor : null
}

/** A colour's place in DYE_COLORS (0 for white, or for anything unknown). */
export const colorIndex = (color: DyeColor) => Math.max(0, DYE_COLORS.findIndex(([c]) => c === color))

/** What each flower (and bone meal, and an ink sac) crafts into, alone in the grid: Minecraft's. */
export const DYE_SOURCES: [string, DyeColor, number][] = [
    ['dandelion', 'yellow', 1], ['sunflower', 'yellow', 2],
    ['poppy', 'red', 1], ['red_tulip', 'red', 1], ['rose_bush', 'red', 2],
    ['azure_bluet', 'light_gray', 1], ['oxeye_daisy', 'light_gray', 1], ['white_tulip', 'light_gray', 1],
    ['cornflower', 'blue', 1], ['orange_tulip', 'orange', 1], ['pink_tulip', 'pink', 1], ['peony', 'pink', 2],
    ['lilac', 'magenta', 2], ['bone_meal', 'white', 1], ['ink_sac', 'black', 1]
]

/** Dyes mixed in the grid (shapeless): the dyes that go in, and how many come out. */
export const DYE_MIXES: [DyeColor[], DyeColor, number][] = [
    [['red', 'yellow'], 'orange', 2],
    [['green', 'white'], 'lime', 2],
    [['red', 'white'], 'pink', 2],
    [['black', 'white'], 'gray', 2],
    [['gray', 'white'], 'light_gray', 2],
    [['black', 'white', 'white'], 'light_gray', 3],
    [['blue', 'green'], 'cyan', 2],
    [['blue', 'red'], 'purple', 2],
    [['purple', 'pink'], 'magenta', 2],
    [['blue', 'red', 'pink'], 'magenta', 3],
    [['blue', 'red', 'red', 'white'], 'magenta', 4],
    [['blue', 'white'], 'light_blue', 2]
]
