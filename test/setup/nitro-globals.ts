// Nitro auto-imports these at runtime; vitest doesn't, so server/ modules under
// test would hit a ReferenceError without them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'

Object.assign(globalThis, { createError })

// loadEnvFile never overrides vars already in process.env, so CI's own
// DATABASE_URL wins over anything in .env. Bun does not currently expose
// process.loadEnvFile, so keep a small compatible fallback for tests.
try {
    const envPath = resolve(import.meta.dirname, '../../.env')
    const processWithLoader = process as NodeJS.Process & { loadEnvFile?: (path: string) => void }
    if (processWithLoader.loadEnvFile) processWithLoader.loadEnvFile(envPath)
    else {
        for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
            if (!match || match[1]! in process.env) continue
            const value = match[2]!
            process.env[match[1]!] = value.startsWith('"') && value.endsWith('"')
                ? value.slice(1, -1)
                : value.startsWith("'") && value.endsWith("'")
                    ? value.slice(1, -1)
                    : value
        }
    }
} catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
}
