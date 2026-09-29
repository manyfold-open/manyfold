import {
    FILES_UPLOAD_MAX_BYTES,
    FileRootCapabilitiesSdk,
    frameworkDefinition
} from '@manyfold/shared'
import { PayloadTooLargeException } from '@nestjs/common'
import type { FileRoot } from '@manyfold/db'

export interface CapabilityInput {
    framework: string
    root: FileRoot
}

export const rootCapabilities = ({
    framework
}: CapabilityInput): FileRootCapabilitiesSdk => {
    // A framework that serves its own files owns their layout: every root is
    // read-only, whether the framework's API or the runtime's transport serves
    // it; binarySafe describes the reads, which are exact
    const files = frameworkDefinition(framework)?.files
    if (files?.servedBy === 'framework')
        return {
            maxUploadBytes: 0,
            maxDownloadBytes: files.maxDownloadBytes,
            streamRead: true,
            streamWrite: false,
            binarySafe: true,
            atomicWrite: false
        }
    // Every machine's files go through its daemon (ADR-0037 R6), which
    // streams both ways; a write lands in a part file that is renamed over
    // the target at commit, so a failed upload leaves the destination alone,
    // and the global ceiling is what bounds it.
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
