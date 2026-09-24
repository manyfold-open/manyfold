import globals from 'globals'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import { CLOUD_TABLE_DB_EXPORTS } from './scripts/editions-cloud-tables.mjs'

// ADR-0034: framework ids are open, so a Record over every framework id is an
// index signature whose lookups silently return undefined for an id this
// build does not register. Key exhaustive tables by CoreFramework and resolve
// other ids through the registry; Partial maps (settings keyed by framework)
// are fine. Listing the registry at module top level would run before an
// edition registers its frameworks.
const FRAMEWORK_TABLE_SYNTAX = {
    selector:
        "TSTypeReference[typeName.name='Record'][typeArguments.params.0.typeName.name=/^(AgentFramework|VersionedFramework)$/]:not(TSTypeReference[typeName.name='Partial'] > TSTypeParameterInstantiation > TSTypeReference)",
    message:
        'Key exhaustive framework tables by CoreFramework and resolve other ids through the framework registry (ADR-0034); a Record over AgentFramework returns undefined for ids it does not list.'
}
// Source only: a test builds its matrix at top level on purpose, after its
// imports (including any fixture framework) have registered.
const FRAMEWORK_LISTING_SYNTAX = {
    selector:
        'CallExpression[callee.name=/^list(Versioned)?Frameworks$/]:not(:function CallExpression):not(PropertyDefinition CallExpression)',
    message:
        'Do not list the framework registry at module load: an edition registers its frameworks after core modules are evaluated (ADR-0034).'
}

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            '**/build/**',
            '**/.turbo/**',
            '**/.vite/**',
            '**/.astro/**',
            '**/.wrangler/**',
            '.e2e-runs/**',
            '**/.e2e-runs/**',
            '**/drizzle/**',
            '**/*.config.js',
            '**/*.config.cjs',
            'apps/docs/**/*.astro'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            globals: {
                ...globals.es2022,
                ...globals.node
            }
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin
        },
        rules: {
            '@typescript-eslint/ban-ts-comment': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['apps/admin/**/*.{ts,tsx}'],
        plugins: {
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-hooks/exhaustive-deps': 'off',
            'react-refresh/only-export-components': [
                'warn',
                { allowConstantExport: true }
            ]
        }
    },
    {
        files: ['**/*.{ts,tsx}'],
        rules: {
            // 'error', not 'warn': `pnpm lint` has no --max-warnings, so a
            // warning can never redden CI. Measured zero hits for both rules
            // before the flip (the api override below keeps its any exemption).
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'warn',
                { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
            ],
            'no-restricted-syntax': ['error', FRAMEWORK_TABLE_SYNTAX]
        }
    },
    {
        files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                FRAMEWORK_TABLE_SYNTAX,
                FRAMEWORK_LISTING_SYNTAX
            ]
        }
    },
    {
        files: ['apps/api/**/*.ts', 'apps/api-cloud/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/consistent-type-imports': 'off'
        }
    },
    {
        // Editions boundary: core code must reach commercial capability only
        // through the ports in @/common/ports/*. The commercial modules and
        // cloud-ports (the commercial binding of those ports) live in
        // apps/api-cloud/src/modules, outside this rule's scope.
        files: ['apps/api/src/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: [
                                '@/modules/billing/*',
                                '@/modules/challenge/*',
                                '@/modules/waitlist/*',
                                '@/modules/acquisition/*',
                                '@/modules/experiments/*',
                                '@/modules/container-skus/*',
                                '@/modules/container-subscriptions/*',
                                '@/modules/managed-models/*',
                                '@/modules/cloud-ports/*'
                            ],
                            message:
                                'Commercial modules are cloud-only: go through a port in @/common/ports/* (editions boundary).'
                        }
                    ],
                    paths: [
                        {
                            name: '@manyfold/db',
                            // Derived from the shared cloud-table contract
                            // so this deny-list and the migration-ownership
                            // checker can never drift (#886).
                            importNames: CLOUD_TABLE_DB_EXPORTS,
                            message:
                                'Commercial tables are cloud-owned: after the journal split an OSS database does not have them, so core code must never query them (editions boundary; see design §4.1).'
                        }
                    ]
                }
            ]
        }
    },
    {
        // #540: a chunk deleted by a deploy must recover identically at every
        // lazy boundary, so lazyChunk owns the only React.lazy call in the app.
        // A new raw lazy() would silently opt that route back out of recovery.
        files: ['apps/web/src/**/*.{ts,tsx}'],
        ignores: ['apps/web/src/lib/lazyChunk.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'react',
                            importNames: ['lazy'],
                            message:
                                'Use lazyChunk from @/lib/lazyChunk so post-deploy stale chunks recover (#540).'
                        }
                    ]
                }
            ]
        }
    },
    {
        // ADR-0006: file-roots is a pure framework-capability consumer — guard it
        // against re-introducing raw framework-literal comparisons. Most other
        // call sites legitimately retain behavioural framework branches, so this
        // guard is scoped to this file rather than applied repo-wide.
        files: ['apps/api/src/modules/agents/bootstrap/file-roots.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                FRAMEWORK_TABLE_SYNTAX,
                FRAMEWORK_LISTING_SYNTAX,
                {
                    selector:
                        'BinaryExpression[operator=/^(===|!==|==|!=)$/] > Literal[value=/^(claude-code|codex|gemini-cli|pi|openclaw|hermes|dify|langflow)$/]',
                    message:
                        'Framework facts come from frameworkCapability()/supportsRuntime()/isExternal() (ADR-0006), not raw framework-literal comparisons.'
                }
            ]
        }
    },
    prettier
)
