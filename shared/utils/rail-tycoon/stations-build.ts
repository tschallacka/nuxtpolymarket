/**
 * Station building: rail stations (W20) and drive-through road stops (W21). Behaviour mimics the
 * original game at its default settings (adjacent tiles join an own station, station spread 12,
 * drive-through stops allowed on town roads); the code is written from scratch.
 *
 * Station payload (kind station):
 *   bits 0-15   station id
 *   bits 16-17  tile type (RtStationTile: rail platform, bus stop, truck stop)
 *   bit  18     axis: 0 along x, 1 along y (the platform track, or the stop's road)
 *   bit  19     reservation of a platform tile (AR-100), set and checked by reservePath (W29)
 *   bits 20-23  unused, 0
 *   bits 24-31  road stops: owner of the road under the stop (RT_OWNER_NONE a town), restored on demolish
 * The tile's owner byte is the station owner. A road stop always carries the full straight road along
 * its axis; a platform the straight track along its axis.
 */

import { clampUtf8 } from './bytes'
import { RT_CARGO_IDS, RT_CATALOG } from './catalog'
import { manhattan } from './economy'
import { RtMap, RtTileKind } from './map'
import { rtRoadBits } from './road'
import {
    RT_ROAD_X,
    RT_ROAD_Y,
    RtBuildError,
    RtTrack,
    rtBitCount,
    rtBuildFail,
    rtBuildOk,
    rtClearingCost,
    rtIsCrossing,
    rtRailHasSignals,
    rtRailPieceReserved,
    rtRailPieces,
    rtValidCompany,
    type RtBuildResult,
    type RtOccupied
} from './track'
import { RT_NONE, RT_OWNER_NONE, RtFacility, type RtStation, type RtStationCargo, type RtTown } from './types'

/** Kind of a station tile. */
export const RtStationTile = { rail: 0, bus: 1, truck: 2 } as const
export type RtStationTile = typeof RtStationTile[keyof typeof RtStationTile]

/** Platform axis: along x (track x) or along y (track y). */
export const RtAxis = { x: 0, y: 1 } as const
export type RtAxis = typeof RtAxis[keyof typeof RtAxis]

export const RT_STATION_ID_MASK = 0xffff
export const RT_STATION_TYPE_SHIFT = 16
export const RT_STATION_AXIS_BIT = 1 << 18
export const RT_STATION_RESERVED_BIT = 1 << 19
export const RT_STATION_ROAD_OWNER_SHIFT = 24

/** Most platforms and longest platform one rail station build may make. */
export const RT_MAX_PLATFORMS = 4
export const RT_MAX_PLATFORM_LENGTH = 7

export function rtStationPayload(id: number, type: RtStationTile, axis: RtAxis, roadOwner = 0): number {
    return ((id & RT_STATION_ID_MASK)
        | (type << RT_STATION_TYPE_SHIFT)
        | (axis === RtAxis.y ? RT_STATION_AXIS_BIT : 0)
        | ((roadOwner & 0xff) << RT_STATION_ROAD_OWNER_SHIFT)) >>> 0
}

export function rtStationId(payload: number): number {
    return payload & RT_STATION_ID_MASK
}

export function rtStationTileType(payload: number): RtStationTile {
    return ((payload >>> RT_STATION_TYPE_SHIFT) & 3) as RtStationTile
}

export function rtStationAxis(payload: number): RtAxis {
    return (payload & RT_STATION_AXIS_BIT) !== 0 ? RtAxis.y : RtAxis.x
}

/** The track piece a platform holds (the straight along its axis). */
export function rtPlatformTrack(payload: number): RtTrack {
    return rtStationAxis(payload) === RtAxis.y ? RtTrack.y : RtTrack.x
}

/** Road bits a road stop carries: the full straight along its axis. */
export function rtRoadStopBits(payload: number): number {
    return rtStationAxis(payload) === RtAxis.y ? RT_ROAD_Y : RT_ROAD_X
}

/** Owner of the road under a road stop (RT_OWNER_NONE a town road). */
export function rtRoadStopRoadOwner(payload: number): number {
    return (payload >>> RT_STATION_ROAD_OWNER_SHIFT) & 0xff
}

export function rtPlatformReserved(payload: number): boolean {
    return (payload & RT_STATION_RESERVED_BIT) !== 0
}

export function rtWithPlatformReservation(payload: number, reserved: boolean): number {
    return (reserved ? payload | RT_STATION_RESERVED_BIT : payload & ~RT_STATION_RESERVED_BIT) >>> 0
}

/** Facility bit of a station tile type. */
export function rtFacilityOf(type: RtStationTile): number {
    return type === RtStationTile.rail ? RtFacility.rail : type === RtStationTile.bus ? RtFacility.busStop : RtFacility.truckStop
}

/* ------------------------------------------------------------------------------------------
 * Shared helpers
 * ---------------------------------------------------------------------------------------- */

/** The station with this id in a list kept in ascending id order, or undefined. */
export function rtFindStation(stations: readonly RtStation[], id: number): RtStation | undefined {
    for (const station of stations) {
        if (station.id === id) return station
    }
    return undefined
}

/** A fresh per-cargo state: the starting rating, nothing waiting, never served. */
export function rtNewStationCargo(): RtStationCargo {
    return {
        rating: RT_CATALOG.stationRating.start,
        hasRating: false,
        loadAttempted: false,
        packets: [],
        fraction: 0,
        cyclesSincePickup: 0,
        maxWaiting: 0,
        lastSpeed: 0,
        lastAge: 0
    }
}

/** The lowest station id no station uses, as the original's pool hands out ids. */
function lowestFreeId(stations: readonly RtStation[]): number {
    const used = new Set<number>()
    for (const station of stations) used.add(station.id)
    let id = 0
    while (used.has(id)) id++
    return id
}

/** The town nearest a tile by Manhattan distance, the lowest id on a tie, or undefined without towns. */
function nearestTown(map: RtMap, towns: readonly RtTown[], tile: number): RtTown | undefined {
    let best: RtTown | undefined
    let bestDistance = Infinity
    for (const town of towns) {
        if (!town || !map.validTile(town.centre)) continue
        const d = manhattan(tile, town.centre, map.side)
        if (d < bestDistance || (d === bestDistance && best !== undefined && town.id < best.id)) {
            best = town
            bestDistance = d
        }
    }
    return best
}

/** The town's name, or "<name> N" with the lowest N from 2 that no station uses, within maxNameBytes. */
function uniqueStationName(base: string, stations: readonly RtStation[]): string {
    const max = RT_CATALOG.caps.maxNameBytes
    const taken = new Set<string>()
    for (const station of stations) taken.add(station.name)
    const plain = clampUtf8(base, max)
    if (!taken.has(plain)) return plain
    for (let n = 2; ; n++) {
        const suffix = ` ${n}`
        const name = clampUtf8(base, max - suffix.length) + suffix
        if (!taken.has(name)) return name
    }
}

function newStation(map: RtMap, stations: readonly RtStation[], towns: readonly RtTown[], owner: number, sign: number): RtStation {
    const town = nearestTown(map, towns, sign)
    const id = lowestFreeId(stations)
    return {
        id,
        owner,
        name: uniqueStationName(town ? town.name : 'Station', stations),
        town: town ? town.id : RT_NONE,
        sign,
        tiles: [],
        tilesRevision: 0,
        facilities: 0,
        cargo: RT_CARGO_IDS.map(() => rtNewStationCargo()),
        acceptance: 0,
        lastPickupTick: RT_NONE,
        lastDeliveryTick: RT_NONE,
        lastVehicleKind: RT_NONE,
        catchment: null,
        catchmentRevision: RT_NONE
    }
}

/** Inserts a station keeping the list in ascending id order. */
function insertStation(stations: RtStation[], station: RtStation): void {
    let at = stations.length
    while (at > 0 && stations[at - 1]!.id > station.id) at--
    stations.splice(at, 0, station)
}

/**
 * The own station the given tiles join: every own station tile in the 3 by 3 ring around each tile
 * counts, as the original. Returns the station id, RT_NONE when none adjoins, or null when two or
 * more different own stations adjoin.
 */
function adjoiningStation(map: RtMap, owner: number, tiles: readonly number[]): number | null {
    let found: number = RT_NONE
    const side = map.side
    for (const tile of tiles) {
        const x = map.tileX(tile)
        const y = map.tileY(tile)
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx
                const ny = y + dy
                if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue
                const n = ny * side + nx
                if (map.kind[n] !== RtTileKind.station || map.owner[n] !== owner) continue
                const id = rtStationId(map.payload[n]!)
                if (found === RT_NONE) found = id
                else if (found !== id) return null
            }
        }
    }
    return found
}

/** Whether a station's tiles plus the new ones span at most stationSpread tiles in each direction (AR-101). */
function withinSpread(map: RtMap, existing: readonly number[], added: readonly number[]): boolean {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const list of [existing, added]) {
        for (const tile of list) {
            const x = map.tileX(tile)
            const y = map.tileY(tile)
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }
    const spread = RT_CATALOG.stations.stationSpread
    return maxX - minX + 1 <= spread && maxY - minY + 1 <= spread
}

/**
 * Resolves which station a build joins or whether it creates one: the joined station, a fresh
 * (unlisted) station, or a refusal. Checks the adjoining rule, the spread and the station cap.
 */
function resolveStation(
    map: RtMap, stations: readonly RtStation[], towns: readonly RtTown[], owner: number, tiles: readonly number[], sign: number
): { station: RtStation, created: boolean } | RtBuildError {
    const join = adjoiningStation(map, owner, tiles)
    if (join === null) return RtBuildError.conflict
    if (join !== RT_NONE) {
        const station = rtFindStation(stations, join)
        if (!station || station.owner !== owner) return RtBuildError.invalid
        if (!withinSpread(map, station.tiles, tiles)) return RtBuildError.tooSpread
        return { station, created: false }
    }
    if (stations.length >= RT_CATALOG.caps.maxStations) return RtBuildError.limit
    if (!withinSpread(map, [], tiles)) return RtBuildError.tooSpread
    return { station: newStation(map, stations, towns, owner, sign), created: true }
}

/** Adds tiles to a station (ascending), bumps its revision and facility bits, listing it when new. */
function commitTiles(stations: RtStation[], station: RtStation, created: boolean, tiles: readonly number[], type: RtStationTile): void {
    if (created) insertStation(stations, station)
    for (const tile of tiles) {
        if (!station.tiles.includes(tile)) station.tiles.push(tile)
    }
    station.tiles.sort((a, b) => a - b)
    station.tilesRevision++
    station.facilities |= rtFacilityOf(type)
}

/* ------------------------------------------------------------------------------------------
 * W20: rail stations
 * ---------------------------------------------------------------------------------------- */

/**
 * Builds a rail station of `tracks` platforms (1 to 4) of `length` tiles (1 to 7) from the north
 * corner tile `origin`, platforms running along `axis`. The footprint must lie on the map, be flat and
 * hold only clear land, trees (cleared at catalog cost) or the company's own unsignalled, unreserved
 * straight rail along the axis (reused; refused with occupied on a vehicle when occupied is given).
 * Touching one own station (the 3 by 3 ring) joins it, touching two is refused, otherwise a new
 * station named after the nearest town is created (RT_CATALOG caps.maxStations bounds it). The station
 * stays within stationSpread (AR-101). Cost per tile railStationTile plus track, plus
 * railStationLength per platform length, as the original. Returns the station id on success.
 */
export function buildRailStation(
    map: RtMap, stations: RtStation[], towns: readonly RtTown[], owner: number, origin: number,
    axis: number, tracks: number, length: number, apply: boolean, occupied?: RtOccupied
): RtBuildResult {
    if (!rtValidCompany(owner) || !map.validTile(origin) || !Array.isArray(stations) || !Array.isArray(towns)) {
        return rtBuildFail(RtBuildError.invalid)
    }
    if (axis !== RtAxis.x && axis !== RtAxis.y) return rtBuildFail(RtBuildError.invalid)
    if (!Number.isInteger(tracks) || tracks < 1 || tracks > RT_MAX_PLATFORMS) return rtBuildFail(RtBuildError.invalid)
    if (!Number.isInteger(length) || length < 1 || length > RT_MAX_PLATFORM_LENGTH) return rtBuildFail(RtBuildError.invalid)
    const w = axis === RtAxis.x ? length : tracks
    const h = axis === RtAxis.x ? tracks : length
    const ox = map.tileX(origin)
    const oy = map.tileY(origin)
    if (ox + w > map.side || oy + h > map.side) return rtBuildFail(RtBuildError.edge)

    const prices = RT_CATALOG.construction
    const piece = axis === RtAxis.x ? RtTrack.x : RtTrack.y
    const tiles: number[] = []
    let cost = length * prices.railStationLength
    for (let y = oy; y < oy + h; y++) {
        for (let x = ox; x < ox + w; x++) {
            const tile = map.idx(x, y)
            switch (map.kind[tile]) {
                case RtTileKind.water:
                    return rtBuildFail(RtBuildError.water)
                case RtTileKind.clear:
                case RtTileKind.coast:
                case RtTileKind.tree:
                    break
                case RtTileKind.rail: {
                    if (map.owner[tile] !== owner) return rtBuildFail(RtBuildError.notOwner)
                    const payload = map.payload[tile]!
                    if (rtIsCrossing(payload) || rtRailPieces(payload) !== 1 << piece) return rtBuildFail(RtBuildError.occupied)
                    if (rtRailHasSignals(payload) || rtRailPieceReserved(payload, piece)) return rtBuildFail(RtBuildError.conflict)
                    if (occupied && occupied(tile)) return rtBuildFail(RtBuildError.conflict)
                    break
                }
                case RtTileKind.station:
                case RtTileKind.depot:
                    return rtBuildFail(map.owner[tile] !== owner ? RtBuildError.notOwner : RtBuildError.occupied)
                default:
                    return rtBuildFail(RtBuildError.occupied)
            }
            if (!map.isFlat(tile)) return rtBuildFail(RtBuildError.badSlope)
            cost += prices.railStationTile + prices.track + rtClearingCost(map, tile)
            tiles.push(tile)
        }
    }

    const resolved = resolveStation(map, stations, towns, owner, tiles, origin)
    if (typeof resolved === 'number') return rtBuildFail(resolved)
    const { station, created } = resolved
    if (apply === true) {
        const payload = rtStationPayload(station.id, RtStationTile.rail, axis)
        for (const tile of tiles) map.setTile(tile, RtTileKind.station, owner, payload)
        commitTiles(stations, station, created, tiles, RtStationTile.rail)
    }
    return rtBuildOk(cost, station.id)
}

/* ------------------------------------------------------------------------------------------
 * W21: road stops
 * ---------------------------------------------------------------------------------------- */

/**
 * Builds a drive-through bus or truck stop (`kind` RtStationTile.bus or .truck) on a straight own or
 * town road on flat land; a half road along one axis is completed at road cost, as the original. A
 * junction, a corner, other companies' roads, a level crossing and a vehicle on the tile (when
 * occupied is given) are refused. Joins an adjoining own station or creates one, within stationSpread
 * (AR-101). The tile keeps its road (the full straight) and remembers the road owner, so demolishing
 * the stop gives a town road back to the town (AR-51). Returns the station id on success.
 */
export function buildRoadStop(
    map: RtMap, stations: RtStation[], towns: readonly RtTown[], owner: number, tile: number,
    kind: number, apply: boolean, occupied?: RtOccupied
): RtBuildResult {
    if (!rtValidCompany(owner) || !map.validTile(tile) || !Array.isArray(stations) || !Array.isArray(towns)) {
        return rtBuildFail(RtBuildError.invalid)
    }
    if (kind !== RtStationTile.bus && kind !== RtStationTile.truck) return rtBuildFail(RtBuildError.invalid)
    switch (map.kind[tile]) {
        case RtTileKind.road:
            break
        case RtTileKind.water:
            return rtBuildFail(RtBuildError.water)
        default:
            return rtBuildFail(RtBuildError.conflict)
    }
    const roadOwner = map.owner[tile]!
    if (roadOwner !== owner && roadOwner !== RT_OWNER_NONE) return rtBuildFail(RtBuildError.notOwner)
    const bits = rtRoadBits(map.payload[tile]!)
    const axis = (bits & ~RT_ROAD_X) === 0 ? RtAxis.x : (bits & ~RT_ROAD_Y) === 0 ? RtAxis.y : -1
    if (bits === 0 || axis < 0) return rtBuildFail(RtBuildError.conflict)
    if (!map.isFlat(tile)) return rtBuildFail(RtBuildError.badSlope)
    if (occupied && occupied(tile)) return rtBuildFail(RtBuildError.conflict)

    const prices = RT_CATALOG.construction
    const cost = prices.roadStop + prices.road * (2 - rtBitCount(bits))
    const resolved = resolveStation(map, stations, towns, owner, [tile], tile)
    if (typeof resolved === 'number') return rtBuildFail(resolved)
    const { station, created } = resolved
    if (apply === true) {
        map.setTile(tile, RtTileKind.station, owner, rtStationPayload(station.id, kind as RtStationTile, axis as RtAxis, roadOwner))
        commitTiles(stations, station, created, [tile], kind as RtStationTile)
    }
    return rtBuildOk(cost, station.id)
}
