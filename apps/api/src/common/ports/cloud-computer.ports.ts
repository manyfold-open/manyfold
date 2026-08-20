// The slice of a container SKU the k8s provisioner actually consumes; the
// cloud row type is structurally assignable (§3.5 — core never imports the
// commercial schema).
export interface ProvisionableContainerSku {
    id: string
    framework: string
    region: string
    cpuMillicores: number
    memoryMb: number
    diskGb: number
}

export const CLOUD_COMPUTER_PORT = Symbol('CLOUD_COMPUTER_PORT')

export interface AgentAttachDenial {
    code: string
    message: string
}

// Cloud-computer commerce (container SKUs / subscriptions) is a cloud
// concern; core runtime lifecycle only consults this port. Consumers inject
// it @Optional and treat absence as the open defaults — no attach denial,
// no-op teardown, zero active subscriptions — which is also the self-hosted
// behavior once the OSS root binds explicit defaults.
export interface CloudComputerPort {
    agentAttachDenial(args: {
        runtimeSkuId: string | null
        isAdmin: boolean
    }): AgentAttachDenial | null
    onRuntimeTeardown(runtimeId: string): Promise<void>
    activeContainerSubscriptionCount(userId: string): Promise<number>
}

export const openCloudComputerPort: CloudComputerPort = {
    agentAttachDenial: () => null,
    onRuntimeTeardown: async () => undefined,
    activeContainerSubscriptionCount: async () => 0
}
