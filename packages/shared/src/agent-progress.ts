import type { AgentSummary } from './dtos'
import type { AgentFramework, RuntimePlacement } from './constants'
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
    STARTING_RUNNER: 'starting_runner',
    FINALIZING: 'finalizing'
} as const

export type AgentCreateStep =
    (typeof agentCreateStep)[keyof typeof agentCreateStep]

// Names the create request an agent-create response belongs to. Sent back on
// a repeat of that request, it asks to follow that create to whatever end it
// came to instead of starting another; an API that does not name one cannot
// attach a repeat at all.
export const AGENT_CREATE_REQUEST_HEADER = 'x-agent-create-request'

export type AgentCreateEvent =
    | {
          type: 'step'
          step: AgentCreateStep
          index: number
          total: number
          startedAt: string
      }
    | {
          type: 'complete'
          agent: AgentSummary
          // This request repeated a create already running, or finished, for
          // the same name and settings; the agent is the one that create made.
          resumed?: boolean
      }
    | {
          type: 'error'
          step: AgentCreateStep | null
          errorClass: string
          message: string
          // The API error envelope's fields, as a non-stream response would
          // carry them. Absent from APIs older than these fields.
          code?: string
          status?: number
          details?: unknown
      }

// Each list is what its create path emits, in order; a path may skip steps
// (an existing sandbox has no `creating_sprite`) but never adds one or goes
// back. Values no path emits (`applying_network_policy`, part of making the
// VM, and the k8s object steps) are on no list.

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
    // The sandbox's runner (its in-VM `mf daemon`) is installed, started and
    // registered once the VM exists; everything after runs through it.
    // Measured on the local cloud stack [2026-09-29]: the VM is up in ~2 s,
    // the runner takes the next ~19 s.
    'starting_runner',
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
    'starting_runner',
    'bootstrapping',
    'installing_framework',
    'starting_service',
    'inserting_agent',
    'storing_credentials',
    'restoring_backup',
    'finalizing'
]

// Any framework on a pod host (ADR-0035): a fresh host comes up with its
// framework in one provisioning step; on a named host the framework is
// installed first unless it already runs there; a named runtime only takes
// the agent.
export const k8sSteps: AgentCreateStep[] = [
    'validating',
    'checking_quota',
    'creating_deployment',
    'installing_framework',
    'inserting_agent'
]

export const externalSteps: AgentCreateStep[] = [
    'validating',
    'inserting_agent'
]

// Single selector for create-progress step lists, derived from the framework's
// capability kind + runtime. Consolidated from the former api-only `stepsFor`
// (agents.controller.ts) and the web `progressStepsForCreate`; the `external`
// branch is new (the api copy lacked it and fell through to k8sSteps). Daemon
// runtimes self-register and never hit the streaming create path.
export const stepsFor = (
    framework: AgentFramework,
    runtime: RuntimePlacement
): AgentCreateStep[] => {
    if (runtime === 'external') return externalSteps
    if (runtime === 'k8s') return k8sSteps
    return frameworkCapability(framework).kind === 'service'
        ? spritesServiceSteps
        : spritesSteps
}
