import * as posix from 'node:path/posix'
import { createHash } from 'node:crypto'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Agent, RuntimeHostRow } from '@manyfold/db'
import type { AgentRuntime } from '@manyfold/shared'
import {
    execSprite,
    spriteFsReadFile,
    spriteFsWriteFile,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { drainText, type PodExecStreamHandle } from '@/modules/k8s/pod-exec'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { assertAgentReady } from '@/modules/agents/files/files-context'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import {
    cancelWorkspaceOperationScript,
    shellQuote,
    trackedWorkspaceScript,
    workspaceOperationRoot
} from './workspace-operation-scripts'

// Daemon RPC and pod exec both hold the archive in memory on the way through
// (neither gives backpressure), so both cap it.
const BUFFERED_BACKUP_MAX_BYTES = 100 * 1024 * 1024

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
const RESTORE_WRITE_TIMEOUT_MS = 10 * 60_000
const POD_PROBE_TIMEOUT_MS = 30_000

// The machine a workspace operation runs on (ADR-0037): the agent's host and
// the placement that decides which transport carries the bytes.
interface WorkspaceTarget {
    placement: Exclude<AgentRuntime, 'external'>
    host: RuntimeHostRow
}

@Injectable()
export class WorkspaceRuntimeService {
    private readonly log = new Logger(WorkspaceRuntimeService.name)

    constructor(
        private readonly runtimeContext: RuntimeContextService,
        private readonly hostClients: HostProviderClients,
        private readonly daemonRegistry: DaemonRegistryService
    ) {}

    private async target(agent: Agent): Promise<WorkspaceTarget> {
        const ctx = await this.runtimeContext.forAgent(agent.id)
        if (!ctx?.agent)
            throw new NotFoundException(`agent ${agent.id} not found`)
        if (ctx.placement === 'external' || !ctx.host)
            throw new NotFoundException(
                `external-runtime agent ${agent.id} has no workspace`
            )
        return { placement: ctx.placement, host: ctx.host }
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
        if (
            target.placement !== 'sprites' &&
            archiveBytes > BUFFERED_BACKUP_MAX_BYTES
        ) {
            await this.cleanupPath(agent, archivePath)
            throw new Error(
                `workspace archive too large for ${target.placement} backup (limit ${BUFFERED_BACKUP_MAX_BYTES / (1024 * 1024)} MB, actual ${Math.ceil(archiveBytes / (1024 * 1024))} MB)`
            )
        }
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

    private async readFile(
        agent: Agent,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        const target = await this.target(agent)
        if (target.placement === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(target)
            const result = await spriteFsReadFile(
                client,
                spriteName,
                absPath,
                logger
            )
            if (!result) throw new NotFoundException(`no such file: ${absPath}`)
            return { stream: result.stream }
        }
        if (target.placement === 'daemon')
            return this.readFileFromDaemon(target, absPath)
        return this.readFileFromPod(target, absPath)
    }

    private async writeFile(
        agent: Agent,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        const target = await this.target(agent)
        if (target.placement === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(target)
            await spriteFsWriteFile(
                client,
                spriteName,
                {
                    absPath,
                    body: stream,
                    mode: '0600',
                    timeoutMs: RESTORE_WRITE_TIMEOUT_MS
                },
                logger
            )
            return
        }
        if (target.placement === 'daemon')
            return this.writeFileToDaemon(target, absPath, stream)
        await this.writeFileToPod(target, absPath, stream)
    }

    private async run(
        agent: Agent,
        script: string
    ): Promise<{ stdout: string; stderr: string }> {
        const target = await this.target(agent)
        if (target.placement === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(target)
            const result = await execSprite(
                client,
                spriteName,
                {
                    cmd: ['bash', '-lc', script],
                    stdin: '',
                    timeoutMs: EXEC_TIMEOUT_MS
                },
                logger
            )
            if (result.exitCode !== 0)
                throw new Error(
                    `sprite workspace command exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
                )
            return { stdout: result.stdout, stderr: result.stderr }
        }
        if (target.placement === 'daemon')
            return this.runOnDaemon(target, script)
        const exec = await this.hostClients.podExecForHost(target.host)
        const result = await exec.run({
            cmd: ['bash', '-lc', script],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        if (result.exitCode !== 0)
            throw new Error(
                `k8s workspace command exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
            )
        return { stdout: result.stdout, stderr: result.stderr }
    }

    private async runOnDaemon(
        target: WorkspaceTarget,
        script: string
    ): Promise<{ stdout: string; stderr: string }> {
        const daemonId = target.host.id
        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        const stream = this.daemonRegistry.streamRpc({
            daemonId,
            method: 'exec.start',
            payload: {
                cmd: ['bash', '-lc', script],
                env: {},
                timeoutMs: EXEC_TIMEOUT_MS
            },
            timeoutMs: EXEC_TIMEOUT_MS + 5_000,
            onEvent: (kind, data) => {
                if (kind === 'stdout') stdoutChunks.push(data)
                else if (kind === 'stderr') stderrChunks.push(data)
            }
        })
        const payload = await stream.result
        const exitCode = Number(
            (payload as { exitCode?: number })?.exitCode ?? 0
        )
        if (exitCode !== 0)
            throw new Error(
                `daemon workspace command exited ${exitCode}: ${stderrChunks
                    .join('')
                    .slice(0, 512)}`
            )
        return {
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join('')
        }
    }

    private async readFileFromDaemon(
        target: WorkspaceTarget,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        const daemonId = target.host.id
        const chunks: Buffer[] = []
        let totalBytes = 0
        const stream = this.daemonRegistry.streamRpc({
            daemonId,
            method: 'fs.read',
            payload: { path: absPath, chunked: true },
            timeoutMs: RESTORE_WRITE_TIMEOUT_MS,
            onEvent: (kind, data) => {
                if (kind !== 'fs.chunk') return
                const buf = Buffer.from(data, 'base64')
                totalBytes += buf.length
                if (totalBytes > BUFFERED_BACKUP_MAX_BYTES) {
                    stream.cancel()
                    return
                }
                chunks.push(buf)
            }
        })
        try {
            await stream.result
        } catch (err) {
            if (totalBytes > BUFFERED_BACKUP_MAX_BYTES)
                throw new Error(
                    `workspace archive too large for daemon backup (limit ${BUFFERED_BACKUP_MAX_BYTES / (1024 * 1024)} MB)`
                )
            const msg = (err as Error).message
            if (/ENOENT|no such file/i.test(msg))
                throw new NotFoundException(`no such file: ${absPath}`)
            throw err
        }
        const buf = Buffer.concat(chunks)
        async function* iter(): AsyncIterable<Uint8Array> {
            yield buf
        }
        return { stream: iter() }
    }

    private async writeFileToDaemon(
        target: WorkspaceTarget,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        // Buffer the upload so we can ship a single base64 payload to the daemon.
        // Phase 6+ TODO: extend WS protocol to support server→daemon streaming events,
        // then write incrementally. For v1 minimum, cap at 100MB which covers
        // typical coding-agent workspace archives.
        const chunks: Buffer[] = []
        let totalBytes = 0
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalBytes += buf.length
            if (totalBytes > BUFFERED_BACKUP_MAX_BYTES)
                throw new Error(
                    `daemon restore archive exceeds ${BUFFERED_BACKUP_MAX_BYTES} bytes`
                )
            chunks.push(buf)
        }
        const body = Buffer.concat(chunks)
        // Use a bash script to write so we can decode base64 server-side.
        // fs.write RPC stores `content` as utf8; archives are binary, so we
        // shell-pipe through `base64 -d` instead.
        const encoded = body.toString('base64')
        const script = [
            'set -euo pipefail',
            `mkdir -p "$(dirname ${shellQuote(absPath)})"`,
            `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(absPath)}`,
            `chmod 600 ${shellQuote(absPath)}`
        ].join('\n')
        await this.runOnDaemon(target, script)
    }

    // Over the exec websocket rather than the gateway, whose request body
    // (stdin) is capped far below an archive. stdout arrives as text, so the
    // archive crosses base64-encoded.
    private async readFileFromPod(
        target: WorkspaceTarget,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        const exec = await this.hostClients.podExecForHost(target.host)
        const q = shellQuote(absPath)
        const probe = await exec.run({
            cmd: ['bash', '-c', `[ -f ${q} ]`],
            timeoutMs: POD_PROBE_TIMEOUT_MS
        })
        if (probe.exitCode !== 0)
            throw new NotFoundException(`no such file: ${absPath}`)
        const handle = exec.stream({
            cmd: ['bash', '-c', `base64 -w0 < ${q}`],
            timeoutMs: EXEC_TIMEOUT_MS
        })
        // Observed now, awaited once stdout is drained: see observedResult.
        void handle.result.catch(() => undefined)
        return { stream: decodeBase64Stdout(handle, absPath) }
    }

    private async writeFileToPod(
        target: WorkspaceTarget,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        const exec = await this.hostClients.podExecForHost(target.host)
        const q = shellQuote(absPath)
        const handle = exec.streamInteractive({
            cmd: [
                'bash',
                '-c',
                `set -euo pipefail; mkdir -p "$(dirname ${q})"; umask 077; cat > ${q}`
            ],
            timeoutMs: RESTORE_WRITE_TIMEOUT_MS
        })
        void handle.result.catch(() => undefined)
        const stderr = drainText(handle.stderr)
        void drainText(handle.stdout)
        let totalBytes = 0
        try {
            for await (const chunk of stream) {
                totalBytes += chunk.byteLength
                if (totalBytes > BUFFERED_BACKUP_MAX_BYTES)
                    throw new Error(
                        `k8s restore archive exceeds ${BUFFERED_BACKUP_MAX_BYTES} bytes`
                    )
                handle.stdin.write(Buffer.from(chunk))
            }
        } catch (err) {
            handle.abort()
            await handle.result.catch(() => undefined)
            throw err
        }
        handle.stdin.end()
        const result = await handle.result
        if (result.exitCode !== 0)
            throw new Error(
                `k8s restore write exited ${result.exitCode}: ${(await stderr).slice(0, 512)}`
            )
    }

    private async spriteTarget(target: WorkspaceTarget): Promise<{
        client: SpritesClient
        spriteName: string
        logger: SpritesLogger
    }> {
        const logger = spritesLoggerFor(this.log)
        const { client, spriteName } =
            await this.hostClients.spritesClientForHost(target.host, logger)
        return { client, spriteName, logger }
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

const spritesLoggerFor = (log: Logger): SpritesLogger => ({
    debug: (m, meta) =>
        log.debug?.(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) =>
        log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})

async function* decodeBase64Stdout(
    handle: PodExecStreamHandle,
    absPath: string
): AsyncIterable<Uint8Array> {
    const stderr = drainText(handle.stderr)
    let done = false
    try {
        let pending = ''
        for await (const chunk of handle.stdout) {
            pending += chunk.replace(/\s+/g, '')
            const whole = pending.length - (pending.length % 4)
            if (whole === 0) continue
            yield Buffer.from(pending.slice(0, whole), 'base64')
            pending = pending.slice(whole)
        }
        if (pending) yield Buffer.from(pending, 'base64')
        const result = await handle.result
        done = true
        if (result.exitCode !== 0)
            throw new Error(
                `k8s read of ${absPath} exited ${result.exitCode}: ${(await stderr).slice(0, 512)}`
            )
    } finally {
        if (!done) handle.abort()
    }
}
