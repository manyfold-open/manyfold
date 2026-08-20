import assert from 'node:assert/strict'
import test from 'node:test'
import {
    WORKSPACE_ABSOLUTE_PATH_ERROR,
    buildAddRuntimeAgentBody,
    buildCreateAgentBody,
    progressStepsForCreate,
    workspaceValidationMessage
} from '../src/lib/agentCreateDraft'
import type { ProviderPickerValue } from '../src/pages/AgentNew/components/ProviderPicker'

const inlinePicker = (
    patch: Partial<ProviderPickerValue> = {}
): ProviderPickerValue => ({
    mode: 'inline',
    providerId: '',
    apiKey: 'sk-test-123456',
    baseUrl: '',
    save: false,
    saveLabel: '',
    ...patch
})

test('builds sandbox coding agent body without forcing blank provider base URL', () => {
    const body = buildCreateAgentBody({
        framework: 'claude-code',
        name: 'agent-one',
        picker: inlinePicker({ save: true, saveLabel: 'Claude test key' }),
        runtimeMode: 'sandbox'
    })

    assert.equal(body.name, 'agent-one')
    assert.equal(body.framework, 'claude-code')
    assert.equal(body.runtime, 'sprites')
    assert.deepEqual(body.claudeCodeCredentials, {
        anthropicAuthToken: 'sk-test-123456'
    })
    assert.deepEqual(body.saveCredentialAs, {
        providerName: 'Claude test key'
    })
})

test('includes trimmed workspace directory when provided', () => {
    const body = buildCreateAgentBody({
        framework: 'codex',
        name: 'agent-one',
        picker: inlinePicker(),
        runtimeMode: 'sandbox',
        workspace: ' /home/sprite/project '
    })

    assert.equal(body.workspace, '/home/sprite/project')
})

test('includes framework model config when provided', () => {
    const body = buildCreateAgentBody({
        framework: 'codex',
        name: 'agent-one',
        picker: inlinePicker(),
        runtimeMode: 'sandbox',
        modelConfig: {
            framework: 'codex',
            model: 'gpt-5.5',
            speed: 'fast',
            intelligence: 'high'
        }
    })

    assert.deepEqual(body.modelConfig, {
        framework: 'codex',
        model: 'gpt-5.5',
        speed: 'fast',
        intelligence: 'high'
    })
})

test('omits blank workspace directory', () => {
    const body = buildCreateAgentBody({
        framework: 'codex',
        name: 'agent-one',
        picker: inlinePicker(),
        runtimeMode: 'sandbox',
        workspace: '   '
    })

    assert.equal('workspace' in body, false)
})

test('rejects relative workspace directory client-side', () => {
    assert.equal(
        workspaceValidationMessage('repo/project'),
        WORKSPACE_ABSOLUTE_PATH_ERROR
    )
    assert.equal(workspaceValidationMessage('/repo/project'), null)
    assert.equal(workspaceValidationMessage('   '), null)
})

test('builds existing runtime add body with trimmed custom workspace', () => {
    const body = buildAddRuntimeAgentBody({
        name: '  agent-one  ',
        workspace: ' /repo/project ',
        cloneFrom: ' default '
    })

    assert.deepEqual(body, {
        name: 'agent-one',
        workspace: '/repo/project',
        cloneFrom: 'default'
    })
})

test('omits blank workspace from existing runtime add body', () => {
    const body = buildAddRuntimeAgentBody({
        name: 'agent-one',
        workspace: '   '
    })

    assert.deepEqual(body, {
        name: 'agent-one'
    })
})

test('builds persistent OpenClaw body from a saved provider', () => {
    const body = buildCreateAgentBody({
        framework: 'openclaw',
        name: 'runtime-agent',
        picker: {
            mode: 'saved',
            providerId: 'provider-1',
            apiKey: '',
            baseUrl: '',
            save: false,
            saveLabel: ''
        },
        runtimeMode: 'persistent',
        primaryModelName: ' anthropic/claude-sonnet-4.5 '
    })

    assert.equal(body.runtime, 'k8s')
    assert.deepEqual(body.openclawCredentials, {
        providerId: 'provider-1',
        primaryModelName: 'anthropic/claude-sonnet-4.5'
    })
})

test('maps Hermes inline provider fields and trims explicit base URL', () => {
    const body = buildCreateAgentBody({
        framework: 'hermes',
        name: 'hermes-agent',
        picker: inlinePicker({
            baseUrl: ' https://proxy.example.test/v1 '
        }),
        runtimeMode: 'persistent',
        persistentModelProvider: 'openai',
        primaryModelName: 'gpt-5.4'
    })

    assert.deepEqual(body.hermesCredentials, {
        primaryModelProvider: 'openai',
        primaryModelApiKey: 'sk-test-123456',
        primaryModelName: 'gpt-5.4',
        primaryModelBaseUrl: 'https://proxy.example.test/v1'
    })
})

test('selects progress steps from runtime target and framework family', () => {
    assert.deepEqual(progressStepsForCreate('codex', 'sandbox').slice(0, 4), [
        'validating',
        'selecting_account',
        'checking_quota',
        'creating_sprite'
    ])
    assert.equal(
        progressStepsForCreate('codex', 'persistent').includes('bootstrapping'),
        true
    )
    assert.equal(
        progressStepsForCreate('openclaw', 'persistent').includes(
            'waiting_for_ready'
        ),
        true
    )
})
