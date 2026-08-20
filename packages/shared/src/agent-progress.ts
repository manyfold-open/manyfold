import type { AgentSummary } from './dtos'
import type { AgentFramework, AgentRuntime } from './constants'
import { frameworkCapability } from './framework-capability'

export const agentCreateStep = {
    VALIDATING: 'validating',
    SELECTING_ACCOUNT: 'selecting_account',
    INSERTING_AGENT: 'inserting_agent',
    CREATING_SPRITE: 'creating_sprite',
    APPLYING_NETWORK_POLICY: 'applying_network_policy',
    BOOTSTRAPPING: 'bootstrapping',
    INSTALLING_FRAMEWORK: 'installing_framework',
    STARTING_SERVICE: 'starting_service',
    CHECKING_QUOTA: 'checking_quota',
    PREPARING_NAMESPACE: 'preparing_namespace',
    CREATING_SECRET: 'creating_secret',
    CREATING_STORAGE: 'creating_storage',
    CREATING_DEPLOYMENT: 'creating_deployment',
    CREATING_SERVICE: 'creating_service',
    CREATING_INGRESS: 'creating_ingress',
    WAITING_FOR_READY: 'waiting_for_ready',
    RESTORING_BACKUP: 'restoring_backup',
    STORING_CREDENTIALS: 'storing_credentials',
    FINALIZING: 'finalizing'
} as const

export type AgentCreateStep =
    (typeof agentCreateStep)[keyof typeof agentCreateStep]

export type AgentCreateEvent =
    | {
          type: 'step'
          step: AgentCreateStep
          index: number
          total: number
          startedAt: string
      }
    | { type: 'complete'; agent: AgentSummary }
    | {
          type: 'error'
          step: AgentCreateStep | null
          errorClass: string
          message: string
      }

/**
 * Sprite step list for exec-kind coding frameworks (Claude Code / Codex /
 * Gemini CLI). `installing_framework` covers the npm install that brings the
 * CLI up to the resolved version — claude-code is a large package, so without
 * its own step "bootstrapping" sits ~1–2 min and looks dead.
 */
export const spritesSteps: AgentCreateStep[] = [
    'validating',
    'selecting_account',
    'checking_quota',
    'creating_sprite',
    'applying_network_policy',
    'bootstrapping',
    'installing_framework',
    'inserting_agent',
    'storing_credentials',
    'restoring_backup',
    'finalizing'
]

/**
 * Sprite step list for service-kind frameworks (Hermes / OpenClaw). Adds two
 * intermediate steps so the user can see why "bootstrapping" sits ~3 min:
 *   bootstrapping       → first exec on the sprite, env probe
 *   installing_framework → curl install.sh | bash / npm install -g (~3 min)
 *   starting_service     → PUT service + POST start
 */
export const spritesServiceSteps: AgentCreateStep[] = [
    'validating',
    'selecting_account',
    'checking_quota',
    'creating_sprite',
    'applying_network_policy',
    'bootstrapping',
    'installing_framework',
    'starting_service',
    'inserting_agent',
    'storing_credentials',
    'restoring_backup',
    'finalizing'
]

export const k8sSteps: AgentCreateStep[] = [
    'validating',
    'checking_quota',
    'preparing_namespace',
    'creating_secret',
    'creating_storage',
    'creating_deployment',
    'creating_service',
    'creating_ingress',
    'waiting_for_ready',
    'storing_credentials',
    'restoring_backup',
    'finalizing'
]

export const k8sCliSteps: AgentCreateStep[] = [
    'validating',
    'checking_quota',
    'preparing_namespace',
    'creating_secret',
    'creating_storage',
    'creating_deployment',
    'creating_service',
    'creating_ingress',
    'waiting_for_ready',
    'bootstrapping',
    'storing_credentials',
    'restoring_backup',
    'finalizing'
]

export const externalSteps: AgentCreateStep[] = [
    'validating',
    'inserting_agent',
    'finalizing'
]

// Single selector for create-progress step lists, derived from the framework's
// capability kind + runtime. Consolidated from the former api-only `stepsFor`
// (agents.controller.ts) and the web `progressStepsForCreate`; the `external`
// branch is new (the api copy lacked it and fell through to k8sSteps). Daemon
// runtimes self-register and never hit the streaming create path.
export const stepsFor = (
    framework: AgentFramework,
    runtime: AgentRuntime
): AgentCreateStep[] => {
    if (runtime === 'external') return externalSteps
    const { kind } = frameworkCapability(framework)
    if (runtime === 'k8s') return kind === 'coding' ? k8sCliSteps : k8sSteps
    return kind === 'service' ? spritesServiceSteps : spritesSteps
}
