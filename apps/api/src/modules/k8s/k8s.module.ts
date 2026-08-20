import { Global, Module } from '@nestjs/common'
import { CapabilitiesRegistry } from '@/common/capabilities/capabilities.registry'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { GatewayExecClient } from '@/modules/k8s/gateway-exec.client'

@Global()
@Module({
    providers: [KubernetesService, GatewayExecClient, PodExecFactory],
    exports: [KubernetesService, GatewayExecClient, PodExecFactory]
})
export class K8sModule {
    constructor(registry: CapabilitiesRegistry, gateway: GatewayExecClient) {
        registry.register('k8sGateway', () => gateway.isConfigured())
    }
}
