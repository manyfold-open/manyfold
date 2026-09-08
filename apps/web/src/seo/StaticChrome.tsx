import type { FC, ReactNode } from 'react'
import { BrandMark } from '@/components/Brand'
import { t } from '@manyfold/i18n'
import { marketingLinksFor } from '@/seo/marketingLinks'
import type { SeoFooterLink, SeoLanguage } from '@/seo/pages'

// Minimal nav/footer for crawler HTML: context-free on purpose, since this
// renders through react-dom/server in a plain node process with no router,
// auth or theme context available. React swaps in the real MarketingNav /
// MarketingFooter once it boots.

export const StaticMarketingHeader: FC<{ language: SeoLanguage }> = ({
    language
}): ReactNode => {
    const links = marketingLinksFor(language)
    const labels = {
        docs: t('web.landing.navDocs'),
        signIn: t('web.seo.signIn')
    }
    return (
        <header className='lp-nav'>
            <div className='lp-nav-inner'>
                <div className='lp-nav-inner-left'>
                    <a
                        href={links.home}
                        aria-label='Manyfold'
                        className='lp-brand'
                    >
                        <BrandMark className='lp-brand-mark' />
                        <span>Manyfold</span>
                    </a>
                    <a
                        className='lp-nav-chip lp-nav-chip-docs'
                        href={links.docs}
                    >
                        <span>{labels.docs}</span>
                    </a>
                </div>
                <div className='lp-nav-actions'>
                    <div className='lp-nav-desktop'>
                        <a className='lp-nav-chip' href='/login'>
                            {labels.signIn}
                        </a>
                    </div>
                </div>
            </div>
        </header>
    )
}

export const StaticMarketingFooter: FC<{
    language: SeoLanguage
    /* The manifest pages to link. Passed in rather than read here because
       the post-build renderer knows about a composition's pages and this
       module, loaded through the core manifest, does not. */
    pages?: SeoFooterLink[]
}> = ({ language, pages = [] }): ReactNode => {
    const links = marketingLinksFor(language)
    const labels = {
        docs: t('web.landing.navDocs'),
        legal: t('web.seo.legal'),
        privacy: t('web.seo.privacy'),
        terms: t('web.seo.terms')
    }
    return (
        <footer className='lp-foot'>
            <div className='lp-container'>
                <div className='lp-foot-row'>
                    <div className='lp-foot-left'>
                        <a
                            href={links.home}
                            aria-label='Manyfold'
                            className='lp-brand'
                        >
                            <BrandMark className='lp-brand-mark' />
                            <span>Manyfold</span>
                        </a>
                        <span className='lp-copy'>{labels.legal}</span>
                    </div>
                    {/* Deliberately still the short list — this footer
                        exists to give a crawler something, not to mirror the
                        real one. The manifest's own pages earn a place in it
                        because a link from every indexed page is how a page
                        gets found, and the sitemap is not the only way. */}
                    <nav className='lp-foot-links'>
                        {pages.map((page) => (
                            <a key={page.path} href={page.path}>
                                {page.label}
                            </a>
                        ))}
                        <a href={links.docs}>{labels.docs}</a>
                        <a href={links.privacy}>{labels.privacy}</a>
                        <a href={links.terms}>{labels.terms}</a>
                    </nav>
                </div>
            </div>
        </footer>
    )
}
