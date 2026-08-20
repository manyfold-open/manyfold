import {
    type ExternalProvider,
    type ExternalProviderKind
} from './provider'
import { difyProvider } from './dify/dify-provider'
import { langflowProvider } from './langflow/langflow-provider'
import { a2aProvider } from './a2a/a2a-provider'

export type {
    ConvergeInput,
    ConvergeOutcome,
    EmittedEvent,
    ExternalProvider,
    ExternalProviderKind,
    InvokeFile,
    InvokeInput,
    ProviderConfig,
    ProviderLogger,
    TestConnectionInput,
    TestConnectionResult
} from './provider'
export {
    assertPublicHttpUrl,
    normalizeProviderEndpoint
} from './endpoint-safety'

const providers: Record<ExternalProviderKind, ExternalProvider> = {
    dify: difyProvider,
    langflow: langflowProvider,
    a2a: a2aProvider
}

export const getExternalProvider = (
    kind: ExternalProviderKind
): ExternalProvider => providers[kind]
