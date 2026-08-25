---
'@manyfold/docs': patch
---

Structured data, and two things that were wrong about every page's outline.

A page said where it sat and never what it was: `BreadcrumbList` was the only
schema.org node the docs emitted. Guides, endpoints and the API landing now
carry `TechArticle`, release notes carry `Article` with the date they were
published, and the docs home carries the `WebSite` and `Organization` the rest
reference. The guides publish no `dateModified`, because they carry no date to
publish — a build timestamp would assert a freshness the content cannot back.

The agent-facing index block at the top of every page was a heading, and it
sits above the article, so 167 pages opened their outline one level below their
own title. It is a bold paragraph now; it reads identically to a text
extractor and no longer inverts the document. Release notes ran from the page
title straight to a third-level heading, because the second-level line they
were authored under is lifted out to become the title; what is left is lifted
with it.

Twelve release notes carried a meta description over 250 characters — the
entry's first paragraph, unclamped — of which a search result would show
about 160. They are cut at a word boundary.

The build's SEO check gains three gates for all of the above: no heading may
precede the `h1` and no level may be skipped, a page that calls itself an
article must carry the matching JSON-LD at its canonical URL, and a meta
description may not exceed what a result will show.
