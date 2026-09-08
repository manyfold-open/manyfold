import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

class MigrationSelect {
    constructor(
        private readonly rows: Array<{ agentId: string; userId: string }>
    ) {}
    from() {
        return this
    }
    innerJoin() {
        return this
    }
    where() {
        return Promise.resolve(this.rows)
    }
}

test('sprite identity migration covers every co-resident agent before purge', async () => {
    const migrated: Array<{ agentId: string; userId: string }> = []
    const rows = [
        { agentId: 'agt_one', userId: 'usr_one' },
        { agentId: 'agt_two', userId: 'usr_two' }
    ]
    const provisioner = {
        db: { select: () => new MigrationSelect(rows) },
        runtimeToken: {
            ensureRuntimeIdentity: async (args: {
                agentId: string
                userId: string
                runtimeKind: string
            }): Promise<void> => {
                migrated.push({ agentId: args.agentId, userId: args.userId })
            }
        }
    }

    assert.equal(
        await SpritesProvisioner.prototype.migrateLegacySpriteIdentities.call(
            provisioner as never,
            'host_one'
        ),
        true
    )
    assert.deepEqual(migrated, rows)
})
