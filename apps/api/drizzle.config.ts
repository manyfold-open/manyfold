import { readFileSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

const loadDotenv = (path: string): void => {
    try {
        const raw = readFileSync(path, 'utf8')
        for (const line of raw.split('\n')) {
            const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
            if (!match) continue
            const [, key, value] = match
            if (!process.env[key])
                process.env[key] = value.replace(/^['"]|['"]$/g, '')
        }
    } catch {}
}

loadDotenv('.env')

export default defineConfig({
    schema: '../../packages/db/src/schema/core.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url:
            process.env.DATABASE_URL ??
            'postgresql://postgres:postgres@localhost:5432/nca'
    }
})
