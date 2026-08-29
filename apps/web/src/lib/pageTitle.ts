import { useEffect, type FC } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import { useI18n } from '@/lib/i18n'
import { seoTitleForPath } from '@/seo/pages'

const BRAND = 'Manyfold'

interface TitleRoute {
    path: string
    labelKey: string
    // The key already resolves to a complete title, so the brand is not
    // appended — the two campaign pages carry their own branding.
    full?: true
}

// Ordered most specific first, and every section ends in a splat so a new page
// under it inherits the section name instead of falling back to the bare brand.
// Labels are reused from the navigation wherever one already exists, so a page
// and the link that reaches it cannot drift apart.
const TITLE_ROUTES: TitleRoute[] = [
    {
        path: '/challenge/status',
        labelKey: 'web.challenge.status.docTitle',
        full: true
    },
    { path: '/challenge', labelKey: 'web.challenge.doc.title', full: true },
    { path: '/login/*', labelKey: 'web.pageTitle.signIn' },
    { path: '/cli-login', labelKey: 'web.pageTitle.cliLogin' },
    { path: '/connect/a2a', labelKey: 'web.pageTitle.connectAgent' },
    { path: '/grant-permission', labelKey: 'web.pageTitle.grantPermission' },
    { path: '/invite/:token', labelKey: 'web.pageTitle.invite' },
    {
        path: '/account/deletion/confirm',
        labelKey: 'web.accountDeletion.confirmTitle'
    },
    {
        path: '/account/deletion/restore',
        labelKey: 'web.accountDeletion.restoreTitle'
    },

    { path: '/workspace', labelKey: 'web.pageTitle.workspace' },
    { path: '/agents/new', labelKey: 'web.shell.newAgent' },
    { path: '/agents/:id/chat', labelKey: 'web.pageTitle.chat' },
    { path: '/agents/:id', labelKey: 'web.pageTitle.agent' },
    { path: '/agents/*', labelKey: 'web.pageTitle.workspace' },
    { path: '/automations/*', labelKey: 'web.shell.automations' },

    { path: '/chat/shared/:shareId', labelKey: 'web.pageTitle.sharedChat' },
    { path: '/skills/shared/:shareId', labelKey: 'web.pageTitle.sharedSkill' },
    { path: '/skills/library/edit', labelKey: 'web.pageTitle.skillEditor' },
    { path: '/skills/library', labelKey: 'web.customize.navMySkills' },
    { path: '/skills/repos', labelKey: 'web.skills.reposTab' },
    { path: '/skills/detail', labelKey: 'web.pageTitle.skill' },
    { path: '/skills/*', labelKey: 'web.customize.navSkillsCatalog' },
    { path: '/mcp/library', labelKey: 'web.customize.navMyMcp' },
    { path: '/mcp/:serverId', labelKey: 'web.pageTitle.mcpServer' },
    { path: '/mcp/*', labelKey: 'web.customize.navMcpCatalog' },
    { path: '/connections/:id', labelKey: 'web.pageTitle.connection' },
    { path: '/connections/*', labelKey: 'web.customize.navConnections' },
    { path: '/connectors/*', labelKey: 'web.customize.navConnections' },

    { path: '/settings/general', labelKey: 'web.settingsLayout.general' },
    { path: '/settings/account', labelKey: 'web.settingsLayout.account' },
    { path: '/settings/api-tokens', labelKey: 'web.settingsLayout.apiTokens' },
    {
        path: '/settings/api-tokens/*',
        labelKey: 'web.settingsLayout.apiTokens'
    },
    {
        path: '/settings/cloud-computers',
        labelKey: 'web.settingsLayout.cloudComputers'
    },
    {
        path: '/settings/runtimes/local-daemons',
        labelKey: 'web.settingsLayout.localDaemons'
    },
    {
        path: '/settings/runtimes/external-agent-providers',
        labelKey: 'web.settingsLayout.externalAgentProviders'
    },
    {
        path: '/settings/plan-and-billing/pricing',
        labelKey: 'web.pricing.title'
    },
    {
        path: '/settings/plan-and-billing/sandbox-usage',
        labelKey: 'web.sandboxUsage.title'
    },
    {
        path: '/settings/plan-and-billing/*',
        labelKey: 'web.settingsLayout.planAndBilling'
    },
    {
        path: '/settings/model-providers/*',
        labelKey: 'web.settingsLayout.providers'
    },
    { path: '/settings/runtimes/*', labelKey: 'web.settingsLayout.runtimes' },
    { path: '/settings/channels/*', labelKey: 'web.settingsLayout.channels' },
    { path: '/settings/usage/*', labelKey: 'web.settingsLayout.usage' },
    {
        path: '/settings/connections/*',
        labelKey: 'web.customize.navConnections'
    },
    { path: '/settings/skills/*', labelKey: 'web.customize.navSkillsCatalog' },
    { path: '/settings/*', labelKey: 'web.settingsLayout.kicker' },

    { path: '/agent-runtimes/*', labelKey: 'web.settingsLayout.runtimes' },
    { path: '/usage/*', labelKey: 'web.settingsLayout.usage' }
]

export const pageTitleFor = (pathname: string): string => {
    // Indexable marketing URLs resolve from the SEO manifest so the static
    // head, the tab title and the GA page_title are literally the same
    // string — and stay in the language the URL pins, not the UI language.
    const seoTitle = seoTitleForPath(pathname)
    if (seoTitle) return seoTitle
    for (const route of TITLE_ROUTES) {
        if (!matchPath(route.path, pathname)) continue
        const label = t(route.labelKey)
        return route.full ? label : `${label} · ${BRAND}`
    }
    return BRAND
}

// The matched label with no brand appended. The shell's mobile header prints
// it above a link that already says Manyfold, so the suffix would read as a
// stutter there. Null when no route matches, leaving the fallback to the
// caller.
export const pageLabelFor = (pathname: string): string | null => {
    for (const route of TITLE_ROUTES)
        if (matchPath(route.path, pathname)) return t(route.labelKey)
    return null
}

export const DocumentTitle: FC = () => {
    const { pathname } = useLocation()
    // Re-runs on a language switch so the tab does not keep the old wording.
    const { language } = useI18n()
    useEffect(() => {
        document.title = pageTitleFor(pathname)
    }, [pathname, language])
    return null
}
