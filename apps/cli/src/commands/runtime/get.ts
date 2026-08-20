import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'

export const registerRuntimeGet = (cmd: Command, program: Command): void => {
    jsonOption(
        cmd
            .command('get <id>')
            .description('Show detail for an agent runtime')
    ).action(async (id: string, opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string }>()
        const { client } = await buildClient(global)
        const rt = await client.agentRuntimes.get(id)
        emit(opts, rt, () => {
            console.log(
                `${kleur.bold(rt.id)}  ${kleur.cyan(rt.name)}  ${kleur.yellow(rt.framework)}/${rt.kind}  ${rt.status}`
            )
            console.log(kleur.dim(`  agents:   ${rt.agentsCount}`))
            if (rt.spriteName)
                console.log(kleur.dim(`  sprite:   ${rt.spriteName}`))
            if (rt.namespace)
                console.log(kleur.dim(`  ns:       ${rt.namespace}`))
            if (rt.ingressHost)
                console.log(kleur.dim(`  ingress:  ${rt.ingressHost}`))
            console.log(kleur.dim(`  created:  ${rt.createdAt}`))
        })
    })
}
