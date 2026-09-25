// The slice of a container SKU the k8s provisioner actually consumes; the
// cloud row type is structurally assignable (§3.5 — core never imports the
// commercial schema). A SKU is compute only: the pod host it buys runs
// whatever frameworks are installed on it (ADR-0035). id/region are null for
// self-serve provisioning, where no purchased SKU exists and the cluster is
// chosen directly.
export interface ProvisionableContainerSku {
    id: string | null
    region: string | null
    cpuMillicores: number
    memoryMb: number
    diskGb: number
}

export const CLOUD_COMPUTER_PORT = Symbol('CLOUD_COMPUTER_PORT')

export interface AgentAttachDenial {
    code: string
    message: string
}

// Resource envelope for a k8s container created without a purchase.
export interface SelfServeContainerSpec {
    cpuMillicores: number
    memoryMb: number
    diskGb: number
}

// Cloud-computer commerce (container SKUs / subscriptions) is a cloud
// concern; core runtime lifecycle only consults this port. A purchase buys a
// pod host, so the port speaks in pod host ids. Consumers inject it @Optional
// and treat absence as the open defaults — no attach denial, no-op teardown,
// zero active subscriptions, self-serve provisioning allowed — which is also
// the self-hosted behavior once the OSS root binds explicit defaults.
export interface CloudComputerPort {
    // Async because an adapter resolves the purchase from its own storage by
    // pod host id.
    agentAttachDenial(args: {
        podHostId: string
        isAdmin: boolean
    }): Promise<AgentAttachDenial | null>
    onPodHostTeardown(podHostId: string): Promise<void>
    activeContainerSubscriptionCount(userId: string): Promise<number>
    // Envelope for a pod host created without a purchased SKU, or null when
    // pod hosts are strictly a purchased product (cloud). Non-null is what
    // makes BYO k8s usable on a self-hosted install: create provisions a host
    // on the fly, mirroring how sprites creates provision a fresh VM.
    selfServeContainerSpec(): SelfServeContainerSpec | null
}

export const openCloudComputerPort: CloudComputerPort = {
    agentAttachDenial: async () => null,
    onPodHostTeardown: async () => undefined,
    activeContainerSubscriptionCount: async () => 0,
    selfServeContainerSpec: () => ({
        cpuMillicores: 1000,
        memoryMb: 2048,
        diskGb: 10
    })
}
