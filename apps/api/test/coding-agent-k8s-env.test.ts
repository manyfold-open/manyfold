import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeCodeK8sBootstrap } from '../src/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '../src/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '../src/modules/agents/bootstrap/gemini-k8s'
import type {
    K8sBootstrapContext,
    K8sBootstrapPlan
} from '../src/modules/agents/bootstrap/k8s-framework-bootstrap'

const baseCtx: K8sBootstrapContext = {
    agentId: 'agt_env',
    runtimeId: 'run_env',
    userId: 'user_env',
    namespace: 'nca',
    host: 'agent.example.org',
    image: 'img:latest',
    controlUiEnabled: true,
    dashboardEnabled: false
}

const stagingCtx: K8sBootstrapContext = {
    ...baseCtx,
    apiBaseUrl: 'https://api.example.com/api',
    deployEnv: 'staging'
}

const plans = (ctx: K8sBootstrapContext): K8sBootstrapPlan[] => [
    new ClaudeCodeK8sBootstrap({} as never).plan(ctx, {
        anthropicAuthToken: 'anthropic-token',
        anthropicBaseUrl: 'https://anthropic.proxy/v1'
    }),
    new CodexK8sBootstrap({} as never).plan(ctx, {
        openaiApiKey: 'sk-test'
    }),
    new GeminiCliK8sBootstrap({} as never).plan(ctx, {
        googleApiKey: 'gemini-key'
    })
]

test('coding-agent K8s plans inject the agent env contract when configured', () => {
    for (const plan of plans(stagingCtx)) {
        assert.equal(plan.envSecretData.AGENT_ID, 'agt_env')
        assert.equal(plan.envSecretData.MF_AGENT_ID, 'agt_env')
        assert.equal(
            plan.envSecretData.MF_API_URL,
            'https://api.example.com/api'
        )
        assert.equal(plan.envSecretData.MF_DEPLOY_ENV, 'staging')
    }
})

test('coding-agent K8s plans inject MF_API_TOKEN only with an identity token', () => {
    const tokenCtx: K8sBootstrapContext = {
        ...stagingCtx,
        apiToken: 'nca_rt_k8s'
    }
    for (const plan of plans(tokenCtx)) {
        assert.equal(plan.envSecretData.MF_API_TOKEN, 'nca_rt_k8s')
        assert.equal(
            plan.envSecretData.MF_API_URL,
            'https://api.example.com/api'
        )
    }
    // URL present but no identity token → token omitted (the §3.5 gate)
    for (const plan of plans(stagingCtx))
        assert.equal('MF_API_TOKEN' in plan.envSecretData, false)
})

test('coding-agent K8s plans omit env contract keys the API has not configured', () => {
    for (const plan of plans(baseCtx)) {
        assert.equal(plan.envSecretData.MF_AGENT_ID, 'agt_env')
        assert.equal('MF_API_URL' in plan.envSecretData, false)
        assert.equal('MF_API_TOKEN' in plan.envSecretData, false)
        assert.equal('MF_DEPLOY_ENV' in plan.envSecretData, false)
    }
})
