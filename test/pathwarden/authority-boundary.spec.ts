import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const componentPath = resolve(root, 'app/components/games/PathwardenGame.client.vue')
const componentSource = readFileSync(componentPath, 'utf8')

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
        expect(componentSource).toContain('engine.setServerAuthoritative()')
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
})
