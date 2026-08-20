export interface ResourceAgentResolver {
    resolveAgentId(
        resourceId: string,
        userId: string
    ): Promise<string | null>
}
