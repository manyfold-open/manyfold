import type { FC, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { tagToneClass } from '@/components/Tag'
import { UpdatesIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import { updatesPath, type UpdateKind } from '@/lib/updateCenter'

// The product's one shape for "which version is installed, and is anything
// newer out" — one pill, both facts. Every surface used to invent its own
// reminder (a red rail banner, four NoticeRows, inline `↑ v…` captions, a red
// card with recovery steps), and unifying them into a badge beside the version
// only halved the problem: the fact still arrived as two chips, and reading
// them meant diffing two version strings to learn the one thing a reminder is
// for. So the version pill carries it. Its tone says an update is out (info)
// or overdue (error), the trailing arrow is the press target that opens the
// Update Center, and neutral with no arrow is the whole story when the
// installed version is the newest one.
//
// Toned but dot-less (DESIGN.md §8.3): a released version is a fixed property
// of the world, not something happening on this machine right now. It is a
// press target wearing the tag anatomy for the same reason SpriteStatusRefresh
// is — the tag IS the thing the press acts on — and like that one it adds only
// hover opacity: no shadow, no new shape.
export const VersionTag: FC<{
    // What the pill says: the installed version, or whatever the surface puts
    // in its place when nothing was reported.
    label: string
    // The version an available update leads to. null = nothing newer, and the
    // pill is an ordinary technical-value tag.
    latest?: string | null
    required?: boolean
    // Deep-links the Update Center's kind filter, so arriving there does not
    // mean scanning a table for the row that sent you.
    kind?: UpdateKind
    // false when the pill sits inside something already clickable: an anchor
    // nested in a link or a button is invalid markup, and the outer press
    // target would swallow the click anyway.
    linked?: boolean
    // Versions carry a `v`; a skill's git revision must not, or the hover
    // label claims a release exists that no registry has ever heard of.
    prefix?: string
    // Hover label override, for a surface that knows something more useful
    // about this update than which version it leads to.
    hint?: string
    // Mono is for the version itself; a stand-in like "Version unknown" is a
    // human-readable label and stays sans (DESIGN.md §8.3).
    mono?: boolean
    className?: string
}> = ({
    label,
    latest = null,
    required = false,
    kind,
    linked = true,
    prefix = 'v',
    hint,
    mono = true,
    className
}): ReactNode => {
    const { t } = useI18n()
    const classes = [
        'tag',
        latest ? tagToneClass[required ? 'error' : 'info'] : 'tag-neutral',
        mono ? 'font-mono' : '',
        className
    ]
        .filter(Boolean)
        .join(' ')
    const tip =
        hint ??
        (latest
            ? t('web.updates.badgeCta', { version: `${prefix}${latest}` })
            : null)
    if (!latest) {
        const pill = <span className={classes}>{label}</span>
        return tip ? (
            <ShortcutTooltip label={tip}>{pill}</ShortcutTooltip>
        ) : (
            pill
        )
    }
    // The arrow is decorative — the pill already reads as the installed
    // version, and what the arrow adds is said in full by the hidden line
    // rather than by replacing the version with an aria-label.
    const body = (
        <>
            {label}
            <UpdatesIcon aria-hidden='true' className='h-3.5 w-3.5' />
            <span className='sr-only'>{tip}</span>
        </>
    )
    return (
        <ShortcutTooltip label={tip as string}>
            {linked ? (
                <Link
                    to={updatesPath(kind)}
                    className={`${classes} transition-opacity hover:opacity-80`}
                >
                    {body}
                </Link>
            ) : (
                <span className={classes}>{body}</span>
            )}
        </ShortcutTooltip>
    )
}
