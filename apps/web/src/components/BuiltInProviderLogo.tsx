import type { FC, ReactNode } from 'react'
import type { BuiltInProviderEntry, UserModelProvider } from '@manyfold/shared'
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg'
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg'
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter.svg'
import { NetmindMark } from '@/lib/brandMarks'

// The brand marks the model-provider surfaces share: the settings rail, its
// create menu and the agent-create menu all box the same 16px glyph.
const providerIconSrc: Record<UserModelProvider, string> = {
    anthropic: anthropicIcon,
    openai: openaiIcon,
    openrouter: openrouterIcon,
    google: geminiIcon,
    antigravity: geminiIcon,
    antigravity_claude: anthropicIcon
}

const builtInIcons: Record<string, FC<{ className?: string }>> = {
    netmind: NetmindMark
}

export const ProviderLogo: FC<{ provider: UserModelProvider }> = ({
    provider
}): ReactNode => (
    <img
        src={providerIconSrc[provider]}
        alt=''
        aria-hidden='true'
        className={['h-4 w-4', provider === 'google' ? '' : 'dark:invert'].join(
            ' '
        )}
    />
)

export const BuiltInLogo: FC<{ entry: BuiltInProviderEntry }> = ({
    entry
}): ReactNode => {
    const Icon = builtInIcons[entry.id]
    if (Icon) return <Icon className='text-fg' />
    if (entry.brand) return <ProviderLogo provider={entry.brand} />
    return (
        <span className='text-caption text-muted font-mono'>
            {entry.label.charAt(0).toUpperCase()}
        </span>
    )
}
