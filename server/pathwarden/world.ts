import type { PathwardenGameState } from '#shared/types/pathwarden-save'
import type {
    PathwardenInputCommand,
    PathwardenPhase,
    PathwardenWorldSnapshot
} from '#shared/pathwarden/protocol'

export interface PathwardenWorldSource {
    runId: string
    revision: number
    realm: number
    seed: number
    gameState: PathwardenGameState | null
}

interface QueuedCommand {
    inputSequence: number
    command: PathwardenInputCommand
}

const TICK_MS = 50

function initialPhase(state: PathwardenGameState | null): PathwardenPhase {
    const phase = state?.phase
    return phase && ['planning', 'wave', 'checkpoint', 'path', 'upgrade', 'cashout', 'victory', 'defeat'].includes(phase)
        ? phase as PathwardenPhase
        : 'planning'
}

export class PathwardenWorld {
    private readonly commands: QueuedCommand[] = []
    private readonly state: PathwardenWorldSnapshot
    private timer: ReturnType<typeof setInterval> | null = null
    private lastInputSequence = 0
    private onChange: (snapshot: PathwardenWorldSnapshot) => void = () => {}

    constructor(source: PathwardenWorldSource) {
        this.state = {
            runId: source.runId,
            revision: source.revision,
            realm: source.realm,
            seed: source.seed >>> 0,
            tick: 0,
            phase: initialPhase(source.gameState),
            wave: Math.max(0, source.gameState?.wave ?? 0),
            lives: Math.max(0, source.gameState?.lives ?? 20),
            aether: Math.max(0, source.gameState?.aether ?? 205),
            score: Math.max(0, source.gameState?.score ?? 0),
            paused: source.gameState?.paused === true,
            entityCount: (source.gameState?.towers?.length ?? 0) + (source.gameState?.enemies?.length ?? 0)
        }
    }

    setChangeHandler(handler: (snapshot: PathwardenWorldSnapshot) => void) {
        this.onChange = handler
    }

    start() {
        if (this.timer) return
        this.timer = setInterval(() => this.advance(), TICK_MS)
    }

    stop() {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = null
    }

    enqueue(inputSequence: number, command: PathwardenInputCommand) {
        if (!Number.isSafeInteger(inputSequence) || inputSequence <= this.lastInputSequence || !this.canApply(command)) return false
        this.commands.push({ inputSequence, command })
        return true
    }

    canApply(command: PathwardenInputCommand) {
        if (command.type === 'place-tower') return false
        if (command.type === 'pause') return !['victory', 'defeat', 'cashout'].includes(this.state.phase)
        if (command.type === 'start-wave') return this.state.phase === 'planning' && this.state.wave < 12
        return command.type === 'select-tower'
    }

    getSnapshot() {
        return { ...this.state }
    }

    get lastAppliedInput() {
        return this.lastInputSequence
    }

    private advance() {
        this.state.tick += 1
        const commands = this.commands.splice(0)
        let changed = commands.length > 0
        for (const queued of commands) {
            if (queued.inputSequence <= this.lastInputSequence) continue
            this.lastInputSequence = queued.inputSequence
            changed = this.apply(queued.command) || changed
        }
        if (changed || this.state.tick % 10 === 0) this.onChange(this.getSnapshot())
    }

    private apply(command: PathwardenInputCommand) {
        if (command.type === 'pause') {
            if (this.state.phase === 'victory' || this.state.phase === 'defeat' || this.state.phase === 'cashout') return false
            if (this.state.paused === command.value) return false
            this.state.paused = command.value
            return true
        }
        if (command.type === 'start-wave') {
            if (this.state.phase !== 'planning') return false
            this.state.phase = 'wave'
            this.state.wave = Math.min(12, this.state.wave + 1)
            return true
        }
        return command.type === 'select-tower'
    }
}
