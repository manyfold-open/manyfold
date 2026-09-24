import { SPRITE_HOME_BASE, type AgentRuntime } from '../constants'
import { DAEMON_FEATURE_TURN_OPENCLAW } from '../daemon'
import type { FrameworkDefinition } from './definition'

// NarraNexus's BASE_WORKING_PATH defaults to `/data/workspaces` inside the
// container (Dockerfile.manyfold) — K8s mounts a PVC at /data. On sprite the
// container shares the sprite VM's filesystem, so the bootstrap overrides
// BASE_WORKING_PATH to live under sprite $HOME so workspace contents persist
// across suspend/resume.
//
// The per-agent workspace dir follows NarraNexus's own convention:
//   `<BASE_WORKING_PATH>/<agent_id>_<mf_user_id>`
// (see backend/routes/manyfold_files.py and POST /manyfold/agents).
export const NARRANEXUS_K8S_BASE_WORKING_PATH = '/data/workspaces'
export const NARRANEXUS_SPRITE_BASE_WORKING_PATH = `${SPRITE_HOME_BASE}/.narranexus/data/workspaces`

export const narraNexusBaseWorkingPath = (runtime: AgentRuntime): string =>
    runtime === 'sprites'
        ? NARRANEXUS_SPRITE_BASE_WORKING_PATH
        : NARRANEXUS_K8S_BASE_WORKING_PATH

// Registered by each surface's NarraNexus entry point (ADR-0034).
export const narraNexusFrameworkDefinition: FrameworkDefinition = {
    id: 'narranexus',
    displayName: 'NarraNexus',
    kind: 'service',
    runtimes: ['sprites', 'k8s'],
    chat: {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    version: {
        upgradeMode: 'rebuild',
        // Measured on github [2026-08-12]: the same tag names different
        // commits here — `v1.15.0` is 5869502c on NetMindAI-Open and
        // e2083c28 on protagolabs.
        repoCandidates: [
            {
                repo: 'NetMindAI-Open/NarraNexus',
                label: 'NetMindAI-Open',
                note: 'The public NarraNexus release line.'
            },
            {
                repo: 'protagolabs/NarraNexus',
                label: 'protagolabs',
                note: 'Carries additional patch and historical tags that the public line never published.'
            }
        ]
    },
    reservedEnvPrefixes: ['NARRANEXUS_', 'NEXUS_'],
    defaultRuntime: 'sprites',
    credentials: 'runtime-ui',
    runner: {
        requiredFeatures: [DAEMON_FEATURE_TURN_OPENCLAW],
        lazyWorkspace: true,
        homeRoots: { sprites: [`${SPRITE_HOME_BASE}/.narranexus`] }
    },
    // The gateway's own read limit: it answers larger reads 413.
    files: { servedBy: 'framework', maxDownloadBytes: 64 * 1024 * 1024 },
    nativeUi: 'always',
    // Its jobs are mirrored into automations by its sync, never run by the
    // platform's own scheduler.
    schedules: 'mirrored'
}
