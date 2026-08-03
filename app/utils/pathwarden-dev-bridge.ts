export interface PathwardenDevAction {
    description?: string
    run: (input?: unknown) => unknown | Promise<unknown>
}

export interface PathwardenDevEngine {
    getDebugState: () => unknown
}

export interface PathwardenDevBridgeSource {
    canvas: () => HTMLCanvasElement | null
    engine: () => PathwardenDevEngine | null
    actions?: Record<string, PathwardenDevAction>
}

interface PathwardenDevDescriptor {
    id: 'pathwarden'
    kind: 'canvas-2d'
    actions: Record<string, string | undefined>
}

interface PathwardenDevInspection extends PathwardenDevDescriptor {
    canvas: {
        width: number
        height: number
        clientWidth: number
        clientHeight: number
        connected: boolean
    } | null
    state: unknown
}

interface PathwardenDevBridge {
    readonly version: 1
    list: () => PathwardenDevDescriptor[]
    inspect: () => PathwardenDevInspection
    run: (action: string, input?: unknown) => Promise<unknown>
    waitFor: (timeoutMs?: number) => Promise<PathwardenDevDescriptor>
}

declare global {
    interface Window {
        __POLYNUX_DEV_BRIDGE__?: PathwardenDevBridge
    }
}

function descriptor(actions: Record<string, PathwardenDevAction>): PathwardenDevDescriptor {
    return {
        id: 'pathwarden',
        kind: 'canvas-2d',
        actions: Object.fromEntries(
            Object.entries(actions).map(([name, action]) => [name, action.description])
        )
    }
}

export function registerPathwardenDevBridge(source: PathwardenDevBridgeSource): () => void {
    if (!import.meta.client || !import.meta.dev) return () => {}

    const actions = source.actions ?? {}
    const bridge: PathwardenDevBridge = {
        version: 1,
        list: () => [descriptor(actions)],
        inspect: () => {
            const canvas = source.canvas()
            return {
                ...descriptor(actions),
                canvas: canvas
                    ? {
                        width: canvas.width,
                        height: canvas.height,
                        clientWidth: canvas.clientWidth,
                        clientHeight: canvas.clientHeight,
                        connected: canvas.isConnected
                    }
                    : null,
                // The engine owns the state shape. The bridge never keeps a
                // second object that has to be updated when gameplay changes.
                state: source.engine()?.getDebugState() ?? null
            }
        },
        run: async (actionName, input) => {
            const action = actions[actionName]
            if (!action) {
                throw new Error(`Unknown Pathwarden dev action "${actionName}". Available: ${Object.keys(actions).join(', ') || 'none'}`)
            }
            return await action.run(input)
        },
        waitFor: async (timeoutMs = 5000) => {
            const startedAt = Date.now()
            while (Date.now() - startedAt < timeoutMs) {
                if (source.canvas()) return descriptor(actions)
                await new Promise(resolve => setTimeout(resolve, 25))
            }
            throw new Error(`Timed out waiting for Pathwarden dev bridge after ${timeoutMs}ms`)
        }
    }

    window.__POLYNUX_DEV_BRIDGE__ = bridge
    return () => {
        if (window.__POLYNUX_DEV_BRIDGE__ === bridge) delete window.__POLYNUX_DEV_BRIDGE__
    }
}
