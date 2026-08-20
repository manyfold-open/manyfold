export { createClient } from './client'
export type { SpritesClient } from './client'
export { execSprite } from './exec'
export { execSpriteStream } from './exec-stream'
export type { ExecStreamHandle } from './exec-stream'
export { SpritesError, classifyHttpStatus } from './errors'
export type { SpritesErrorCode, SpritesFailureReason } from './errors'
export { spriteWriteFile, spriteReadFile, spriteStatFile } from './file-io'
export type { SpriteWriteFileArgs, SpriteReadFileResult } from './file-io'
export { spriteFsReadFile, spriteFsWriteFile } from './fs-rest'
export type { SpriteFsReadResult, SpriteFsWriteArgs } from './fs-rest'
export { spriteListDir, spriteMkdir, spriteRm, spriteMv } from './fs-ops'
export type { SpriteRmOptions } from './fs-ops'
export {
    containmentPrelude,
    isContainmentExit,
    CONTAINMENT_EXIT_CODE
} from './containment'
export { redact, redactHeaders } from './redaction'
export {
    buildKeepAliveCleanupScript,
    buildKeepAliveLeaseScript,
    buildKeepAliveScript,
    buildRuntimeReportEnvFile,
    buildRuntimeReportScript,
    buildServiceStartScript,
    shellSingleQuote
} from './tasks'
export type {
    KeepAliveCleanupOptions,
    KeepAliveLeaseScriptOptions,
    KeepAliveTaskOptions,
    RuntimeReportEnvFileOptions,
    RuntimeReportScriptOptions,
    ServiceStartScriptOptions
} from './tasks'
export { parseServiceLogStream } from './services'
export type { ServiceLogEvent } from './services'
export type {
    Sprite,
    ListSpritesResponse,
    NetworkPolicy,
    NetworkPolicyRule,
    ExecOptions,
    ExecStdin,
    ExecResult,
    ExecSessionInfo,
    FsEntry,
    FsEntryType,
    ServiceDef,
    ServiceListResponse,
    ServiceMutationOptions,
    ServiceObject,
    ServiceState,
    ServiceStatus,
    ServiceStopOptions,
    SpritesLogger,
    SpritesClientOptions
} from './types'
