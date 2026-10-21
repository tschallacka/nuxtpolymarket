import type { ItemStack } from '#shared/utils/skyfarm/save'
import { consume, craft } from './crafting'
import { item, type Slots } from './items'

/*
 * Moving items around in a screen, by Minecraft's rules: the stack you have
 * picked up rides on the cursor until you put it down somewhere.
 */

const copy = (s: ItemStack | null) => (s ? { ...s } : null)

/**
 * A click on `slots[i]` with `cursor` held. Left picks up, puts down, merges
 * or swaps whole stacks; right takes half (empty cursor) or puts down one.
 * Returns what the cursor holds afterwards.
 */
export function clickSlot(slots: (ItemStack | null)[], i: number, cursor: ItemStack | null, right: boolean): ItemStack | null {
    const slot = slots[i] ?? null
    if (!cursor) {
        if (!slot) return null
        if (!right) {
            slots[i] = null
            return copy(slot)
        }
        const half = Math.ceil(slot.count / 2)
        slot.count -= half
        if (slot.count === 0) slots[i] = null
        return { item: slot.item, count: half }
    }
    const max = item(cursor.item).maxStack
    if (!slot) {
        if (right) {
            slots[i] = { item: cursor.item, count: 1 }
            return cursor.count > 1 ? { item: cursor.item, count: cursor.count - 1 } : null
        }
        slots[i] = copy(cursor)
        return null
    }
    if (slot.item === cursor.item) {
        const n = Math.min(right ? 1 : cursor.count, max - slot.count)
        if (n <= 0) return cursor
        slot.count += n
        return cursor.count - n > 0 ? { item: cursor.item, count: cursor.count - n } : null
    }
    // A different item: swap them.
    slots[i] = copy(cursor)
    return copy(slot)
}

/** A slot in some row of slots (the inventory, a chest, a crafting grid). */
export interface SlotRef {
    slots: (ItemStack | null)[]
    i: number
}

/** Whether a dragged stack can drop into this slot: empty, or the same item with room. */
export function canDragInto(ref: SlotRef, cursor: ItemStack) {
    const s = ref.slots[ref.i]
    return !s || (s.item === cursor.item && s.count < item(s.item).maxStack)
}

/**
 * Minecraft's drag: the stack on the cursor spread over the slots dragged
 * across. Left shares it out equally (whatever doesn't divide stays on the
 * cursor), right puts one in each. You can't spread over more slots than you
 * have items. Returns what the cursor holds afterwards.
 */
export function dragSplit(targets: SlotRef[], cursor: ItemStack, right: boolean): ItemStack | null {
    const cells = targets.filter(t => canDragInto(t, cursor)).slice(0, cursor.count)
    if (!cells.length) return cursor
    const max = item(cursor.item).maxStack
    const each = right ? 1 : Math.floor(cursor.count / cells.length)
    let left = cursor.count
    for (const c of cells) {
        const s = c.slots[c.i]
        const n = Math.min(each, max - (s?.count ?? 0), left)
        if (n <= 0) continue
        if (s) s.count += n
        else c.slots[c.i] = { item: cursor.item, count: n }
        left -= n
    }
    return left > 0 ? { item: cursor.item, count: left } : null
}

/**
 * A click on the crafting result: takes what the grid makes onto the cursor
 * (if the cursor is empty or holds the same item with room), using up one of
 * each ingredient. Returns the new cursor.
 */
export function takeResult(grid: (ItemStack | null)[], size: number, cursor: ItemStack | null): ItemStack | null {
    const result = craft(grid, size)
    if (!result) return cursor
    if (cursor) {
        if (cursor.item !== result.item || cursor.count + result.count > item(result.item).maxStack) return cursor
        consume(grid)
        return { item: cursor.item, count: cursor.count + result.count }
    }
    consume(grid)
    return result
}

/** Shift-click on the result: crafts as many as the grid and the inventory allow. Returns how many it made. */
export function craftAll(grid: (ItemStack | null)[], size: number, into: Slots): number {
    let made = 0
    for (let guard = 0; guard < 64 * 9; guard++) {
        const result = craft(grid, size)
        if (!result) break
        // Only if all of it fits: test on a copy first.
        const probe = into.slots.map(copy)
        const before = into.slots
        into.slots = probe
        const left = into.add(result.item, result.count)
        into.slots = before
        if (left > 0) break
        into.add(result.item, result.count)
        consume(grid)
        made += result.count
    }
    return made
}
