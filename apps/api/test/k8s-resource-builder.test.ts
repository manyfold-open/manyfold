import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildSidecarIngress,
    resourceName,
    type K8sResourceSpec
} from '../src/modules/agents/orchestration/k8s-resource-builder'
import type { K8sSidecarSpec } from '../src/modules/agents/bootstrap/k8s-framework-bootstrap'

// Carved out of k8s-runtime-sidecar.service.test.ts when the k8s hermes
// dashboard host was removed: these pin the generic builder, which stays
// alive for provision-time sidecars (k8s-container-provisioner /
// k8s-agent-orchestrator iterate plan.sidecars).

const spec: K8sResourceSpec = {
    agentId: 'agent-1',
    userId: 'user-1',
    namespace: 'nca-user-1',
    framework: 'hermes',
    image: 'hermes:latest',
    port: null,
    host: 'agent-1.example.test',
    storageClass: 'standard',
    pvcMountPath: '/home/node/.hermes',
    envSecretName: 'agent-agent-1-env',
    envSecretKeys: []
}

const sidecar = (authUrl: string | null): K8sSidecarSpec => ({
    name: 'probe-sidecar',
    image: 'hermes:latest',
    command: ['probe'],
    args: [],
    envFromMainSecret: true,
    containerPort: 9119,
    servicePortName: 'dashboard',
    servicePort: 8082,
    ingressHost: 'agent-1-probe.example.test',
    ingressPath: '/',
    ingressPathType: 'Prefix',
    authUrlAnnotation: authUrl,
    authSigninAnnotation: null,
    resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '300m', memory: '256Mi' }
    },
    mountPvc: true
})

test('buildSidecarIngress requires an auth URL annotation', () => {
    assert.throws(
        () => buildSidecarIngress(spec, sidecar(null)),
        /no authUrlAnnotation; refusing to build public sidecar ingress/
    )
})

test('buildSidecarIngress writes nginx auth-url when configured', () => {
    const authUrl = 'https://api.manyfold.ai/api/protected-probe'
    const ingress = buildSidecarIngress(spec, sidecar(authUrl))

    assert.equal(
        ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/auth-url'],
        authUrl
    )
})

test('resourceName converts object id underscores to DNS-safe hyphens', () => {
    assert.equal(
        resourceName('agt_abcdefghijklmnopqrstuvwxyz'),
        'agent-agt-abcdefghijklmnopqrstuvwxyz'
    )
})
