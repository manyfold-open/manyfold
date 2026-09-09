import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PRESERVED_SECRET_ENV_KEYS,
    buildSidecarIngress,
    mergePreservedSecretEnv,
    readSecretEnv,
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

// The env Secret has three writers. Two (the provisioners) merge in what
// provisioning minted — the agent's runtime identity and the pod runner's
// registration credential; the third (a credential update) rebuilds from the
// bootstrap plan, which cannot regenerate either. These pin the carry-over.
test('a Secret rewrite preserves provision-time keys under the fresh plan', () => {
    const existing = {
        ANTHROPIC_AUTH_TOKEN: 'old-provider-key',
        MF_API_TOKEN: 'mfr_baked',
        MF_AGENT_ID: 'agt_1',
        MF_API_URL: 'https://api.test/api',
        MF_DEPLOY_ENV: 'staging',
        MF_DAEMON_TOKEN: 'ldt_pod',
        MF_DAEMON_HOST_NAME: 'pod-runner:art_1',
        MF_PROFILE: 'podrunner',
        MF_CONFIG_DIR: '/home/node/.manyfold',
        SOME_PLAN_KEY: 'stale'
    }
    const planned = {
        ANTHROPIC_AUTH_TOKEN: 'new-provider-key',
        SOME_PLAN_KEY: 'fresh'
    }
    const merged = mergePreservedSecretEnv(existing, planned)
    // The plan wins where it regenerates a key...
    assert.equal(merged.ANTHROPIC_AUTH_TOKEN, 'new-provider-key')
    assert.equal(merged.SOME_PLAN_KEY, 'fresh')
    // ...and every provision-time key it cannot regenerate survives.
    for (const key of PRESERVED_SECRET_ENV_KEYS)
        assert.equal(
            merged[key],
            existing[key as keyof typeof existing],
            `${key} must be carried over`
        )
    // Nothing else leaks through from the old Secret.
    assert.equal(
        Object.keys(merged).length,
        PRESERVED_SECRET_ENV_KEYS.length + 2
    )
})

test('a Secret rewrite with nothing to preserve is exactly the plan', () => {
    assert.deepEqual(mergePreservedSecretEnv(undefined, { A: '1' }), { A: '1' })
    assert.deepEqual(mergePreservedSecretEnv({ UNRELATED: 'x' }, { A: '1' }), {
        A: '1'
    })
})

test('readSecretEnv decodes k8s data and treats a missing Secret as nothing to preserve', async () => {
    const encoded = Buffer.from('ldt_pod', 'utf8').toString('base64')
    const found = await readSecretEnv(
        {
            readNamespacedSecret: async () => ({
                data: { MF_DAEMON_TOKEN: encoded }
            })
        },
        'ns',
        'agent-x-env'
    )
    assert.deepEqual(found, { MF_DAEMON_TOKEN: 'ldt_pod' })

    const missing = await readSecretEnv(
        {
            readNamespacedSecret: async () => {
                throw Object.assign(new Error('not found'), { code: 404 })
            }
        },
        'ns',
        'agent-x-env'
    )
    assert.equal(missing, undefined)

    // Anything other than 404 is a real failure and must surface: silently
    // treating it as "nothing to preserve" is exactly the wipe being fixed.
    await assert.rejects(
        readSecretEnv(
            {
                readNamespacedSecret: async () => {
                    throw Object.assign(new Error('boom'), { code: 500 })
                }
            },
            'ns',
            'agent-x-env'
        ),
        /boom/
    )
})
