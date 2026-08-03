export interface PathwardenRuntimeMetrics {
    activeSessions: number
    connections: number
    reconnects: number
    commandsAccepted: number
    commandsRejected: number
    packetsIn: number
    packetsOut: number
    bytesIn: number
    bytesOut: number
    ticks: number
    totalTickMs: number
    maxTickMs: number
}

const metrics: PathwardenRuntimeMetrics = {
    activeSessions: 0,
    connections: 0,
    reconnects: 0,
    commandsAccepted: 0,
    commandsRejected: 0,
    packetsIn: 0,
    packetsOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    ticks: 0,
    totalTickMs: 0,
    maxTickMs: 0
}

export function pathwardenMetricConnection(replaced: boolean) {
    metrics.connections++
    if (replaced) metrics.reconnects++
    if (!replaced) metrics.activeSessions++
}

export function pathwardenMetricDisconnection() {
    metrics.activeSessions = Math.max(0, metrics.activeSessions - 1)
}

export function pathwardenMetricCommand(accepted: boolean) {
    if (accepted) metrics.commandsAccepted++
    else metrics.commandsRejected++
}

export function pathwardenMetricPacket(direction: 'in' | 'out', bytes: number) {
    if (direction === 'in') {
        metrics.packetsIn++
        metrics.bytesIn += bytes
    } else {
        metrics.packetsOut++
        metrics.bytesOut += bytes
    }
}

export function pathwardenMetricTick(durationMs: number) {
    metrics.ticks++
    metrics.totalTickMs += durationMs
    metrics.maxTickMs = Math.max(metrics.maxTickMs, durationMs)
}

export function getPathwardenRuntimeMetrics() {
    return {
        ...metrics,
        averageTickMs: metrics.ticks ? metrics.totalTickMs / metrics.ticks : 0
    }
}
