import { Injectable, Logger } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import { HostsService } from '@/modules/hosts/hosts.service'
import { serviceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'
import { AgentRuntimesService } from './agent-runtimes.service'
import { HostServices } from './provisioning/host-services'
import { K8sProvisioner } from './provisioning/k8s-provisioner'

// A runtime's delete (ADR-0037 R8): the row goes and its machine stays. A
// service framework's services and the machine's route to it go with the
// row. Seen on local [2026-09-29]: left behind, an OpenClaw gateway kept
// running and serving the sandbox's public URL with no runtime to manage it.
// Best effort: the row goes either way.
@Injectable()
export class RuntimeRemovalService {
    private readonly log = new Logger(RuntimeRemovalService.name)

    constructor(
        private readonly runtimes: AgentRuntimesService,
        private readonly hosts: HostsService,
        private readonly hostServices: HostServices,
        private readonly k8s: K8sProvisioner
    ) {}

    async remove(runtime: AgentRuntimeRow): Promise<void> {
        const host = runtime.hostId
            ? await this.hosts.findById(runtime.hostId)
            : null
        if (host?.kind === 'hosted' && serviceFrameworkRecipe(runtime.framework)) {
            if (host.providerRef?.kind === 'k8s')
                await this.k8s.removeService(runtime, host)
            else
                await this.hostServices
                    .removeRuntime(runtime, host)
                    .catch((err: Error) =>
                        this.log.warn(
                            `service cleanup failed runtimeId=${runtime.id} framework=${runtime.framework}: ${err.message}`
                        )
                    )
        }
        await this.runtimes.delete(runtime.id)
    }
}
