/** Lists every token divergence still flagged `drift: true`. */
import { listDrift } from '../src/emit'
import { productColors } from '../src/product-colors'

const drift = listDrift(productColors)
if (!drift.length) {
    console.log('  ✓ no unresolved token drift')
    process.exit(0)
}
console.log(`  ${drift.length} unresolved divergence(s):\n`)
for (const d of drift) {
    console.log(`  ${d.token}  (${d.consumer})`)
    console.log(`    ${d.reason}\n`)
}
