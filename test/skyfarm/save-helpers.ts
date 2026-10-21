import { columnFile, decodeMap, encodeMap, islandFromFiles, mapOf, type SkyfarmIsland } from '#shared/utils/skyfarm/binary'

/**
 * A save as it comes back from its files: the map encoded and read back, the
 * columns written as column files and read back (named by index here: the
 * SHA-256 naming is async, and these tests are about the layouts). Null if the
 * server would refuse the map.
 */
export function throughFile(save: SkyfarmIsland) {
    const hashes = save.columns.map((_, i) => i.toString(16).padStart(64, '0'))
    const files = new Map(save.columns.map((c, i) => [hashes[i]!, columnFile(c)]))
    const map = decodeMap(encodeMap(mapOf(save, hashes)))
    return map && islandFromFiles(map, files)
}

/** Whether the server would accept this save's map. */
export const isValidSave = (save: SkyfarmIsland) => throughFile(save) !== null

/** Bytes in the older JSON save form: (value, count) pairs, then base64. */
export function runs(data: Uint8Array): string {
    const out: number[] = []
    for (let i = 0; i < data.length;) {
        let n = 1
        while (i + n < data.length && data[i + n] === data[i] && n < 255) n++
        out.push(data[i]!, n)
        i += n
    }
    return btoa(String.fromCharCode(...out))
}
