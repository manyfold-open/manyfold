import kleur from 'kleur'
import type { AgentCreateStep } from '@manyfold/shared'

// The web's English labels for the same steps (web.agentNew.progress.*).
const STEP_LABELS: Record<AgentCreateStep, string> = {
    validating: 'Validating input',
    selecting_account: 'Preparing capacity',
    inserting_agent: 'Reserving agent',
    creating_sprite: 'Creating workspace',
    applying_network_policy: 'Configuring network',
    bootstrapping: 'Bootstrapping framework',
    installing_framework: 'Installing framework binaries',
    starting_runner: 'Connecting the sandbox',
    starting_service: 'Starting framework service',
    checking_quota: 'Checking quota',
    preparing_namespace: 'Preparing workspace',
    creating_secret: 'Securing credentials',
    creating_storage: 'Creating storage',
    creating_deployment: 'Starting runtime',
    creating_service: 'Connecting runtime',
    creating_ingress: 'Publishing runtime',
    waiting_for_ready: 'Waiting for readiness',
    storing_credentials: 'Storing credentials',
    restoring_backup: 'Restoring backup',
    finalizing: 'Finalizing'
}

const stepLabel = (step: string): string =>
    STEP_LABELS[step as AgentCreateStep] ?? step

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

interface CreateProgress {
    step: (step: string) => void
    // Close the step in progress: the create finished, failed, or is no
    // longer being watched (it goes on on the server).
    end: (outcome: 'done' | 'failed' | 'stopped') => void
}

// One line per step as it ends, with how long it took. A long step on a
// terminal gets a line every `heartbeatMs` so a VM boot does not look hung;
// a log (no TTY) gets only the step lines.
export const createProgress = (opts: {
    write: (line: string) => void
    tty: boolean
    now?: () => number
    heartbeatMs?: number
}): CreateProgress => {
    const now = opts.now ?? Date.now
    let current: { step: string; since: number } | null = null
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const close = (mark: string): void => {
        clearInterval(heartbeat)
        if (!current) return
        opts.write(
            `  ${mark} ${stepLabel(current.step)}  ${kleur.dim(seconds(now() - current.since))}`
        )
        current = null
    }
    return {
        step: (step) => {
            // A resumed create reports the step it is on again.
            if (current?.step === step) return
            close(kleur.green('✓'))
            const started = { step, since: now() }
            current = started
            if (!opts.tty) return
            heartbeat = setInterval(
                () =>
                    opts.write(
                        kleur.dim(
                            `    ${stepLabel(started.step)}… ${seconds(now() - started.since)}`
                        )
                    ),
                opts.heartbeatMs ?? 10_000
            )
            heartbeat.unref?.()
        },
        end: (outcome) =>
            close(
                outcome === 'done'
                    ? kleur.green('✓')
                    : outcome === 'failed'
                      ? kleur.red('✗')
                      : kleur.yellow('…')
            )
    }
}
