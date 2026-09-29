import * as posix from 'node:path/posix'
import { createHash } from 'node:crypto'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Agent, HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    DAEMON_FEATURE_FS_ROOTS,
    DAEMON_FEATURE_FS_WRITE_STREAM,
    type AgentRuntime
} from '@manyfold/shared'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { assertAgentReady } from '@/modules/agents/files/files-context'
import {
    HostDaemonAccess,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'
import {
    readFileStream,
    writeFileStream
} from '@/modules/agents/adapters/host-file-stream'
import {
    cancelWorkspaceOperationScript,
    shellQuote,
    trackedWorkspaceScript,
    workspaceOperationRoot
} from './workspace-operation-scripts'

export interface WorkspaceArchive {
    path: string
    archiveBytes: number
    workspaceBytes: number
    fileCount: number
    stream: AsyncIterable<Uint8Array>
}

export interface WorkspaceRestoreResult {
    workspaceBytes: number
    fileCount: number
}

const EXEC_TIMEOUT_MS = 10 * 60_000

// The machine a workspace operation runs on (ADR-0037): the agent's host and
// the placement that decides which transport carries the bytes.
interface WorkspaceTarget {
    placement: Exclude<AgentRuntime, 'external'>
    host: RuntimeHostRow
    daemon: HostDaemonRow | null
}

@Injectable()
export class WorkspaceRuntimeService {
    private readonly log = new Logger(WorkspaceRuntimeService.name)

    constructor(
        private readonly runtimeContext: RuntimeContextService,
        private readonly hostAccess: HostDaemonAccess
    ) {}

    private async target(agent: Agent): Promise<WorkspaceTarget> {
        const ctx = await this.runtimeContext.forAgent(agent.id)
        if (!ctx?.agent)
            throw new NotFoundException(`agent ${agent.id} not found`)
        if (ctx.placement === 'external' || !ctx.host)
            throw new NotFoundException(
                `external-runtime agent ${agent.id} has no workspace`
            )
        return { placement: ctx.placement, host: ctx.host, daemon: ctx.daemon }
    }

    // The lock key of one workspace on one machine, independent of which
    // agent addresses it.
    async operationKey(agent: Agent): Promise<string> {
        return workspaceOperationKey(agent, await this.target(agent))
    }

    // The one admission rule for a backup or restore (ADR-0037): an installed
    // runtime on a ready host. Returns the placement the row snapshots.
    async admit(agent: Agent): Promise<AgentRuntime> {
        const ctx = await this.runtimeContext.forAgent(agent.id)
        if (!ctx?.agent)
            throw new NotFoundException(`agent ${agent.id} not found`)
        assertAgentReady(ctx as RuntimeContext & { agent: Agent })
        return ctx.placement
    }

    async createArchive(
        agent: Agent,
        backupId: string
    ): Promise<WorkspaceArchive> {
        const target = await this.target(agent)
        const workspace = workspaceRoot(agent)
        const archivePath = `${workspace}/.nca-backup-tmp/${backupId}.tar.gz`
        let result: { stdout: string; stderr: string }
        try {
            result = await this.run(
                agent,
                trackedWorkspaceScript(
                    workspaceOperationRoot(
                        workspaceOperationKey(agent, target),
                        backupId
                    ),
                    'archive',
                    createArchiveScript(workspace, archivePath)
                )
            )
        } catch (err) {
            await this.cleanupPath(agent, archivePath)
            throw err
        }
        const metrics = parseMetrics(result.stdout)
        const archiveBytes = numberMetric(metrics, 'archiveBytes')
        const archive = await this.readFile(agent, archivePath)
        return {
            path: archivePath,
            archiveBytes,
            workspaceBytes: numberMetric(metrics, 'workspaceBytes'),
            fileCount: numberMetric(metrics, 'fileCount'),
            stream: archive.stream
        }
    }

    async cleanupPath(agent: Agent, absPath: string): Promise<void> {
        await this.run(agent, cleanupScript(absPath)).catch((err) => {
            this.log.warn(
                `backup temp cleanup failed agent=${agent.id} path=${absPath}: ${(err as Error).message}`
            )
        })
    }

    async writeRestoreArchive(
        agent: Agent,
        restoreId: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<string> {
        const workspace = workspaceRoot(agent)
        const archivePath = `${workspace}/.nca-backup-tmp/restore-${restoreId}.tar.gz`
        try {
            await this.writeFile(agent, archivePath, stream)
        } catch (err) {
            await this.cleanupPath(agent, archivePath)
            throw err
        }
        return archivePath
    }

    async applyRestoreArchive(
        agent: Agent,
        restoreId: string,
        archivePath: string
    ): Promise<WorkspaceRestoreResult> {
        const workspace = workspaceRoot(agent)
        try {
            const result = await this.run(
                agent,
                trackedWorkspaceScript(
                    workspaceOperationRoot(
                        workspaceOperationKey(agent, await this.target(agent)),
                        restoreId
                    ),
                    'restore',
                    restoreArchiveScript(workspace, archivePath, restoreId)
                )
            )
            const metrics = parseMetrics(result.stdout)
            return {
                workspaceBytes: numberMetric(metrics, 'workspaceBytes'),
                fileCount: numberMetric(metrics, 'fileCount')
            }
        } finally {
            await this.cleanupPath(agent, archivePath)
        }
    }

    async operationIsIdle(agent: Agent, operationId: string): Promise<boolean> {
        const result = await this.run(
            agent,
            cancelWorkspaceOperationScript(
                workspaceOperationRoot(
                    workspaceOperationKey(agent, await this.target(agent)),
                    operationId
                )
            )
        )
        return numberMetric(parseMetrics(result.stdout), 'active') === 0
    }

    async recoverOperation(
        agent: Agent,
        operationId: string,
        restore: boolean
    ): Promise<void> {
        if (restore)
            await this.run(
                agent,
                recoverRestoreScript(workspaceRoot(agent), operationId)
            )
        const archiveName = restore ? `restore-${operationId}` : operationId
        await this.cleanupPath(
            agent,
            `${workspaceRoot(agent)}/.nca-backup-tmp/${archiveName}.tar.gz`
        )
    }

    // A workspace operation is its machine's daemon's (ADR-0037 R6), under the
    // machine's hold, a hosted daemon brought up for it. The platform owns a
    // hosted machine's filesystem, so the workspace is vouched for on each
    // call (DAEMON_FEATURE_FS_ROOTS); a self-owned computer's daemon admits the
    // workspaces it registered.
    private async onHost<T>(
        agent: Agent,
        reason: string,
        requiredFeatures: string[],
        work: (session: HostSession, roots: string[] | undefined) => Promise<T>
    ): Promise<T> {
        const target = await this.target(agent)
        const hosted = target.host.kind === 'hosted'
        return this.hostAccess.withHost(
            {
                host: target.host,
                daemon: target.daemon,
                placement: target.placement,
                agentId: agent.id,
                reason,
                requiredFeatures: hosted
                    ? [DAEMON_FEATURE_FS_ROOTS, ...requiredFeatures]
                    : requiredFeatures
            },
            (session) =>
                work(session, hosted ? [workspaceRoot(agent)] : undefined)
        )
    }

    // The archive streams out as it is read, holding the machine until the
    // download ends.
    private async readFile(
        agent: Agent,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        return this.onHost(agent, 'backup-read', [], async (session, roots) => {
            const hold = this.hostAccess.hold(session.host, 'backup-read')
            const { stream } = readFileStream(session, {
                path: absPath,
                roots,
                release: () => void hold.release()
            })
            return { stream }
        })
    }

    // Chunks land in an owner-only part file that becomes the archive at
    // commit, so a cut upload never leaves a partial archive to restore.
    private async writeFile(
        agent: Agent,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        await this.onHost(
            agent,
            'backup-write',
            [DAEMON_FEATURE_FS_WRITE_STREAM],
            (session, roots) =>
                writeFileStream(session, {
                    path: absPath,
                    body: stream,
                    roots,
                    mode: '600'
                })
        )
    }

    private async run(
        agent: Agent,
        script: string
    ): Promise<{ stdout: string; stderr: string }> {
        const result = await this.onHost(agent, 'backup', [], (session) =>
            session.exec({
                cmd: ['bash', '-lc', script],
                timeoutMs: EXEC_TIMEOUT_MS
            })
        )
        if (result.exitCode !== 0)
            throw new Error(
                `workspace command exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
        return { stdout: result.stdout, stderr: result.stderr }
    }
}

const workspaceRoot = (agent: Agent): string =>
    normalizeAbsPath(agent.mountPath || agent.workspacePath || '/workspace')

// One workspace on one machine, whichever agent addresses it and whatever
// the machine's later fate (ADR-0037): the placement and the host id.
export const workspaceOperationKey = (
    agent: Agent,
    target: { placement: AgentRuntime; host: { id: string } | null }
): string =>
    createHash('sha256')
        .update(
            JSON.stringify([
                target.placement,
                target.host?.id ?? null,
                workspaceRoot(agent)
            ])
        )
        .digest('hex')

const normalizeAbsPath = (path: string): string => {
    const normalized = posix.normalize(path)
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

const createArchiveScript = (
    workspace: string,
    archivePath: string
): string => {
    const qWorkspace = shellQuote(workspace)
    const qArchive = shellQuote(archivePath)
    return [
        'set -euo pipefail',
        `workspace=${qWorkspace}`,
        `archive=${qArchive}`,
        'tmp_dir="$(dirname "$archive")"',
        'mkdir -p "$workspace" "$tmp_dir"',
        'rm -f "$archive"',
        'if stat -c "%s" /dev/null >/dev/null 2>&1; then stat_size="-c %s"; else stat_size="-f %z"; fi',
        'file_count=$(find "$workspace" -path "$tmp_dir" -prune -o -type f -print | wc -l | tr -d " ")',
        'workspace_bytes=$(find "$workspace" -path "$tmp_dir" -prune -o -type f -exec stat $stat_size {} + | awk \'{s+=$1} END{print s+0}\')',
        'tar -C "$workspace" --exclude="./.nca-backup-tmp" -czf "$archive" .',
        'archive_bytes=$(stat $stat_size "$archive")',
        'printf "archivePath=%s\\narchiveBytes=%s\\nworkspaceBytes=%s\\nfileCount=%s\\n" "$archive" "$archive_bytes" "$workspace_bytes" "$file_count"'
    ].join('\n')
}

const restoreArchiveScript = (
    workspace: string,
    archivePath: string,
    restoreId: string
): string => {
    const parent = posix.dirname(workspace)
    const tmpBase = `${parent}/.nca-restore-${restoreId}`
    const oldPath = `${parent}/.nca-restore-old-${restoreId}`
    const committed = `${parent}/.nca-restore-committed-${restoreId}`
    return [
        'set -euo pipefail',
        `workspace=${shellQuote(workspace)}`,
        `archive=${shellQuote(archivePath)}`,
        `tmp_base=${shellQuote(tmpBase)}`,
        `old_path=${shellQuote(oldPath)}`,
        `committed=${shellQuote(committed)}`,
        'parent="$(dirname "$workspace")"',
        'rm -rf "$tmp_base" "$old_path"',
        'cleanup_tmp() { rm -rf "$tmp_base"; }',
        'trap cleanup_tmp EXIT',
        'mkdir -p "$tmp_base/extract" "$parent"',
        'tar -xzf "$archive" -C "$tmp_base/extract"',
        'if [ -e "$workspace" ]; then mv "$workspace" "$old_path"; fi',
        'if mv "$tmp_base/extract" "$workspace"; then',
        '  : > "$committed"',
        '  rm -rf "$old_path" "$tmp_base"',
        'else',
        '  status=$?',
        '  rm -rf "$workspace"',
        '  if [ -e "$old_path" ]; then mv "$old_path" "$workspace"; fi',
        '  rm -rf "$tmp_base"',
        '  exit "$status"',
        'fi',
        'tmp_dir="$workspace/.nca-backup-tmp"',
        'if stat -c "%s" /dev/null >/dev/null 2>&1; then stat_size="-c %s"; else stat_size="-f %z"; fi',
        'file_count=$(find "$workspace" -path "$tmp_dir" -prune -o -type f -print | wc -l | tr -d " ")',
        'workspace_bytes=$(find "$workspace" -path "$tmp_dir" -prune -o -type f -exec stat $stat_size {} + | awk \'{s+=$1} END{print s+0}\')',
        'rm -rf "$tmp_dir"',
        'printf "workspaceBytes=%s\\nfileCount=%s\\n" "$workspace_bytes" "$file_count"'
    ].join('\n')
}

const recoverRestoreScript = (workspace: string, restoreId: string): string => {
    const parent = posix.dirname(workspace)
    return [
        'set -euo pipefail',
        `workspace=${shellQuote(workspace)}`,
        `old_path=${shellQuote(`${parent}/.nca-restore-old-${restoreId}`)}`,
        `tmp_base=${shellQuote(`${parent}/.nca-restore-${restoreId}`)}`,
        `committed=${shellQuote(`${parent}/.nca-restore-committed-${restoreId}`)}`,
        'if [ -e "$old_path" ] && [ ! -e "$committed" ]; then',
        '  mkdir -p "$tmp_base"',
        '  if [ -e "$workspace" ]; then mv "$workspace" "$tmp_base/interrupted"; fi',
        '  mv "$old_path" "$workspace"',
        'fi',
        'rm -rf "$tmp_base" "$old_path"',
        'rm -f "$committed"'
    ].join('\n')
}

const cleanupScript = (absPath: string): string => {
    const q = shellQuote(absPath)
    return [
        'set -euo pipefail',
        `target=${q}`,
        'rm -f "$target"',
        'rmdir "$(dirname "$target")" 2>/dev/null || true'
    ].join('\n')
}

const parseMetrics = (stdout: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of stdout.split(/\r?\n/)) {
        const idx = line.indexOf('=')
        if (idx <= 0) continue
        out[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return out
}

const numberMetric = (metrics: Record<string, string>, key: string): number => {
    const value = Number.parseInt(metrics[key] ?? '', 10)
    if (!Number.isFinite(value)) throw new Error(`missing metric ${key}`)
    return value
}
