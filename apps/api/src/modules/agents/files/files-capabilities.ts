import {
    DAEMON_FS_WRITE_MAX_BYTES,
    FILES_UPLOAD_MAX_BYTES,
    FileRootCapabilitiesSdk
} from '@manyfold/shared'
import { PayloadTooLargeException } from '@nestjs/common'
import type { Agent, FileRoot } from '@manyfold/db'
import {
    POD_EXEC_READ_MAX_BYTES,
    POD_EXEC_WRITE_MAX_BYTES
} from '@/modules/agents/files/k8s-pod-files-client'

// The gateway refuses larger reads itself (413 with a "preview limit" message).
const NARRANEXUS_READ_MAX_BYTES = 64 * 1024 * 1024

export interface CapabilityInput {
    agent: Agent
    root: FileRoot
    // resolved per host, not per runtime: false only for daemons whose CLI
    // predates DAEMON_FEATURE_FS_WRITE_BINARY
    binaryWriteSafe: boolean
}

export const rootCapabilities = ({
    agent,
    root,
    binaryWriteSafe
}: CapabilityInput): FileRootCapabilitiesSdk => {
    // every NarraNexus root is read-only, whether it is served by the gateway or
    // by direct sprite access; binarySafe describes the reads, which are exact
    if (agent.framework === 'narranexus')
        return {
            maxUploadBytes: 0,
            maxDownloadBytes: NARRANEXUS_READ_MAX_BYTES,
            streamRead: true,
            streamWrite: false,
            binarySafe: true,
            atomicWrite: false
        }
    if (root.transport === 'pod-exec')
        return {
            maxUploadBytes: POD_EXEC_WRITE_MAX_BYTES,
            maxDownloadBytes: POD_EXEC_READ_MAX_BYTES,
            // both directions ship the whole file base64-encoded through one exec
            streamRead: false,
            streamWrite: false,
            binarySafe: true,
            atomicWrite: false
        }
    if (agent.runtime === 'daemon')
        return {
            // one fs.write RPC frame carries the whole base64 body
            maxUploadBytes: DAEMON_FS_WRITE_MAX_BYTES,
            streamRead: true,
            streamWrite: false,
            binarySafe: binaryWriteSafe,
            atomicWrite: false
        }
    // sprites exec and dufs stream both ways and have no cap of their own, so
    // the global ceiling is what bounds them; both write through a temp path and
    // rename, so a failed upload leaves the destination alone
    return {
        maxUploadBytes: FILES_UPLOAD_MAX_BYTES,
        streamRead: true,
        streamWrite: true,
        binarySafe: true,
        atomicWrite: true
    }
}

export const assertUploadWithinLimit = (
    caps: FileRootCapabilitiesSdk,
    bytes: number,
    where: { rootId: string; transport: string }
): void => {
    const max = caps.maxUploadBytes
    if (max === undefined || bytes <= max) return
    throw new PayloadTooLargeException(
        `upload of ${bytes} bytes exceeds the ${max}-byte limit of root "${where.rootId}" (${where.transport})`
    )
}
