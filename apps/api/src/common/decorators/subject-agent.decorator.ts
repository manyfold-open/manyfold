import { SetMetadata } from '@nestjs/common'

export const SUBJECT_AGENT_META = 'subject_agent_classification'

export type ResourceKind =
    | 'channel'
    | 'automation'
    | 'userSkill'
    | 'backup'
    | 'backupRestore'
    | 'agentRuntime'

export type SubjectAgentClassification =
    | { type: 'path'; param: string }
    | { type: 'body'; field: string }
    | { type: 'query'; field: string }
    | { type: 'resource'; kind: ResourceKind; param: string }
    | { type: 'list-filtered' }
    | { type: 'deny-bound' }
    | { type: 'allowlisted'; reason: string }

export const SubjectAgentFromPath = (param: string): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'path',
        param
    } satisfies SubjectAgentClassification)

export const SubjectAgentFromBody = (field: string): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'body',
        field
    } satisfies SubjectAgentClassification)

export const SubjectAgentFromQuery = (field: string): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'query',
        field
    } satisfies SubjectAgentClassification)

export const SubjectAgentFromResource = (
    kind: ResourceKind,
    param: string
): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'resource',
        kind,
        param
    } satisfies SubjectAgentClassification)

export const ListFilteredByBoundAgent = (): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'list-filtered'
    } satisfies SubjectAgentClassification)

export const DenyBoundToken = (): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'deny-bound'
    } satisfies SubjectAgentClassification)

export const AllowBoundTokenWithoutSubject = (
    reason: string
): MethodDecorator =>
    SetMetadata(SUBJECT_AGENT_META, {
        type: 'allowlisted',
        reason
    } satisfies SubjectAgentClassification)
