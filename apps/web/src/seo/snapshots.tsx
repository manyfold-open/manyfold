import type { FC, ReactNode } from 'react'
import { LandingSnapshot } from '@/seo/LandingSnapshot'
import { ChannelsSnapshot } from '@/seo/ChannelsSnapshot'
import { SeoClosingCta } from '@/seo/SeoClosingCta'
import type { SeoLanguage, SeoPageEntry } from '@/seo/pages'

// Which crawler body belongs to which manifest page. Build-time only, so it
// lives apart from the manifest: pages.ts is imported by the router, the
// title resolver and the nav, none of which should pull a React tree they
// never render.
export type SeoSnapshot = FC<{ entry: SeoPageEntry }>

const CORE_SNAPSHOTS: Record<string, SeoSnapshot> = {
    home: LandingSnapshot,
    channels: ChannelsSnapshot
}

/* An editions-slot page describes its crawler body as data rather than
   shipping a component, and this file renders it. Not a stylistic
   preference: the post-build renderer loads a composition's modules through
   tsx from inside apps/web, and a .tsx file outside that app is transformed
   with the classic JSX runtime whatever its own tsconfig or
   `@jsxImportSource` pragma says — the render throws 'React is not defined'
   on the first element. Data crosses the boundary; JSX does not. */
export interface SeoSnapshotSection {
    eyebrow?: string
    title: string
    lead?: string
    /* An ordered list when the items are a sequence rather than a set. */
    ordered?: boolean
    bullets?: string[]
    faq?: Array<{ q: string; a: string }>
    /* A closing line under the list, the way the landing sections carry one. */
    note?: string
}

export interface SeoSnapshotBody {
    heroEyebrow?: string
    heroNote?: string
    sections: SeoSnapshotSection[]
}

export type SeoSnapshotBodies = Record<
    string,
    (language: SeoLanguage) => SeoSnapshotBody
>

const SectionBlock: FC<{ section: SeoSnapshotSection }> = ({
    section
}): ReactNode => {
    const List = section.ordered ? 'ol' : 'ul'
    return (
        <section className='lp-section seo-section'>
            <div className='lp-container'>
                {section.eyebrow ? (
                    <p className='lp-eyebrow'>{section.eyebrow}</p>
                ) : null}
                <h2 className='lp-h2'>{section.title}</h2>
                {section.lead ? (
                    <p className='lp-lead'>{section.lead}</p>
                ) : null}
                {section.bullets ? (
                    <List className='seo-bullets'>
                        {section.bullets.map((bullet) => (
                            <li key={bullet}>{bullet}</li>
                        ))}
                    </List>
                ) : null}
                {section.faq ? (
                    <dl className='seo-faq'>
                        {section.faq.map((item) => (
                            <div key={item.q}>
                                <dt>{item.q}</dt>
                                <dd>{item.a}</dd>
                            </div>
                        ))}
                    </dl>
                ) : null}
                {section.note ? (
                    <p className='seo-positioning'>{section.note}</p>
                ) : null}
            </div>
        </section>
    )
}

/* The hero and the closing call come off the manifest entry, so every
   editions page opens and closes the way the core ones do and only the
   middle is its own. */
const editionSnapshot =
    (build: (language: SeoLanguage) => SeoSnapshotBody): SeoSnapshot =>
    ({ entry }): ReactNode => {
        const body = build(entry.language)
        return (
            <main className='seo-main'>
                <section className='lp-section seo-hero'>
                    <div className='lp-container'>
                        {body.heroEyebrow ? (
                            <p className='lp-eyebrow'>{body.heroEyebrow}</p>
                        ) : null}
                        <h1 className='lp-h1'>{entry.copy.h1}</h1>
                        <p className='lp-lead'>{entry.copy.lead}</p>
                        <div className='seo-ctas'>
                            <a
                                className='lp-btn lp-btn-primary'
                                href={entry.copy.ctaPrimary.href}
                            >
                                {entry.copy.ctaPrimary.label}
                            </a>
                            <a
                                className='lp-btn lp-btn-secondary'
                                href={entry.copy.ctaSecondary.href}
                            >
                                {entry.copy.ctaSecondary.label}
                            </a>
                        </div>
                        {body.heroNote ? (
                            <p className='seo-positioning'>{body.heroNote}</p>
                        ) : null}
                    </div>
                </section>
                {body.sections.map((section) => (
                    <SectionBlock key={section.title} section={section} />
                ))}
                <SeoClosingCta entry={entry} />
            </main>
        )
    }

/* A page in the manifest with no snapshot is a build error, not a page that
   quietly serves somebody else's body. That is exactly what happened when
   the renderer defaulted every entry to LandingSnapshot: the channels page
   shipped the home page's sections under the channels headline, and every gate was
   green because nothing claimed otherwise. */
export const snapshotFor = (
    key: string,
    bodies: SeoSnapshotBodies = {}
): SeoSnapshot => {
    const core = CORE_SNAPSHOTS[key]
    if (core) return core
    const build = bodies[key]
    if (!build)
        throw new Error(
            `SEO page '${key}' is in the manifest with no crawler snapshot`
        )
    return editionSnapshot(build)
}
