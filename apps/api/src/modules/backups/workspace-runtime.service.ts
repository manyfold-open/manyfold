import * as posix from 'node:path/posix'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Agent, FileRoot } from '@manyfold/db'
import {
    createClient,
    execSprite,
    spriteFsReadFile,
    spriteFsWriteFile,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory, type PodExec } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import {
    k8sDufsPathMappingForRoot,
    k8sReadFile,
    k8sWriteStream,
    type K8sFilesTarget
} from '@/modules/agents/files/k8s-files-client'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { isCustomWorkspace } from '@/modules/agents/workspace/workspace-preflight'

const DAEMON_BACKUP_MAX_BYTES = 100 * 1024 * 1024

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

@Injectable()
export class WorkspaceRuntimeService {
    private readonly log = new Logger(WorkspaceRuntimeService.name)

    constructor(
        private readonly accounts: SpritesAccountsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory,
        private readonly daemonRegistry: DaemonRegistryService
    ) {}

    async createArchive(
        agent: Agent,
        backupId: string
    ): Promise<WorkspaceArchive> {
        const workspace = workspaceRoot(agent)
        const archivePath = `${workspace}/.nca-backup-tmp/${backupId}.tar.gz`
        let result: { stdout: string; stderr: string }
        try {
            result = await this.run(
                agent,
                createArchiveScript(workspace, archivePath)
            )
        } catch (err) {
            await this.cleanupPath(agent, archivePath)
            throw err
        }
        const metrics = parseMetrics(result.stdout)
        const archiveBytes = numberMetric(metrics, 'archiveBytes')
        if (
            agent.runtime === 'daemon' &&
            archiveBytes > DAEMON_BACKUP_MAX_BYTES
        ) {
            await this.cleanupPath(agent, archivePath)
            throw new Error(
                `workspace archive too large for daemon backup (limit ${DAEMON_BACKUP_MAX_BYTES / (1024 * 1024)} MB, actual ${Math.ceil(archiveBytes / (1024 * 1024))} MB)`
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
                restoreArchiveScript(workspace, archivePath, restoreId)
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

    private async readFile(
        agent: Agent,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        if (agent.runtime === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(agent)
            const result = await spriteFsReadFile(
                client,
                spriteName,
                absPath,
                logger
            )
            if (!result) throw new NotFoundException(`no such file: ${absPath}`)
            return { stream: result.stream }
        }
        if (agent.runtime === 'daemon')
            return this.readFileFromDaemon(agent, absPath)
        if (isCustomWorkspace(agent))
            return this.readFileFromK8sExec(agent, absPath)
        const target = await this.k8sTarget(agent)
        const result = await k8sReadFile(target, absPath)
        if (!result) throw new NotFoundException(`no such file: ${absPath}`)
        return { stream: result.stream }
    }

    private async writeFile(
        agent: Agent,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        if (agent.runtime === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(agent)
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
        if (agent.runtime === 'daemon')
            return this.writeFileToDaemon(agent, absPath, stream)
        if (isCustomWorkspace(agent))
            return this.writeFileToK8sExec(agent, absPath, stream)
        await k8sWriteStream(await this.k8sTarget(agent), absPath, stream)
    }

    private async run(
        agent: Agent,
        script: string
    ): Promise<{ stdout: string; stderr: string }> {
        if (agent.runtime === 'sprites') {
            const { client, spriteName, logger } =
                await this.spriteTarget(agent)
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
        if (agent.runtime === 'daemon') return this.runOnDaemon(agent, script)
        const exec = await this.k8sExec(agent)
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

    private requireDaemonId(agent: Agent): string {
        if (!agent.daemonId)
            throw new NotFoundException(
                `daemon agent ${agent.id} missing daemonId`
            )
        return agent.daemonId
    }

    private async runOnDaemon(
        agent: Agent,
        script: string
    ): Promise<{ stdout: string; stderr: string }> {
        const daemonId = this.requireDaemonId(agent)
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
        agent: Agent,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        const daemonId = this.requireDaemonId(agent)
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
                if (totalBytes > DAEMON_BACKUP_MAX_BYTES) {
                    stream.cancel()
                    return
                }
                chunks.push(buf)
            }
        })
        try {
            await stream.result
        } catch (err) {
            if (totalBytes > DAEMON_BACKUP_MAX_BYTES)
                throw new Error(
                    `workspace archive too large for daemon backup (limit ${DAEMON_BACKUP_MAX_BYTES / (1024 * 1024)} MB)`
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
        agent: Agent,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        this.requireDaemonId(agent)
        // Buffer the upload so we can ship a single base64 payload to the daemon.
        // Phase 6+ TODO: extend WS protocol to support server→daemon streaming events,
        // then write incrementally. For v1 minimum, cap at 100MB which covers
        // typical coding-agent workspace archives.
        const chunks: Buffer[] = []
        let totalBytes = 0
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalBytes += buf.length
            if (totalBytes > DAEMON_BACKUP_MAX_BYTES)
                throw new Error(
                    `daemon restore archive exceeds ${DAEMON_BACKUP_MAX_BYTES} bytes`
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
        await this.runOnDaemon(agent, script)
    }

    private async readFileFromK8sExec(
        agent: Agent,
        absPath: string
    ): Promise<{ stream: AsyncIterable<Uint8Array> }> {
        let result: { stdout: string; stderr: string }
        try {
            result = await this.run(
                agent,
                [
                    'set -euo pipefail',
                    `target=${shellQuote(absPath)}`,
                    'if [ ! -f "$target" ]; then exit 2; fi',
                    'base64 -w0 < "$target" 2>/dev/null || base64 < "$target"'
                ].join('\n')
            )
        } catch (err) {
            const msg = (err as Error).message
            if (/exited 2|no such file/i.test(msg))
                throw new NotFoundException(`no such file: ${absPath}`)
            throw err
        }
        const buf = Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64')
        async function* iter(): AsyncIterable<Uint8Array> {
            yield buf
        }
        return { stream: iter() }
    }

    private async writeFileToK8sExec(
        agent: Agent,
        absPath: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<void> {
        const chunks: Buffer[] = []
        let totalBytes = 0
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            totalBytes += buf.length
            if (totalBytes > DAEMON_BACKUP_MAX_BYTES)
                throw new Error(
                    `k8s restore archive exceeds ${DAEMON_BACKUP_MAX_BYTES} bytes`
                )
            chunks.push(buf)
        }
        const encoded = Buffer.concat(chunks).toString('base64')
        const script = [
            'set -euo pipefail',
            `mkdir -p "$(dirname ${shellQuote(absPath)})"`,
            `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(absPath)}`,
            `chmod 600 ${shellQuote(absPath)}`
        ].join('\n')
        await this.run(agent, script)
    }

    private async spriteTarget(agent: Agent): Promise<{
        client: SpritesClient
        spriteName: string
        logger: SpritesLogger
    }> {
        if (!agent.accountId || !agent.spriteName)
            throw new NotFoundException(
                `sprites agent ${agent.id} missing accountId or spriteName`
            )
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new NotFoundException(
                `sprites account ${agent.accountId} not found`
            )
        const logger = spritesLoggerFor(this.log)
        return {
            client: createClient({
                token: this.accounts.decryptToken(account),
                accountSlug: account.slug,
                logger
            }),
            spriteName: agent.spriteName,
            logger
        }
    }

    private async k8sExec(agent: Agent): Promise<PodExec> {
        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        const pod = await resolveAgentPod(
            this.k8s,
            runtime,
            runtime.primaryAgentId
        )
        return this.podExecFactory.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
    }

    private async k8sTarget(agent: Agent): Promise<K8sFilesTarget> {
        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime)
            throw new NotFoundException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        if (!runtime.ingressHost || !runtime.primaryAgentId)
            throw new NotFoundException(
                `runtime ${runtime.id} missing files endpoint metadata`
            )
        return {
            runtimeId: runtime.id,
            primaryAgentId: runtime.primaryAgentId,
            ingressHost: runtime.ingressHost,
            pathMapping: k8sDufsPathMappingForRoot(
                agent,
                workspaceFileRoot(agent)
            )
        }
    }
}

const workspaceRoot = (agent: Agent): string =>
    normalizeAbsPath(agent.mountPath || agent.workspacePath || '/workspace')

const workspaceFileRoot = (agent: Agent): FileRoot => ({
    id: 'workspace',
    label: 'Workspace',
    path: workspaceRoot(agent),
    writable: true
})

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
    return [
        'set -euo pipefail',
        `workspace=${shellQuote(workspace)}`,
        `archive=${shellQuote(archivePath)}`,
        `tmp_base=${shellQuote(tmpBase)}`,
        `old_path=${shellQuote(oldPath)}`,
        'parent="$(dirname "$workspace")"',
        'rm -rf "$tmp_base" "$old_path"',
        'cleanup_tmp() { rm -rf "$tmp_base"; }',
        'trap cleanup_tmp EXIT',
        'mkdir -p "$tmp_base/extract" "$parent"',
        'tar -xzf "$archive" -C "$tmp_base/extract"',
        'if [ -e "$workspace" ]; then mv "$workspace" "$old_path"; fi',
        'if mv "$tmp_base/extract" "$workspace"; then',
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

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const spritesLoggerFor = (log: Logger): SpritesLogger => ({
    debug: (m, meta) =>
        log.debug?.(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) =>
        log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})
