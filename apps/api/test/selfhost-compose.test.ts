import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const compose = parse(
    readFileSync(
        resolve(__dirname, '../../../docker-compose.selfhost.yml'),
        'utf8'
    )
) as {
    services: Record<
        string,
        { volumes?: string[]; environment: Record<string, string> }
    >
    volumes: Record<string, unknown>
}

test('self-host disk uploads use a persistent named volume at the storage service path', () => {
    assert.equal(
        compose.services.api.environment.CHAT_UPLOAD_ALLOW_DISK,
        'true'
    )
    assert.ok(
        compose.services.api.volumes?.includes(
            'chat_uploads:/tmp/manyfold-chat-uploads'
        )
    )
    assert.ok(Object.hasOwn(compose.volumes, 'chat_uploads'))
    assert.ok(
        compose.services.postgres.volumes?.includes(
            'pgdata:/var/lib/postgresql/data'
        )
    )
})

test('self-host CORS defaults derive from the configured web and admin URLs', () => {
    assert.equal(
        compose.services.api.environment.CORS_ORIGIN,
        '${MF_SELFHOST_CORS_ORIGIN:-${MF_SELFHOST_WEB_URL:-http://localhost:3002},${MF_SELFHOST_ADMIN_URL:-http://localhost:3001}}'
    )
})
