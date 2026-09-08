import type { FC, ReactNode } from 'react'
import type { SeoPageEntry } from '@/seo/pages'

// The closing call every manifest page carries in its copy: a heading, the
// page's two buttons again, and the docs a reader who is not ready to sign up
// goes to instead. It exists as its own component because a crawler page ends
// where the argument ends, and the argument ends in an ask — the live pages
// close on the thing they were arguing for and rely on the hero's buttons,
// which a no-JS reader has already scrolled past by then.
export const SeoClosingCta: FC<{ entry: SeoPageEntry }> = ({
    entry
}): ReactNode => {
    const { copy } = entry
    return (
        <section className='lp-section seo-section seo-close'>
            <div className='lp-container'>
                <h2 className='lp-h2'>{copy.ctaTitle}</h2>
                <div className='seo-ctas'>
                    <a
                        className='lp-btn lp-btn-primary'
                        href={copy.ctaPrimary.href}
                    >
                        {copy.ctaPrimary.label}
                    </a>
                    <a
                        className='lp-btn lp-btn-secondary'
                        href={copy.ctaSecondary.href}
                    >
                        {copy.ctaSecondary.label}
                    </a>
                </div>
                <p className='seo-docs-label'>{copy.docsLinksLabel}</p>
                <ul className='seo-bullets'>
                    {copy.docsLinks.map((link) => (
                        <li key={link.href}>
                            <a href={link.href}>{link.label}</a>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    )
}
