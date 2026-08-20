import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { apiReferenceFor } from '@/lib/api-reference'
import {
    entryHref,
    entryLocale,
    getSupportUi,
    getUi,
    localePath,
    locales,
    type Locale
} from '@/lib/i18n'

type Record = {
    title: string
    description: string
    url: string
    locale: Locale
    section: string
    text: string
}

const plain = (markdown: string): string =>
    markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[#>*_~|-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

export const GET: APIRoute = async () => {
    const docs = await getCollection('docs')
    const records: Record[] = []

    for (const entry of docs) {
        const locale = entryLocale(entry)
        const ui = getUi(locale)
        records.push({
            title: entry.data.title,
            description: entry.data.description ?? '',
            url: entryHref(entry, locale),
            locale,
            section: ui.docs,
            text: plain(entry.body ?? '').slice(0, 2400)
        })
    }

    for (const locale of locales) {
        const ui = getUi(locale)
        const reference = apiReferenceFor(locale)
        records.push({
            title: reference.title,
            description: reference.description,
            url: localePath(locale, '/api-reference/'),
            locale,
            section: ui.apiReference,
            text: `${reference.quickStartLead} ${reference.endpoints
                .map((e) => `${e.method} ${e.path} ${e.title} ${e.description}`)
                .join(' ')}`
        })
        records.push({
            title: ui.changelogTitle,
            description: ui.changelogLead,
            url: localePath(locale, '/changelog/'),
            locale,
            section: ui.changelog,
            text: ui.changelogLead
        })
        records.push({
            title: ui.statusTitle,
            description: ui.statusLead,
            url: localePath(locale, '/status/'),
            locale,
            section: ui.status,
            text: `${ui.statusLead} ${ui.statusOk}`
        })
        const support = getSupportUi(locale)
        records.push({
            title: support.supportTitle,
            description: support.supportDescription,
            url: localePath(locale, '/support/'),
            locale,
            section: support.supportNavLabel,
            text: `${support.supportLead} ${support.starterQuestions.join(' ')}`
        })
    }

    return new Response(JSON.stringify(records), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}
