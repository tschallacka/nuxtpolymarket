import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const componentPath = resolve(root, 'app/components/games/PathwardenGame.client.vue')
const enginePath = resolve(root, 'app/utils/pathwarden-engine.ts')
const debugClearCachePath = resolve(root, 'server/api/pathwarden/debug-clear-cache.post.ts')
const componentSource = readFileSync(componentPath, 'utf8')
const engineSource = readFileSync(enginePath, 'utf8')
const debugClearCacheSource = readFileSync(debugClearCachePath, 'utf8')

function filesUnder(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(directory, entry.name)
        return entry.isDirectory() ? filesUnder(path) : [path]
    })
}

describe('Pathwarden authority boundaries', () => {
    it('keeps server-only modules out of the renderer and removes client-authored saves', () => {
        expect(componentSource).not.toMatch(/#server\//)
        expect(componentSource).not.toMatch(/server\/pathwarden/)
        expect(existsSync(resolve(root, 'server/api/pathwarden/run.put.ts'))).toBe(false)
        expect(componentSource).not.toContain("method: 'PUT', body: { revision")
        expect(componentSource).not.toContain("'/api/pathwarden/ambient'")
        expect(componentSource).toContain('engine.setServerAuthoritative()')
        expect(debugClearCacheSource).toContain('closePathwardenSessionsForUser')
        const authoritativePlacement = engineSource.indexOf("if (this.serverAuthoritative && this.phase === 'planning')")
        const localPlacementValidation = engineSource.indexOf('const placement = this.placementStatus(cell)')
        expect(authoritativePlacement).toBeGreaterThan(-1)
        expect(authoritativePlacement).toBeLessThan(localPlacementValidation)

        const liveInputMethods = [
            ['startWave()', "if (this.phase !== 'planning' || this.pendingWaveStart) return"],
            ['continueCheckpoint()', "if (this.phase !== 'checkpoint') return"],
            ['sellRelic(instanceId: number)', "if (!this.canSellRelics || this.phase === 'wave' || this.phase === 'checkpoint') return"],
            ['salvageSelectedBuilding()', "if (this.phase !== 'planning' || !tower) return"],
            ['upgradeSelectedBuilding()', "if (this.phase !== 'planning' || !tower || tower.level >= 3) return"]
        ] as const
        for (const [method, localGuard] of liveInputMethods) {
            const methodStart = engineSource.indexOf(method)
            const authorityBranch = engineSource.indexOf('if (this.serverAuthoritative)', methodStart)
            const guard = engineSource.indexOf(localGuard, methodStart)
            expect(methodStart).toBeGreaterThan(-1)
            expect(authorityBranch).toBeGreaterThan(methodStart)
            expect(guard).toBeGreaterThan(authorityBranch)
        }
    })

    it('scopes the development bridge to Pathwarden', () => {
        const appFiles = filesUnder(resolve(root, 'app'))
            .filter(path => /\.(ts|vue)$/.test(path))
            .filter(path => !path.endsWith('pathwarden-dev-bridge.ts'))
        const bridgeUsers = appFiles.filter(path => {
            const source = readFileSync(path, 'utf8')
            return source.includes('pathwarden-dev-bridge') || source.includes('__POLYNUX_DEV_BRIDGE__')
        })
        expect(bridgeUsers).toEqual([componentPath])
        expect(appFiles
            .filter(path => /games\/.*\.vue$/.test(path) && !path.endsWith('PathwardenGame.client.vue'))
            .every(path => !readFileSync(path, 'utf8').includes('pathwarden-dev-bridge'))
        ).toBe(true)
    })

    it('isolates legacy renderer galleries to development-only routes', () => {
        const debugPages = filesUnder(resolve(root, 'app/pages/pathwarden/debug'))
            .filter(path => path.endsWith('.vue'))
        expect(debugPages.length).toBeGreaterThan(0)
        for (const path of debugPages) {
            const source = readFileSync(path, 'utf8')
            expect(source).toContain('import.meta.dev')
            expect(source).toContain("navigateTo('/pathwarden')")
        }

        for (const path of [
            resolve(root, 'app/components/pathwarden/DebugGallery.client.vue'),
            resolve(root, 'app/components/pathwarden/RelicSwapDebug.client.vue')
        ]) {
            expect(readFileSync(path, 'utf8')).toContain('if (!import.meta.dev) return')
        }
    })
})
