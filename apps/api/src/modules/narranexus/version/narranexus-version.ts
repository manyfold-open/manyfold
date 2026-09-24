import { githubSource } from '@/modules/framework-versions/framework-version-registry'
import type { FrameworkVersionExtension } from '@/modules/frameworks/framework-extension'
import {
    buildNarraNexusRebuildShell,
    buildNarraNexusRestoreShell
} from '../bootstrap/narranexus-sprite'

// A function, not a constant: githubSource reads the framework's repo
// candidates from the registry, which must hold the definition first.
export const narraNexusVersion = (): FrameworkVersionExtension => ({
    descriptor: {
        framework: 'narranexus',
        runtimeKind: 'daemon',
        source: githubSource('narranexus'),
        binName: 'narranexus',
        // narranexus has no CLI; the installed version is the cloned git tag.
        probeShell:
            'git -C "$HOME/.narranexus/app" describe --tags 2>/dev/null || true',
        serviceName: 'narranexus'
    },
    rebuildShells: ({ version, repo }) => ({
        rebuild: buildNarraNexusRebuildShell(version, repo),
        restore: buildNarraNexusRestoreShell()
    })
})
