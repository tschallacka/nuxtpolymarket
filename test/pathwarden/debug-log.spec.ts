import { describe, expect, it } from 'vitest'
import { PathwardenDebugLog } from '#shared/pathwarden/debug-log'

describe('Pathwarden debug log', () => {
    it('retains only the newest 10,000 records', () => {
        const log = new PathwardenDebugLog('client')
        for (let index = 0; index < 10_001; index++) log.record('packet.received', { index })

        const result = log.query({ limit: 2 })
        expect(result.total).toBe(10_000)
        expect(result.entries).toEqual([
            expect.objectContaining({ index: 9_999 }),
            expect.objectContaining({ index: 10_000 })
        ])
    })

    it('filters, projects, and scrolls with cursors', () => {
        const log = new PathwardenDebugLog('server')
        log.record('packet.received', { direction: 'in', packetKind: 'InputCommand', inputSequence: 7, message: 'place tower' })
        const second = log.record('command.rejected', { direction: 'in', inputSequence: 7, reason: 'The mist still covers that ground.' })
        log.record('packet.sent', { direction: 'out', packetKind: 'CommandReject', inputSequence: 7 })

        const result = log.query({
            filter: '.inputSequence == 7 and contains(.event; "command")',
            select: '{id, event, reason}',
            limit: 10
        })
        expect(result.entries).toEqual([
            { id: second.id, event: 'command.rejected', reason: 'The mist still covers that ground.' }
        ])

        const earlier = log.query({ before: second.id, select: '.event', limit: 10 })
        expect(earlier.entries).toEqual(['packet.received'])
    })

    it('rejects arbitrary expressions and supports clear', () => {
        const log = new PathwardenDebugLog('client')
        log.record('socket.open')
        expect(() => log.query({ filter: 'process.exit()' })).toThrow('Unsupported debug query expression')
        log.clear()
        expect(log.query().entries).toEqual([])
    })

    it('saves named raw segments independently from active history', () => {
        const log = new PathwardenDebugLog('client')
        log.record('command.sent', { inputSequence: 3, commandType: 'place-tower' })
        const saved = log.save('placement', { filter: '.inputSequence == 3' })
        log.clear()

        expect(saved).toMatchObject({ name: 'placement', count: 1 })
        expect(log.listSaved()).toHaveLength(1)
        expect(log.query({ saved: 'placement', select: '{event, inputSequence}' }).entries).toEqual([
            { event: 'command.sent', inputSequence: 3 }
        ])
        expect(log.deleteSaved('placement')).toBe(true)
        expect(log.listSaved()).toEqual([])
    })
})
