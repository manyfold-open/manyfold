/** Every divergence this package holds at its current value on purpose,
    because resolving it is a visible change that needs its own decision.

    The list must only shrink. Each source has a test pinning its size, so a
    new entry cannot land quietly. */
import { listDrift } from '../src/emit'
import { listEmailDrift } from '../src/email'
import { landingColors } from '../src/landing-colors'
import { productColors } from '../src/product-colors'
import { headingWeight } from '../src/typography'

interface Row {
    group: string
    what: string
    reason: string
}

const rows: Row[] = []

for (const d of listDrift(productColors)) {
    rows.push({
        group: 'webapp ↔ docs colour',
        what: `${d.token} (${d.consumer})`,
        reason: d.reason
    })
}
for (const d of listDrift(landingColors)) {
    rows.push({
        group: 'landing colour',
        what: `${d.token} (${d.consumer})`,
        reason: d.reason
    })
}
for (const d of listEmailDrift()) {
    rows.push({
        group: 'email ↔ product colour',
        what: `${d.field} (${d.theme})`,
        reason: d.reason
    })
}
if (headingWeight.docs.drift) {
    rows.push({
        group: 'typography',
        what: 'docs h1–h4 font-weight 600',
        reason: headingWeight.docs.reason
    })
}

if (!rows.length) {
    console.log('  ✓ no unresolved design-token drift')
    process.exit(0)
}

const byGroup = new Map<string, Row[]>()
for (const row of rows) {
    byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), row])
}

console.log(`\n  ${rows.length} unresolved divergence(s):\n`)
for (const [group, entries] of byGroup) {
    console.log(`  ── ${group} (${entries.length})`)
    for (const entry of entries) {
        console.log(`     ${entry.what}`)
        console.log(`       ${entry.reason}\n`)
    }
}
console.log(
    '  Each is held at its live value, so nothing renders differently today.\n' +
        '  Resolving one means deleting its entry and updating the count its test pins.\n'
)
