// Generated from framework-model-catalog.yaml by
// `pnpm --filter @manyfold/shared catalog:generate`. Do not edit.
import type { FrameworkModelCatalog } from './framework-model-catalog'

export const builtInFrameworkModelCatalog = {
    'claude-code': {
        configDefault: null,
        models: [
            {
                key: 'fable',
                kind: 'alias',
                name: 'Fable',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'opus',
                kind: 'alias',
                name: 'Opus',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'opus[1m]',
                kind: 'alias',
                name: 'Opus (1M context)',
                fast: false,
                longContext: true,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'sonnet',
                kind: 'alias',
                name: 'Sonnet',
                fast: false,
                longContext: false,
                isDefault: true,
                active: true,
                intelligence: null
            },
            {
                key: 'sonnet[1m]',
                kind: 'alias',
                name: 'Sonnet (1M context)',
                fast: false,
                longContext: true,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'haiku',
                kind: 'alias',
                name: 'Haiku',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'best',
                kind: 'alias',
                name: 'Best available',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'opusplan',
                kind: 'alias',
                name: 'Opus Plan',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            }
        ],
        enums: {
            effort: [
                {
                    value: 'low',
                    name: 'Low',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'medium',
                    name: 'Medium',
                    isDefault: true,
                    active: true
                },
                {
                    value: 'high',
                    name: 'High',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'xhigh',
                    name: 'Extra High',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'max',
                    name: 'Max',
                    isDefault: false,
                    active: true
                }
            ]
        },
        localModels: [
            'claude-fable-5-1',
            'claude-fable-5',
            'claude-opus-5-5',
            'claude-opus-5',
            'claude-opus-4-8',
            'claude-opus-4-7',
            'claude-opus-4-7-1m',
            'claude-opus-4-6',
            'claude-sonnet-5-5',
            'claude-sonnet-5',
            'claude-sonnet-4-6',
            'claude-sonnet-4-6-1m',
            'claude-sonnet-4-5',
            'claude-haiku-4-5'
        ]
    },
    codex: {
        configDefault: 'gpt-5.6-sol',
        models: [
            {
                key: 'gpt-6-astra',
                kind: 'model',
                name: 'GPT-6 Astra',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                    'ultra'
                ]
            },
            {
                key: 'gpt-6-sol',
                kind: 'model',
                name: 'GPT-6 Sol',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                    'ultra'
                ]
            },
            {
                key: 'gpt-6-luna',
                kind: 'model',
                name: 'GPT-6 Luna',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: ['low', 'medium', 'high', 'xhigh', 'max']
            },
            {
                key: 'gpt-5.6-sol',
                kind: 'model',
                name: 'GPT-5.6 Sol',
                fast: true,
                longContext: false,
                isDefault: true,
                active: true,
                intelligence: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                    'ultra'
                ]
            },
            {
                key: 'gpt-5.6-terra',
                kind: 'model',
                name: 'GPT-5.6 Terra',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                    'ultra'
                ]
            },
            {
                key: 'gpt-5.6-luna',
                kind: 'model',
                name: 'GPT-5.6 Luna',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: ['low', 'medium', 'high', 'xhigh', 'max']
            },
            {
                key: 'gpt-5.5',
                kind: 'model',
                name: 'GPT-5.5',
                fast: true,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: ['low', 'medium', 'high', 'xhigh']
            },
            {
                key: 'gpt-5.4',
                kind: 'model',
                name: 'GPT-5.4',
                fast: true,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'gpt-5.4-mini',
                kind: 'model',
                name: 'GPT-5.4 Mini',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'gpt-5.3-codex',
                kind: 'model',
                name: 'GPT-5.3 Codex',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'gpt-5.3-codex-spark',
                kind: 'model',
                name: 'GPT-5.3 Codex Spark',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'gpt-5.2',
                kind: 'model',
                name: 'GPT-5.2',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            }
        ],
        enums: {
            speed: [
                {
                    value: 'standard',
                    name: 'Standard',
                    isDefault: true,
                    active: true
                },
                {
                    value: 'fast',
                    name: 'Fast',
                    isDefault: false,
                    active: true
                }
            ],
            intelligence: [
                {
                    value: 'low',
                    name: 'Low',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'medium',
                    name: 'Medium',
                    isDefault: true,
                    active: true
                },
                {
                    value: 'high',
                    name: 'High',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'xhigh',
                    name: 'Extra High',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'max',
                    name: 'Maximum',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'ultra',
                    name: 'Ultra',
                    isDefault: false,
                    active: true
                },
                {
                    value: 'none',
                    name: 'None',
                    isDefault: false,
                    active: false
                }
            ]
        },
        localModels: []
    },
    'gemini-cli': {
        configDefault: null,
        models: [
            {
                key: 'auto',
                kind: 'alias',
                name: 'Auto (recommended)',
                fast: false,
                longContext: false,
                isDefault: true,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-3.5-flash',
                kind: 'model',
                name: 'Gemini 3.5 Flash',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-3.1-pro-preview',
                kind: 'model',
                name: 'Gemini 3.1 Pro (preview)',
                fast: false,
                longContext: true,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-3-flash-preview',
                kind: 'model',
                name: 'Gemini 3 Flash (preview)',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-3.1-flash-lite',
                kind: 'model',
                name: 'Gemini 3.1 Flash Lite',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-2.5-pro',
                kind: 'model',
                name: 'Gemini 2.5 Pro',
                fast: false,
                longContext: false,
                isDefault: true,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-2.5-flash',
                kind: 'model',
                name: 'Gemini 2.5 Flash',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-2.5-flash-lite',
                kind: 'model',
                name: 'Gemini 2.5 Flash Lite',
                fast: false,
                longContext: false,
                isDefault: false,
                active: true,
                intelligence: null
            },
            {
                key: 'gemini-3.1-flash-lite-preview',
                kind: 'model',
                name: 'Gemini 3.1 Flash Lite (preview)',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            },
            {
                key: 'gemini-2.0-flash',
                kind: 'model',
                name: 'Gemini 2.0 Flash',
                fast: false,
                longContext: false,
                isDefault: false,
                active: false,
                intelligence: null
            }
        ],
        enums: {},
        localModels: [
            'gemini-3.5-flash',
            'gemini-3.1-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite'
        ]
    }
} as const satisfies FrameworkModelCatalog
