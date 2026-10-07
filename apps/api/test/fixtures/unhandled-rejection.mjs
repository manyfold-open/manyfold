// Loads server-bootstrap the way main.ts does (otel, sentry, the chat graph,
// then bootstrap) so its process handlers are the real ones, then leaves one
// rejection unhandled. argv[2]: 'db' = a postgres.js connection failure,
// anything else = an ordinary error.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('tsconfig-paths/register')
require('../../src/otel.ts')
require('../../src/sentry.ts')
require('reflect-metadata')
require('../../src/modules/chat/chat.service.ts')
require('../../src/server-bootstrap.ts')

const reason =
    process.argv[2] === 'db'
        ? Object.assign(
              new Error('write CONNECTION_CLOSED pgbouncer.fixture.internal:5432'),
              { code: 'CONNECTION_CLOSED', errno: 'CONNECTION_CLOSED' }
          )
        : new Error('ordinary fixture failure')
Promise.reject(reason)
setTimeout(() => {
    console.log('FIXTURE_SURVIVED')
    process.exit(0)
}, 500)
