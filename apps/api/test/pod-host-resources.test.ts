import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPodRunnerEnv } from '@manyfold/shared'
import {
    AGENT_CONTAINER_NAME,
    buildPodHostDeployment,
    buildPodHostPvc,
    buildPodHostSecret,
    podHostResourceName,
    podHostSecretName,
    podHostSelector,
    type PodHostSpec
} from '../src/modules/agent-runtimes/provisioning/pod-host-resources'

// A pod host (ADR-0035) is the machine, not a framework: its objects are keyed
// by the host id alone, the PVC is the whole home, and the Secret carries only
// what its daemon needs to enrol. Provider keys and the agent identity reach a
// turn per exec, so nothing a credential update changes lives in the Secret.

const spec: PodHostSpec = {
    hostId: 'pdh_abc_1',
    userId: 'user_1',
    namespace: 'nca-user-1',
    image: 'ghcr.io/example/manyfold-runtime-host:sha-0123456789ab',
    storageClass: 'standard',
    storageSize: '10Gi',
    resources: {
        requests: { cpu: '500m', memory: '1Gi' },
        limits: { cpu: '2', memory: '4Gi' }
    }
}

test('pod host objects are named and labelled by the host alone', () => {
    assert.equal(podHostResourceName(spec.hostId), 'host-pdh-abc-1')
    assert.equal(podHostSecretName(spec.hostId), 'host-pdh-abc-1-env')
    assert.equal(podHostSelector(spec.hostId), 'nca.netmind.ai/host-id=pdh_abc_1')
    const deployment = buildPodHostDeployment(spec)
    const labels = deployment.spec?.template.metadata?.labels ?? {}
    assert.equal(labels['nca.netmind.ai/host-id'], spec.hostId)
    assert.equal(
        Object.keys(labels).some((key) => /framework|agent-id|runtime/.test(key)),
        false
    )
    assert.deepEqual(deployment.spec?.selector.matchLabels, labels)
})

test('the host runs one container on the generic image with its home on the PVC', () => {
    const deployment = buildPodHostDeployment(spec)
    assert.equal(deployment.spec?.replicas, 1)
    // ReadWriteOnce: a rolling update would start the new pod before the old
    // one let go of the volume.
    assert.equal(deployment.spec?.strategy?.type, 'Recreate')
    const pod = deployment.spec?.template.spec
    // No file-server sidecar: files go through pod exec, so nothing on the
    // host is published over HTTP.
    assert.equal(pod?.containers.length, 1)
    const [container] = pod!.containers
    assert.equal(container.name, AGENT_CONTAINER_NAME)
    assert.equal(container.image, spec.image)
    assert.equal(container.ports, undefined)
    assert.deepEqual(container.envFrom, [
        { secretRef: { name: podHostSecretName(spec.hostId) } }
    ])
    assert.deepEqual(container.volumeMounts, [
        { name: 'home', mountPath: '/home/node' }
    ])
    assert.deepEqual(pod?.volumes, [
        {
            name: 'home',
            persistentVolumeClaim: { claimName: podHostResourceName(spec.hostId) }
        }
    ])
    assert.equal(pod?.securityContext?.runAsNonRoot, true)
    assert.equal(pod?.securityContext?.runAsUser, 1000)
    assert.equal(pod?.securityContext?.fsGroup, 1000)
})

test('the home PVC is ReadWriteOnce on the configured class and size', () => {
    const pvc = buildPodHostPvc(spec)
    assert.equal(pvc.metadata?.name, podHostResourceName(spec.hostId))
    assert.deepEqual(pvc.spec?.accessModes, ['ReadWriteOnce'])
    assert.equal(pvc.spec?.storageClassName, 'standard')
    assert.equal(pvc.spec?.resources?.requests?.storage, '10Gi')
})

test('the host Secret carries only the runner enrolment env', () => {
    const env = buildPodRunnerEnv({
        apiBaseUrl: 'https://api.test/api',
        daemonToken: 'ldt_secret',
        podHostId: spec.hostId,
        homeRoot: '/home/node/.manyfold'
    })
    const secret = buildPodHostSecret(spec, env)
    assert.equal(secret.metadata?.name, podHostSecretName(spec.hostId))
    assert.deepEqual(Object.keys(secret.stringData ?? {}).sort(), [
        'MF_API_URL',
        'MF_CONFIG_DIR',
        'MF_DAEMON_HOST_NAME',
        'MF_DAEMON_TOKEN',
        'MF_PROFILE'
    ])
})
