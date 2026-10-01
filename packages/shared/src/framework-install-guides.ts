import type { VersionedFramework } from './framework-versions'

// Per-framework install/upgrade guidance for self-owned (daemon) hosts — we
// never install CLIs on a user's own machine, so we show the command + official
// docs and let the daemon detect it on PATH. Most are npm; hermes and agy ship
// their own install script + `<bin> update`.
export const FRAMEWORK_INSTALL_GUIDES: Partial<
    Record<
        VersionedFramework,
        { bin: string; install: string; upgrade: string; docs: string }
    >
> = {
    'claude-code': {
        bin: 'claude',
        install: 'npm install -g @anthropic-ai/claude-code',
        upgrade: 'npm install -g @anthropic-ai/claude-code@latest',
        docs: 'https://docs.anthropic.com/en/docs/claude-code/setup'
    },
    codex: {
        bin: 'codex',
        install: 'npm install -g @openai/codex',
        upgrade: 'npm install -g @openai/codex@latest',
        docs: 'https://github.com/openai/codex'
    },
    'gemini-cli': {
        bin: 'gemini',
        install: 'npm install -g @google/gemini-cli',
        upgrade: 'npm install -g @google/gemini-cli@latest',
        docs: 'https://github.com/google-gemini/gemini-cli'
    },
    pi: {
        bin: 'pi',
        install: 'npm install -g @earendil-works/pi-coding-agent',
        upgrade: 'npm install -g @earendil-works/pi-coding-agent@latest',
        docs: 'https://pi.dev'
    },
    'antigravity-cli': {
        bin: 'agy',
        install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        upgrade: 'agy update',
        docs: 'https://antigravity.google/docs/cli/install/'
    },
    openclaw: {
        bin: 'openclaw',
        install: 'npm install -g openclaw',
        upgrade: 'npm install -g openclaw@latest',
        docs: 'https://github.com/openclaw/openclaw'
    },
    hermes: {
        bin: 'hermes',
        install:
            'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
        upgrade: 'hermes update',
        docs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation'
    }
}
