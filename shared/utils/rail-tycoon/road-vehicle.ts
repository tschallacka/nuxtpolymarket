/**
 * Road vehicle movement (W49): one tick of one bus or truck, as the original's road vehicle
 * controller. The plan places stepRoadVehicle in vehicles.ts; it lives here, beside train.ts, so
 * world.ts (W57) can import it without a cycle.
 *
 * A road vehicle is half a tile long. tiles[0] is the head's tile and pieces[0] its lane there: the
 * direction it leaves that tile by, so the two directions of a road are two lanes and a corner's
 * lanes differ by exit. progress runs from the lane's entry edge (0) to its exit edge (subTileUnits).
 * While the head is less than a body length into its tile, the vehicle also holds the lane it came
 * from, as tiles[1]. A vehicle keeps roadLaneGap behind the one ahead in its lane; held there for
 * roadBlockedTicks it drives through, as the original's last resort (AR-127). It turns round in its
 * tile at a road end, or at once when the best route starts behind it (AR-43), and waits before a
 * level crossing while the barriers are down (AR-60).
 */

import { RT_CATALOG } from './catalog'
import { rtDepotFacing, rtDepotKind } from './depots'
import { RT_ROAD_DIR_BIT, RtDir, RtTileKind, rtReverseDir, type RtMap } from './map'
import { advanceOrder, rtCurrentOrder } from './orders'
import { findRoadRoute, rtDepotTarget, rtStationRoadTarget, RtRouteOutcome, type RtRouteTarget } from './pathfinder'
import { rtPieceReserved } from './signals'
import { RT_STATION_AXIS_BIT, RtStationTile, rtStationId, rtStationTileType } from './stations-build'
import { RT_ROAD_X, RT_ROAD_Y, RtTrack, rtCrossingRoadBits, rtIsCrossing, rtTrackdirExitDir } from './track'
import type { RtTrainHooks } from './train'
import { RT_NONE, RtOrderKind, RtVehicleKind, RtVehicleState, type RtVehicle } from './types'
import { rtBreakdownTick, rtConsistMaxSpeed, rtCountRunningTick, rtModelSpec, rtServiceInDepot } from './vehicles'
import type { RtWorld } from './world'

/** W51's side of a stop: the same hooks as a train's. Without hooks a stop ends on the next tick. */
export type RtRoadHooks = RtTrainHooks

export interface RtRoadStepResult {
    /** A crashed vehicle whose crash period ran out: the caller removes it (rtRemoveTrain works for both kinds). */
    remove: boolean
    /** The vehicle ran a route search this tick (W57's round-robin cursor). */
    searched: boolean
}

const M = RT_CATALOG.movement
const PF = RT_CATALOG.pathfinder
const TILE = M.subTileUnits
const GAP = M.roadLaneGap
/** Body length: the vehicle holds the tile behind its head until the head is this far in. */
const BODY = M.roadLaneGap

function bitOf(dir: number): number {
    return RT_ROAD_DIR_BIT[dir]!
}

/** Road bits a road vehicle can drive on a tile: road, a level crossing's straight, a drive-through stop's straight. */
function roadBits(map: RtMap, tile: number): number {
    const payload = map.payload[tile]!
    switch (map.kind[tile]) {
        case RtTileKind.road:
            return payload & 15
        case RtTileKind.rail:
            return rtIsCrossing(payload) ? rtCrossingRoadBits(payload) : 0
        case RtTileKind.station:
            if (rtStationTileType(payload) === RtStationTile.rail) return 0
            return (payload & RT_STATION_AXIS_BIT) !== 0 ? RT_ROAD_Y : RT_ROAD_X
        default:
            return 0
    }
}

/** The stop type the vehicle loads at: buses at bus stops, every other road vehicle at truck stops. */
function stopType(vehicle: RtVehicle): RtStationTile {
    return rtModelSpec(vehicle.model)?.cargo === 'passengers' ? RtStationTile.bus : RtStationTile.truck
}

/** The depot the vehicle is heading for (a service visit or a depot order), or RT_NONE. */
function targetDepot(vehicle: RtVehicle): number {
    if (vehicle.serviceDepot !== RT_NONE) return vehicle.serviceDepot
    const order = rtCurrentOrder(vehicle)
    return order && order.kind === RtOrderKind.gotoDepot ? order.target : RT_NONE
}

/** Whether the vehicle has just loaded at `station` and still stands on its stop (no second stop in a row there, as the original). */
function justLeft(vehicle: RtVehicle, station: number): boolean {
    return vehicle.state !== RtVehicleState.loading && station !== RT_NONE && vehicle.loadingStation === station
}

/** The station the vehicle is heading for, or RT_NONE. */
function targetStation(vehicle: RtVehicle): number {
    if (vehicle.serviceDepot !== RT_NONE) return RT_NONE
    const order = rtCurrentOrder(vehicle)
    return order && order.kind === RtOrderKind.gotoStation && !justLeft(vehicle, order.target) ? order.target : RT_NONE
}

function isStopOf(map: RtMap, tile: number, station: number, type: RtStationTile): boolean {
    if (station === RT_NONE || !map.validTile(tile) || map.kind[tile] !== RtTileKind.station) return false
    const payload = map.payload[tile]!
    return rtStationTileType(payload) === type && rtStationId(payload) === station
}

/** Whether the vehicle may drive into its target road depot from `from` along `dir`. */
function depotAhead(map: RtMap, vehicle: RtVehicle, next: number, dir: number): boolean {
    if (next < 0 || map.kind[next] !== RtTileKind.depot || next !== targetDepot(vehicle)) return false
    const payload = map.payload[next]!
    return rtDepotKind(payload) === RtVehicleKind.road && rtDepotFacing(payload) === rtReverseDir(dir as RtDir)
}

/** Where the current order (or a pending service visit) sends the vehicle; null when it has nowhere to go. */
function orderTarget(world: RtWorld, vehicle: RtVehicle): RtRouteTarget | null {
    const depot = targetDepot(vehicle)
    if (depot !== RT_NONE) return world.map.validTile(depot) ? rtDepotTarget(depot) : null
    const station = targetStation(vehicle)
    const found = station !== RT_NONE ? world.station(station) : null
    return found ? rtStationRoadTarget(world.map, found, stopType(vehicle)) : null
}

/**
 * Whether a level crossing's barriers are down (AR-60): a train holds its piece, a path reservation
 * runs through it, or a train's head stands on an adjacent rail tile heading into it.
 */
export function rtCrossingBarred(world: RtWorld, tile: number): boolean {
    const map = world.map
    if (!map.validTile(tile) || map.kind[tile] !== RtTileKind.rail || !rtIsCrossing(map.payload[tile]!)) return false
    const piece = (map.payload[tile]! & (1 << RtTrack.x)) !== 0 ? RtTrack.x : RtTrack.y
    if (world.occupied.trainOnPiece(tile, piece) || rtPieceReserved(map, tile, piece)) return true
    const sides = piece === RtTrack.x ? [RtDir.ne, RtDir.sw] : [RtDir.se, RtDir.nw]
    for (const side of sides) {
        const adjacent = map.neighbour(tile, side)
        if (adjacent < 0 || map.kind[adjacent] !== RtTileKind.rail) continue
        for (let q = 0; q < 6; q++) {
            for (const id of world.occupied.trainsOnPiece(adjacent, q)) {
                const train = world.vehicle(id)
                if (train && train.tiles[0] === adjacent && rtTrackdirExitDir(train.pieces[0]!) === rtReverseDir(side)) return true
            }
        }
    }
    return false
}

/** Points the vehicle at a new route from its head tile. */
function setRoute(world: RtWorld, vehicle: RtVehicle, route: number[]): void {
    vehicle.route = route.slice(0, RT_CATALOG.caps.maxRouteLength)
    vehicle.routeIndex = 0
    vehicle.reservedEnd = 0
    vehicle.routeTick = world.tick
}

/** Drops the tile behind the head (the body has left it). */
function dropTail(world: RtWorld, vehicle: RtVehicle): void {
    while (vehicle.tiles.length > 1) {
        const tile = vehicle.tiles.pop()!
        const lane = vehicle.pieces.pop()!
        world.occupied.releaseRoad(vehicle.id, tile, lane)
        world.markDirty(tile)
    }
}

/** Turns the vehicle round in its head tile (AR-43): it continues in the other lane from where it stands. */
function turnAround(world: RtWorld, vehicle: RtVehicle): void {
    dropTail(world, vehicle)
    const tile = vehicle.tiles[0]!
    const lane = vehicle.pieces[0]!
    const back = rtReverseDir(lane as RtDir)
    world.occupied.releaseRoad(vehicle.id, tile, lane)
    world.occupied.holdRoad(vehicle.id, tile, back)
    vehicle.pieces[0] = back
    vehicle.direction = back
    vehicle.progress = Math.max(0, TILE - vehicle.progress)
    vehicle.route = []
    vehicle.routeIndex = 0
    vehicle.routeTick = RT_NONE
    world.markDirty(tile)
}

/** Searches a route when the vehicle needs one and the tick's node budget allows (W49 5.2, AR-117). */
function plan(world: RtWorld, vehicle: RtVehicle): boolean {
    const stale = vehicle.routeTick === RT_NONE || vehicle.routeIndex >= vehicle.route.length
    if (!stale || world.pathNodesLeft <= 0) return false
    const target = orderTarget(world, vehicle)
    if (!target) return false
    if (vehicle.lost && vehicle.lostRetryTick !== RT_NONE && world.tick < vehicle.lostRetryTick) return false
    const head = vehicle.tiles[0]!
    const lane = vehicle.pieces[0]!
    const result = findRoadRoute(world.map, head, lane, target, PF.maxSearchNodes, world.pathNodesLeft)
    world.pathNodesLeft = Math.max(0, world.pathNodesLeft - result.nodes)
    if (result.outcome === RtRouteOutcome.deferred) return result.nodes > 0
    if (result.outcome === RtRouteOutcome.found) {
        // the best way starts behind it: turn at once, unless in or at a depot (left by its entrance only)
        if (result.turnAround && vehicle.state === RtVehicleState.driving && world.map.kind[head] !== RtTileKind.depot) turnAround(world, vehicle)
        setRoute(world, vehicle, result.route)
        vehicle.lost = false
        vehicle.lostRetryTick = RT_NONE
    } else {
        setRoute(world, vehicle, [])
        vehicle.lost = true
        vehicle.lostRetryTick = world.tick + PF.lostRetryTicks
    }
    return true
}

/** Off-route lane through a tile entered along `dir`: straight on, else a turn, else back at a road end. */
function fallbackLane(bits: number, dir: number): number {
    for (const exit of [dir, (dir + 1) & 3, (dir + 3) & 3]) {
        if ((bits & bitOf(exit)) !== 0) return exit
    }
    return rtReverseDir(dir as RtDir)
}

/** The route's planned lane through a tile with `bits`, or -1 when the route has none or the road no longer allows it. */
function plannedLane(vehicle: RtVehicle, bits: number): number {
    const planned = vehicle.route[vehicle.routeIndex]
    return planned !== undefined && planned >= 0 && planned < 4 && (bits & bitOf(planned)) !== 0 ? planned : -1
}

/** The lane the vehicle takes through the next tile, entered along `dir`; leaving its route makes the route stale. */
function chooseLane(vehicle: RtVehicle, bits: number, dir: number): { lane: number, fromRoute: boolean } {
    const planned = plannedLane(vehicle, bits)
    if (planned >= 0) return { lane: planned, fromRoute: true }
    if (vehicle.routeIndex < vehicle.route.length) vehicle.routeTick = RT_NONE
    return { lane: fallbackLane(bits, dir), fromRoute: false }
}

/** The tile ahead of the head, when the vehicle can drive into it along its lane. */
function nextTile(world: RtWorld, vehicle: RtVehicle): { next: number, bits: number } {
    const map = world.map
    const head = vehicle.tiles[0]!
    const lane = vehicle.pieces[0]!
    // a depot is left by its entrance only
    const open = map.kind[head] === RtTileKind.depot
        ? rtDepotFacing(map.payload[head]!) === lane
        : (roadBits(map, head) & bitOf(lane)) !== 0
    if (!open) return { next: -1, bits: 0 }
    const next = map.neighbour(head, lane as RtDir)
    if (next < 0) return { next: -1, bits: 0 }
    const bits = roadBits(map, next)
    if ((bits & bitOf(rtReverseDir(lane as RtDir))) === 0) return { next: -1, bits: 0 }
    return { next, bits }
}

/**
 * How far the head may still move before closing to within roadLaneGap of the vehicle ahead in its
 * lane (this tile, or the next one in the lane it will take); Infinity when nothing is ahead.
 */
function room(world: RtWorld, vehicle: RtVehicle): number {
    const head = vehicle.tiles[0]!
    const lane = vehicle.pieces[0]!
    let nearest = Infinity
    for (const id of world.occupied.roadVehiclesInLane(head, lane)) {
        if (id === vehicle.id) continue
        const other = world.vehicle(id)
        if (!other || other.state === RtVehicleState.inDepot) continue
        let distance: number
        if (other.tiles[0] === head) {
            if (other.progress < vehicle.progress || (other.progress === vehicle.progress && other.id > vehicle.id)) continue
            distance = other.progress - vehicle.progress
        } else {
            // its head has moved on; this tile is its tail
            distance = TILE - vehicle.progress + other.progress
        }
        nearest = Math.min(nearest, distance)
    }
    const { next, bits } = nextTile(world, vehicle)
    if (next >= 0) {
        const planned = plannedLane(vehicle, bits)
        const lane2 = planned >= 0 ? planned : fallbackLane(bits, lane)
        for (const id of world.occupied.roadVehiclesInLane(next, lane2)) {
            const other = world.vehicle(id)
            if (!other || id === vehicle.id || other.tiles[0] !== next) continue
            nearest = Math.min(nearest, TILE - vehicle.progress + other.progress)
        }
    }
    return nearest === Infinity ? Infinity : nearest - GAP
}

/** The vehicle drives into its target depot: it leaves the road, is serviced and runs its depot order. */
function enterDepot(world: RtWorld, vehicle: RtVehicle, depot: number): void {
    for (const tile of vehicle.tiles) world.markDirty(tile)
    world.occupied.releaseVehicle(vehicle.id)
    world.occupied.enterDepot(vehicle.id, depot)
    world.markDirty(depot)
    const facing = rtDepotFacing(world.map.payload[depot]!)
    vehicle.state = RtVehicleState.inDepot
    vehicle.tiles = [depot]
    vehicle.pieces = [facing]
    vehicle.direction = facing
    vehicle.progress = 0
    vehicle.speed = 0
    vehicle.subspeed = 0
    vehicle.route = []
    vehicle.routeIndex = 0
    vehicle.routeTick = RT_NONE
    vehicle.blockedTicks = 0
    // sent here by sendToDepot (AR-71): it stops inside until started
    if (vehicle.haltInDepot) vehicle.stopped = true
    vehicle.haltInDepot = false
    rtServiceInDepot(world, vehicle, depot, world.tick)
    const order = rtCurrentOrder(vehicle)
    if (order && order.kind === RtOrderKind.gotoDepot && order.target === depot) advanceOrder(vehicle, world.stations, world.map)
}

/** The vehicle stops at a stop of its target station and hands over to loading (W51). */
function arrive(vehicle: RtVehicle, station: number): void {
    vehicle.state = RtVehicleState.loading
    vehicle.loadingStation = station
    vehicle.speed = 0
    vehicle.subspeed = 0
    vehicle.blockedTicks = 0
}

const enum Enter { entered, held, depot, turned }

/** The head stands at its tile's exit edge: drive on into the next tile, into a depot, or turn round. */
function tryEnter(world: RtWorld, vehicle: RtVehicle): Enter {
    const map = world.map
    const head = vehicle.tiles[0]!
    const lane = vehicle.pieces[0]!
    const next = map.neighbour(head, lane as RtDir)
    if (depotAhead(map, vehicle, next, lane)) {
        enterDepot(world, vehicle, next)
        return Enter.depot
    }
    const ahead = nextTile(world, vehicle)
    if (ahead.next < 0) {
        turnAround(world, vehicle)
        return Enter.turned
    }
    if (rtCrossingBarred(world, ahead.next)) {
        vehicle.speed = 0
        vehicle.subspeed = 0
        return Enter.held
    }
    const { lane: newLane, fromRoute } = chooseLane(vehicle, ahead.bits, lane)
    const fromLane = lane
    vehicle.tiles.unshift(ahead.next)
    vehicle.pieces.unshift(newLane)
    vehicle.direction = newLane
    if (fromRoute) vehicle.routeIndex++
    world.occupied.holdRoad(vehicle.id, ahead.next, newLane)
    world.markDirty(ahead.next)
    // the original slows a road vehicle through a turn
    if (newLane !== fromLane) vehicle.speed -= (vehicle.speed * M.curveLargeLoss) >> 8
    const rise = map.tileHeight(ahead.next) - map.tileHeight(head)
    if (rise > 0) vehicle.speed -= (vehicle.speed * M.slopeUpLoss) >> 8
    vehicle.speed = Math.max(0, vehicle.speed)
    while (vehicle.tiles.length > 2) {
        const tile = vehicle.tiles.pop()!
        world.occupied.releaseRoad(vehicle.id, tile, vehicle.pieces.pop()!)
        world.markDirty(tile)
    }
    if (vehicle.routeIndex > 256) {
        vehicle.route.splice(0, vehicle.routeIndex)
        vehicle.routeIndex = 0
    }
    return Enter.entered
}

/** Whether the vehicle must stand still at the end of its head tile: its stop, or a road end it turns at. */
function stopsAtTileEnd(world: RtWorld, vehicle: RtVehicle): boolean {
    const head = vehicle.tiles[0]!
    if (isStopOf(world.map, head, targetStation(vehicle), stopType(vehicle))) return true
    const { next } = nextTile(world, vehicle)
    return next < 0 && !depotAhead(world.map, vehicle, world.map.neighbour(head, vehicle.pieces[0]! as RtDir), vehicle.pieces[0]!)
}

/** Speed for this tick: road acceleration toward the model's top speed, slowing in the last tile before a stop. */
function updateSpeed(world: RtWorld, vehicle: RtVehicle): void {
    let limit = vehicle.stopped ? 0 : rtConsistMaxSpeed(vehicle.consist)
    if (limit > 0 && stopsAtTileEnd(world, vehicle)) limit = Math.min(limit, Math.max(4, Math.floor((TILE - vehicle.progress) / 24)))
    if (vehicle.speed > limit) {
        vehicle.speed = limit
        vehicle.subspeed = 0
        return
    }
    const sub = vehicle.subspeed + M.roadAccel
    vehicle.speed += sub >> M.speedFracBits
    vehicle.subspeed = sub & ((1 << M.speedFracBits) - 1)
    if (vehicle.speed >= limit) {
        vehicle.speed = limit
        vehicle.subspeed = 0
    }
}

/** A started vehicle drives out of its depot once the lane outside is clear. */
function leaveDepot(world: RtWorld, vehicle: RtVehicle): void {
    const map = world.map
    const depot = vehicle.tiles[0]!
    if (map.kind[depot] !== RtTileKind.depot) return
    const facing = rtDepotFacing(map.payload[depot]!)
    vehicle.pieces = [facing]
    vehicle.direction = facing
    const next = map.neighbour(depot, facing)
    if (next < 0 || (roadBits(map, next) & bitOf(rtReverseDir(facing))) === 0 || rtCrossingBarred(world, next)) return
    vehicle.progress = TILE - BODY
    if (room(world, vehicle) <= 0) {
        vehicle.progress = 0
        return
    }
    world.occupied.leaveDepot(vehicle.id, depot)
    world.occupied.holdRoad(vehicle.id, depot, facing)
    vehicle.state = RtVehicleState.driving
    vehicle.blockedTicks = 0
    world.markDirty(depot)
}

function stateOf(vehicle: RtVehicle): RtVehicleState {
    return vehicle.state
}

/**
 * W49: one tick of one road vehicle. RtWorld.step (W57) calls it for every road vehicle in id order,
 * then removes the vehicle when `remove` is set.
 */
export function stepRoadVehicle(world: RtWorld, vehicle: RtVehicle, hooks?: RtRoadHooks): RtRoadStepResult {
    const result: RtRoadStepResult = { remove: false, searched: false }
    if (vehicle.kind !== RtVehicleKind.road || vehicle.tiles.length === 0 || vehicle.tiles.length !== vehicle.pieces.length) return result
    if (vehicle.state === RtVehicleState.crashed) {
        vehicle.crashTicks = Math.max(0, vehicle.crashTicks - 1)
        result.remove = vehicle.crashTicks === 0
        return result
    }
    // a road vehicle has no parking places: a stopped one stands where it is (the original)
    if (vehicle.state === RtVehicleState.parking || vehicle.state === RtVehicleState.parked) vehicle.state = RtVehicleState.driving
    rtCountRunningTick(vehicle)
    if (rtBreakdownTick(vehicle)) return result

    if (vehicle.state === RtVehicleState.inDepot) {
        if (vehicle.stopped) return result
        result.searched = plan(world, vehicle)
        leaveDepot(world, vehicle)
        return result
    }
    if (vehicle.state === RtVehicleState.loading) {
        if (vehicle.stopped) return result
        const done = hooks?.loadStep ? hooks.loadStep(world, vehicle) : true
        if (done) {
            // loadingStation stays until the vehicle is off the stop (justLeft)
            vehicle.state = RtVehicleState.driving
            advanceOrder(vehicle, world.stations, world.map)
            vehicle.routeTick = RT_NONE
        }
        return result
    }

    if (!vehicle.stopped) result.searched = plan(world, vehicle)
    updateSpeed(world, vehicle)
    let budget = vehicle.speed > 0 ? Math.max(1, Math.floor(vehicle.speed * M.advanceNumerator / M.advanceDenominator)) : 0
    const station = targetStation(vehicle)
    const type = stopType(vehicle)

    // the original's blocked counter: it counts while a vehicle is close ahead and clears once none
    // is; past roadBlockedTicks the vehicle drives through (AR-127)
    const close = room(world, vehicle) <= 0
    if (!vehicle.stopped) vehicle.blockedTicks = close ? vehicle.blockedTicks + 1 : 0
    const through = close && vehicle.blockedTicks > RT_CATALOG.vehicles.roadBlockedTicks
    if (close && !through) {
        vehicle.speed = 0
        vehicle.subspeed = 0
        budget = 0
        // queued at its own stop: load where it stands once past the stop's middle
        if (!vehicle.stopped && isStopOf(world.map, vehicle.tiles[0]!, station, type) && vehicle.progress >= TILE / 2) arrive(vehicle, station)
    }
    for (let guard = 0; guard < 16 && budget > 0; guard++) {
        const space = through ? Infinity : room(world, vehicle)
        if (space <= 0) break
        if (vehicle.progress < TILE) {
            const step = Math.min(budget, TILE - vehicle.progress, space)
            vehicle.progress += step
            budget -= step
            if (vehicle.tiles.length > 1 && vehicle.progress >= BODY) dropTail(world, vehicle)
            if (vehicle.progress < TILE) continue
        }
        if (isStopOf(world.map, vehicle.tiles[0]!, station, type)) {
            arrive(vehicle, station)
            break
        }
        const outcome = tryEnter(world, vehicle)
        if (outcome === Enter.held || outcome === Enter.depot) break
        if (outcome === Enter.entered) vehicle.progress = 0
    }
    if (stateOf(vehicle) === RtVehicleState.loading) {
        hooks?.arrive?.(world, vehicle, vehicle.loadingStation)
    } else if (vehicle.loadingStation !== RT_NONE && !isStopOf(world.map, vehicle.tiles[0]!, vehicle.loadingStation, type)) {
        vehicle.loadingStation = RT_NONE
        vehicle.routeTick = RT_NONE
    }
    return result
}
