import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { NotFoundException } from '@nestjs/common'
import {
    createDb,
    librarySkills,
    librarySkillShares,
    users,
    type Database
} from '@manyfold/db'
import { LibrarySkillSharesService } from '../src/modules/skills/library-skill-shares.service'
import { LibrarySkillsService } from '../src/modules/skills/library-skills.service'

// Real-Postgres proof of skill sharing: create is idempotent under the
// partial unique index, revoke+create rotates the URL id, resolve is
// uniformly null for revoked/unknown/cascade-deleted shares, the public
// preview leaks no owner-internal fields, and import-by-share clones into
// the recipient's library through the existing conflict pipeline. Env-gated:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test test/library-skill-shares.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    suffix: string
    ownerId: string
    recipientId: string
    shares: LibrarySkillSharesService
    library: LibrarySkillsService
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const ownerId = `user_pgshare_a_${suffix}`
    const recipientId = `user_pgshare_b_${suffix}`
    await db.insert(users).values([
        {
            id: ownerId,
            email: `a-${suffix}@pgtest.local`,
            displayName: `Owner ${suffix}`
        },
        { id: recipientId, email: `b-${suffix}@pgtest.local` }
    ])
    const config = { get: () => undefined } as never
    const shares = new LibrarySkillSharesService(db, config)
    const library = new LibrarySkillsService(
        db,
        {} as never,
        {} as never,
        shares
    )
    return {
        db,
        suffix,
        ownerId,
        recipientId,
        shares,
        library,
        close: async (): Promise<void> => {
            await db
                .delete(users)
                .where(inArray(users.id, [ownerId, recipientId]))
        }
    }
}

const createSkill = async (h: Harness, name: string): Promise<string> => {
    const skill = await h.library.create(h.ownerId, {
        name,
        description: 'pg share test skill',
        content: `# ${name}\n\nshared content body\n`
    })
    await h.library.upsertFile(h.ownerId, skill.id, {
        path: 'references/guide.md',
        content: 'guide body'
    })
    return skill.id
}

test('createShare is idempotent and revoke+create rotates the id', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const skillId = await createSkill(h, `pgshare-${h.suffix}`)
        const first = await h.shares.createShare(h.ownerId, skillId)
        const second = await h.shares.createShare(h.ownerId, skillId)
        assert.equal(second.id, first.id)
        assert.match(first.id, /^lss_[a-z2-7]{26}$/)
        assert.equal(
            first.url,
            `https://manyfold.ai/skills/shared/${first.id}`
        )

        const before = await h.shares.getShare(h.ownerId, skillId)
        assert.equal(before.share?.id, first.id)

        await h.shares.revokeShare(h.ownerId, skillId)
        const after = await h.shares.getShare(h.ownerId, skillId)
        assert.equal(after.share, null)

        const rotated = await h.shares.createShare(h.ownerId, skillId)
        assert.notEqual(rotated.id, first.id)

        const rows = await h.db
            .select()
            .from(librarySkillShares)
            .where(eq(librarySkillShares.librarySkillId, skillId))
        assert.equal(rows.length, 2)
    } finally {
        await h.close()
    }
})

test('share ownership and resolve are strict: foreign owner 404s, revoked/unknown resolve null', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const skillId = await createSkill(h, `pgshare-${h.suffix}`)
        await assert.rejects(
            h.shares.createShare(h.recipientId, skillId),
            NotFoundException
        )

        const share = await h.shares.createShare(h.ownerId, skillId)
        assert.ok(await h.shares.resolveActiveShare(share.id))
        assert.equal(await h.shares.resolveActiveShare('lss_garbage'), null)
        assert.equal(
            await h.shares.resolveActiveShare(share.id.replace('lss_', 'skl_')),
            null
        )

        await h.shares.revokeShare(h.ownerId, skillId)
        assert.equal(await h.shares.resolveActiveShare(share.id), null)
        await assert.rejects(
            h.shares.buildPublicPreview(share.id),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})

test('public preview exposes only the shared surface', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const name = `pgshare-${h.suffix}`
        const skillId = await createSkill(h, name)
        const share = await h.shares.createShare(h.ownerId, skillId)

        const preview = await h.shares.buildPublicPreview(share.id)
        assert.equal(preview.sharedBy, `Owner ${h.suffix}`)
        assert.equal(preview.skill.name, name)
        assert.equal(preview.skill.description, 'pg share test skill')
        assert.match(preview.skill.content, /shared content body/)
        assert.deepEqual(preview.skill.files, [
            { path: 'references/guide.md' }
        ])
        assert.ok(preview.skill.updatedAt)

        assert.deepEqual(Object.keys(preview).sort(), ['sharedBy', 'skill'])
        assert.deepEqual(
            Object.keys(preview.skill).sort(),
            ['content', 'description', 'files', 'name', 'updatedAt']
        )
        const serialized = JSON.stringify(preview)
        assert.ok(!serialized.includes(skillId))
        assert.ok(!serialized.includes('contentHash'))
        assert.ok(!serialized.includes('@pgtest.local'))
    } finally {
        await h.close()
    }
})

test('sharedBy falls back to null, never the email', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await h.db
            .update(users)
            .set({ displayName: null })
            .where(eq(users.id, h.ownerId))
        const skillId = await createSkill(h, `pgshare-${h.suffix}`)
        const share = await h.shares.createShare(h.ownerId, skillId)
        const preview = await h.shares.buildPublicPreview(share.id)
        assert.equal(preview.sharedBy, null)
    } finally {
        await h.close()
    }
})

test('import by share clones into the recipient library and counts imports', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const name = `pgshare-${h.suffix}`
        const skillId = await createSkill(h, name)
        const share = await h.shares.createShare(h.ownerId, skillId)

        const imported = await h.library.importFromSource(h.recipientId, {
            shareId: share.id
        })
        assert.equal(imported.status, 'created')
        assert.equal(imported.skill.name, name)
        assert.notEqual(imported.skill.id, skillId)
        assert.deepEqual(imported.skill.origin, {
            type: 'share',
            shareId: share.id
        })
        assert.equal(imported.skill.files.length, 1)
        assert.equal(imported.skill.files[0].path, 'references/guide.md')

        const [row] = await h.db
            .select()
            .from(librarySkills)
            .where(eq(librarySkills.id, imported.skill.id))
        assert.equal(row.userId, h.recipientId)

        const refreshed = await h.shares.getShare(h.ownerId, skillId)
        assert.equal(refreshed.share?.importCount, 1)

        const again = await h.library.importFromSource(h.recipientId, {
            shareId: share.id,
            onConflict: 'overwrite'
        })
        assert.equal(again.status, 'updated')
        const counted = await h.shares.getShare(h.ownerId, skillId)
        assert.equal(counted.share?.importCount, 2)
    } finally {
        await h.close()
    }
})

test('self-import conflicts like any same-name import and rename resolves it', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const name = `pgshare-${h.suffix}`
        const skillId = await createSkill(h, name)
        const share = await h.shares.createShare(h.ownerId, skillId)

        await assert.rejects(
            h.library.importFromSource(h.ownerId, { shareId: share.id }),
            (err: { getResponse?: () => { code?: string } }) => {
                const body = err.getResponse?.() as { code?: string }
                return body?.code === 'skill_name_conflict'
            }
        )

        const renamed = await h.library.importFromSource(h.ownerId, {
            shareId: share.id,
            onConflict: 'rename'
        })
        assert.equal(renamed.skill.name, `${name}-2`)
    } finally {
        await h.close()
    }
})

test('deleting the skill cascades the share away; revoked share import 404s', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const skillId = await createSkill(h, `pgshare-${h.suffix}`)
        const share = await h.shares.createShare(h.ownerId, skillId)

        await h.db.delete(librarySkills).where(eq(librarySkills.id, skillId))
        assert.equal(await h.shares.resolveActiveShare(share.id), null)
        const orphans = await h.db
            .select()
            .from(librarySkillShares)
            .where(eq(librarySkillShares.id, share.id))
        assert.equal(orphans.length, 0)

        const secondSkill = await createSkill(h, `pgshare2-${h.suffix}`)
        const second = await h.shares.createShare(h.ownerId, secondSkill)
        await h.shares.revokeShare(h.ownerId, secondSkill)
        await assert.rejects(
            h.library.importFromSource(h.recipientId, { shareId: second.id }),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})
