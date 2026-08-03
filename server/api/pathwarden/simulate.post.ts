import { requireUserId } from '#server/utils/auth'
import {
    runPathwardenSimulations,
    type PathwardenSimulationDifficulty,
    type PathwardenSimulationStrategy
} from '#shared/utils/gamelogic/pathwarden-simulator'

const strategies: readonly PathwardenSimulationStrategy[] = [
    'balanced',
    'aether-reserve',
    'life-preserve',
    'damage-rush',
    'control'
]

export default defineEventHandler(async (event) => {
    await requireUserId(event)
    const body = await readBody<{ difficulty?: number, strategy?: string }>(event)
    const difficulty = Math.floor(Number(body.difficulty)) as PathwardenSimulationDifficulty
    const strategy = body.strategy as PathwardenSimulationStrategy
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid Pathwarden simulator difficulty' })
    }
    if (!strategies.includes(strategy)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid Pathwarden simulator doctrine' })
    }

    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
    return runPathwardenSimulations({
        difficulty,
        strategy,
        runs: 1000,
        seed
    })
})
