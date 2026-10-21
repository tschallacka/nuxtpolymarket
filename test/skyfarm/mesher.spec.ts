import { describe, expect, it } from 'vitest'
import { B } from '../../app/utils/skyfarm/blocks'
import { meshBlock } from '../../app/utils/skyfarm/mesher'
import type { BlockPack, PackElement } from '../../app/utils/skyfarm/pack'

const face = { t: 0, uv: [0, 0, 16, 16] as [number, number, number, number] }

/** A pack with one model for the torch: Minecraft's torch, two crossed pairs of planes, unshaded. */
function torchPack(rot?: PackElement['rot']): BlockPack {
    const el = (from: [number, number, number], to: [number, number, number], faces: PackElement['faces']): PackElement => ({ from, to, shade: false, faces, ...(rot ? { rot } : {}) })
    const elements = [
        el([7, 0, 0], [9, 16, 16], { west: face, east: face }),
        el([0, 0, 7], [16, 16, 9], { north: face, south: face }),
        el([7, 0, 7], [9, 10, 9], { up: face, down: face })
    ]
    const looks: BlockPack['looks'] = []
    looks[B.Torch] = { states: [[{ model: 0, x: 0, y: 0, weight: 1 }]], tints: [] }
    return { looks, models: [{ ao: false, elements }], layer: [0], anim: [0] } as unknown as BlockPack
}

/** Each triangle's winding normal (counter-clockwise = front), against the face normal it was given. */
function windings(pack: BlockPack) {
    const { position: p, normal: n, index } = meshBlock(pack, B.Torch)
    const out: number[] = []
    for (let i = 0; i < index.length; i += 3) {
        const [a, b, c] = [index[i]!, index[i + 1]!, index[i + 2]!]
        const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!]
        const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!]
        const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
        out.push(cr[0]! * n[a * 3]! + cr[1]! * n[a * 3 + 1]! + cr[2]! * n[a * 3 + 2]!)
    }
    return out
}

describe('the mesher', () => {
    it('winds unshaded faces (torches, plants) towards the way they face, so they show from the front', () => {
        const w = windings(torchPack())
        expect(w.length).toBe(12)
        for (const d of w) expect(d).toBeGreaterThan(0)
    })

    it('does so for a leaning wall torch too', () => {
        for (const d of windings(torchPack({ origin: [0, 3.5, 8], axis: 'z', angle: -22.5, rescale: false }))) expect(d).toBeGreaterThan(0)
    })
})
