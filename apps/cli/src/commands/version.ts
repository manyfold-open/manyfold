import type { Command } from 'commander'
import kleur from 'kleur'
import { collectBuildInfo } from '@/build-info'
import { emit, jsonOption } from '@/output'
import { MF_CLI_VERSION } from '@/version'

// `mf --version` (Commander's -V) stays the machine-readable one-liner: both
// install.sh and performSelfUpdate's post-install check parse it. `mf version`
// prints exactly the same string, and --verbose adds the build metadata that
// makes a bug report actionable.
export const registerVersion = (program: Command): void => {
    jsonOption(
        program
            .command('version')
            .description(
                'Show the installed version, update channel and build metadata'
            )
            .option(
                '--verbose',
                'include channel, commit, build time, target and paths'
            )
    ).action(async (opts: { verbose?: boolean; json?: boolean }) => {
        if (!opts.json && !opts.verbose) {
            console.log(MF_CLI_VERSION)
            return
        }
        const info = await collectBuildInfo()
        emit(opts, info, () => {
            const channelNote =
                info.savedChannel && info.savedChannel !== info.bakedChannel
                    ? kleur.dim(
                          ` (saved preference; binary built ${info.bakedChannel})`
                      )
                    : info.savedChannel
                      ? kleur.dim(' (saved preference)')
                      : kleur.dim(' (this build)')
            console.log(`mf ${kleur.cyan(info.version)}`)
            console.log('')
            console.log(
                `channel:   ${info.effectiveChannel}${channelNote}`
            )
            console.log(
                `commit:    ${info.commit ? kleur.gray(info.commit.slice(0, 7)) : kleur.dim('unknown (source build)')}`
            )
            console.log(
                `built:     ${info.buildTime ? kleur.gray(info.buildTime) : kleur.dim('unknown')}`
            )
            console.log(
                `target:    ${info.target ?? kleur.dim('unsupported platform')}`
            )
            console.log(
                `install:   ${info.installMethod} ${kleur.gray(`(${info.execPath})`)}`
            )
            console.log(
                `profile:   ${info.profile} ${kleur.dim(`(${info.profileSource})`)}`
            )
            console.log(`config:    ${kleur.gray(info.configDir)}`)
        })
    })
}
