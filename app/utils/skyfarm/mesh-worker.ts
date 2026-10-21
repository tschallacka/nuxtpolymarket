import { meshChunk, type MeshData, type MeshPack } from './mesher'
import { World } from './world'

/*
 * Builds chunk meshes off the main thread. Working out a column's light and
 * faces takes ~20 ms, more than a frame has, and a busy island changes every
 * column all the time: here it costs the frame nothing. The engine sends the
 * pack's model data once, then per job the column and its eight neighbours
 * (light and faces reach across chunk edges); the meshes and the light come
 * back as transferred arrays.
 */

export interface MeshJob {
    type: 'mesh'
    job: number
    cx: number
    cz: number
    /** The column and those around it that exist: their blocks and meta (copies, transferred). */
    columns: { cx: number, cz: number, blocks: Uint8Array, meta: Uint8Array }[]
}

export interface MeshResult {
    job: number
    cx: number
    cz: number
    opaque: MeshData
    cutout: MeshData
    translucent: MeshData
    sky: Uint8Array
    block: Uint8Array
}

let pack: MeshPack | null = null

const buffers = (m: MeshData) => [m.position, m.normal, m.color, m.uv, m.layer, m.anim, m.light, m.index].map(a => a.buffer)

self.onmessage = (e: MessageEvent<{ type: 'pack', pack: MeshPack } | MeshJob>) => {
    const msg = e.data
    if (msg.type === 'pack') {
        pack = msg.pack
        return
    }
    if (!pack) return
    const world = new World()
    for (const c of msg.columns) {
        const chunk = world.addChunk(c.cx, c.cz)
        chunk.blocks.set(c.blocks)
        chunk.meta.set(c.meta)
    }
    const chunk = world.chunks.get(`${msg.cx},${msg.cz}`)
    if (!chunk) return
    const data = meshChunk(world, chunk, pack)
    const result: MeshResult = { job: msg.job, cx: msg.cx, cz: msg.cz, opaque: data.opaque, cutout: data.cutout, translucent: data.translucent, sky: data.light.sky, block: data.light.block }
    const transfer = [...buffers(data.opaque), ...buffers(data.cutout), ...buffers(data.translucent), data.light.sky.buffer, data.light.block.buffer]
    ;(self as unknown as Worker).postMessage(result, transfer as Transferable[])
}
