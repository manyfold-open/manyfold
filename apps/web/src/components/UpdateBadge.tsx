import type { FC, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { tagToneClass } from '@/components/Tag'
import { useI18n } from '@/lib/i18n'
import { updatesPath, type UpdateKind } from '@/lib/updateCenter'

// The product's one shape for "a newer version exists", to be rendered beside
// whatever already shows the installed one. Every surface used to invent its
// own — a red rail banner, four NoticeRows, a handful of inline `↑ v…`
// captions, a red card with recovery steps — so the same fact arrived in five
// registers and none of them could be scanned at a glance.
//
// Toned but dot-less (DESIGN.md §8.3): a released version is a fixed property
// of the world, not something happening on this machine right now. Mono
// because the content is a version. It is a press target wearing the tag
// anatomy for the same reason SpriteStatusRefresh is — the tag IS the thing it
// acts on — and like that one it adds only hover opacity: no shadow, no new
// shape.
export const UpdateBadge: FC<{
    latest: string | null
    // Deep-links the Update Center's kind filter, so arriving there does not
    // mean scanning a table for the row that sent you.
    kind?: UpdateKind
    required?: boolean
    // false when the badge sits inside something already clickable: an anchor
    // nested in a link or a button is invalid markup, and the outer press
    // target would swallow the click anyway.
    linked?: boolean
    // Versions carry a `v`; a skill's git revision must not, or the badge
    // claims a release exists that no registry has ever heard of.
    prefix?: string
    className?: string
}> = ({
    latest,
    kind,
    required = false,
    linked = true,
    prefix = 'v',
    className
}): ReactNode => {
    const { t } = useI18n()
    if (!latest) return null
    const version = `${prefix}${latest}`
    const classes = [
        'tag',
        tagToneClass[required ? 'error' : 'info'],
        'font-mono',
        className
    ]
        .filter(Boolean)
        .join(' ')
    if (!linked) return <span className={classes}>↑ {version}</span>
    return (
        <Link
            to={updatesPath(kind)}
            aria-label={t('web.updates.badgeCta', { version })}
            className={`${classes} transition-opacity hover:opacity-80`}
        >
            ↑ {version}
        </Link>
    )
}
