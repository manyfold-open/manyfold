// Markdown twins for the two surfaces that are not docs collection pages.
//
// /api-reference and /changelog both returned 404 for their .md twin, which
// meant the most structured page on the site and the release history were
// invisible to anything that prefers markdown. They cannot reuse
// renderDocMarkdown because neither is a CollectionEntry<'docs'>: the API
// reference is a typed structure in api-reference.ts and the changelog is its
// own collection.
//
// The leading pointer block is the same three lines every docs twin carries,
// so an agent that lands on either file learns where the full index is.
import type { CollectionEntry } from 'astro:content'
import {
    apiReferenceFor,
    endpointExamples,
    endpointPath,
    type ApiEndpoint
} from '@/lib/api-reference'
import { getUi, localePath, type Locale } from '@/lib/i18n'
import {
    changelogBody,
    changelogHref,
    changelogProduct,
    changelogTitle
} from '@/lib/changelog'

const pointer = (locale: Locale, abs: (p: string) => string) => [
    '> ## Documentation index',
    `> Fetch the complete documentation index at: ${abs(localePath(locale, '/llms.txt'))}`,
    '> Use this file to discover all available pages before exploring further.',
    ''
]

// Standalone .md twins open with the pointer block; the same bodies are also
// concatenated into llms-full.txt, which carries one pointer of its own at the
// top and must not repeat it at every surface boundary.
type SurfaceOptions = { pointer?: boolean }

const lead = (
    locale: Locale,
    abs: (p: string) => string,
    options: SurfaceOptions
): string[] => (options.pointer === false ? [] : pointer(locale, abs))

export const renderApiReferenceMarkdown = (
    locale: Locale,
    siteUrl: string,
    options: SurfaceOptions = {}
): string => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const ref = apiReferenceFor(locale)
    const out = [
        ...lead(locale, abs, options),
        `# ${ref.title}`,
        '',
        `> ${ref.description}`,
        '',
        `Source: ${abs(localePath(locale, '/api-reference'))}`,
        '',
        `## ${ref.tokensTitle}`,
        '',
        ref.tokensLead,
        '',
        `## ${ref.endpointsTitle}`,
        ''
    ]
    for (const endpoint of ref.endpoints) {
        out.push(
            `### ${endpoint.method} ${endpoint.path}`,
            '',
            `${endpoint.title}. ${endpoint.description}`,
            '',
            `Anchor: ${abs(localePath(locale, `/api-reference#${endpoint.id}`))}`,
            '',
            `Auth: ${endpoint.auth}`,
            `Quota: ${endpoint.quota}`,
            ''
        )
        if (endpoint.params.length) {
            out.push('| Parameter | Required | Description |', '| --- | --- | --- |')
            for (const param of endpoint.params) {
                out.push(
                    `| \`${param.name}\` | ${param.required ? 'yes' : 'no'} | ${param.description} |`
                )
            }
            out.push('')
        }
        if (endpoint.response.length) {
            out.push('Response:', '')
            for (const line of endpoint.response) out.push(`- ${line}`)
            out.push('')
        }
    }
    return out.join('\n')
}

export const renderChangelogMarkdown = (
    entries: CollectionEntry<'changelog'>[],
    locale: Locale,
    siteUrl: string,
    options: SurfaceOptions = {}
): string => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const copy = getUi(locale)
    const sorted = [...entries].sort((a, b) =>
        b.data.date.localeCompare(a.data.date)
    )
    const out = [
        ...lead(locale, abs, options),
        `# ${copy.changelogTitle}`,
        '',
        `> ${copy.changelogDescription}`,
        '',
        `Source: ${abs(localePath(locale, '/changelog'))}`,
        ''
    ]
    for (const entry of sorted) {
        // Each entry keeps the anchor the timeline publishes and the feed links
        // to, so a line quoted out of this file can still be traced back.
        out.push(
            `## ${entry.data.version} (${entry.data.date})`,
            '',
            `Anchor: ${abs(localePath(locale, `/changelog#v${entry.data.version}`))}`,
            '',
            (entry.body ?? '').trim(),
            ''
        )
    }
    return out.join('\n')
}

// One release's markdown twin. Carries both URLs a reader might want to cite:
// the release's own page, and its anchor in the index it came from.
export const renderChangelogEntryMarkdown = (
    entry: CollectionEntry<'changelog'>,
    locale: Locale,
    siteUrl: string
): string => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const copy = getUi(locale)
    return [
        ...pointer(locale, abs),
        `# ${changelogTitle(entry)}`,
        '',
        `> ${copy.changelogTitle} · ${changelogProduct(entry)} ${entry.data.version} · ${entry.data.date}`,
        '',
        `Source: ${abs(changelogHref(entry))}`,
        '',
        `In the index: ${abs(localePath(locale, `/changelog#v${entry.data.version}`))}`,
        '',
        changelogBody(entry),
        ''
    ].join('\n')
}

// One endpoint's markdown twin. Same anatomy as the page: signature, auth and
// quota, parameters, request, response.
export const renderEndpointMarkdown = (
    endpoint: ApiEndpoint,
    locale: Locale,
    siteUrl: string,
    options: SurfaceOptions = {}
): string => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const ref = apiReferenceFor(locale)
    const mapping = endpointExamples[endpoint.id]
    const out = [
        ...lead(locale, abs, options),
        `# ${endpoint.title}`,
        '',
        `> ${endpoint.description}`,
        '',
        `Source: ${abs(endpointPath(locale, endpoint.id))}`,
        '',
        '```http',
        `${endpoint.method} ${endpoint.path}`,
        '```',
        '',
        `${ref.authTitle}: ${endpoint.auth}`,
        `${ref.quotaTitle}: ${endpoint.quota}`,
        ''
    ]
    if (endpoint.params.length) {
        out.push(
            `## ${ref.paramsTitle}`,
            '',
            `| ${ref.paramsTitle} | ${ref.requiredLabel} | ${ref.descriptionLabel} |`,
            '| --- | --- | --- |'
        )
        for (const param of endpoint.params) {
            out.push(
                `| \`${param.name}\` | ${param.required ? ref.requiredLabel : ref.optionalLabel} | ${param.description} |`
            )
        }
        out.push('')
    }
    if (mapping) {
        out.push(`## ${ref.requestTitle}`, '', '```bash', ref.examples[mapping.request], '```', '')
        if (mapping.extra) {
            out.push(`## ${ref.streamingTitle}`, '', '```bash', ref.examples[mapping.extra], '```', '')
        }
        if (mapping.response) {
            out.push(`## ${ref.responseTitle}`, '', '```json', ref.examples[mapping.response], '```', '')
        }
    }
    if (endpoint.response.length) {
        out.push(`## ${ref.responseTitle}`, '')
        for (const line of endpoint.response) out.push(`- ${line}`)
        out.push('')
    }
    return out.join('\n')
}
