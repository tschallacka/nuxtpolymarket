import type { PathwardenInputCommand, PathwardenWorldSnapshot } from './protocol'

/**
 * Predicts only state transitions that are safe to present before the server
 * tick arrives. Gameplay outcomes, resources, entities, and map state remain
 * authoritative and are never invented here.
 */
export function predictPathwardenSnapshot(
    serverSnapshot: PathwardenWorldSnapshot,
    pendingInputs: Iterable<PathwardenInputCommand>
) {
    const predicted = { ...serverSnapshot }
    for (const command of pendingInputs) {
        if (command.type === 'pause' && predicted.phase === 'wave') predicted.paused = command.value
        if (command.type === 'start-wave' && predicted.phase === 'planning') {
            predicted.phase = 'wave'
            predicted.wave = Math.min(12, predicted.wave + 1)
        }
    }
    return predicted
}
