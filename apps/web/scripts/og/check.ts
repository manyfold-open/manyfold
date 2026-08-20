import { posterContractFailures } from './contract'

// Runs on every pull request. Reads files only — no browser — because the
// pixels cannot be re-derived in CI, only checked against what was committed.
const failures = posterContractFailures()
if (failures.length === 0) {
    console.log(
        'social card: cards, copy and references agree with poster.lock.json'
    )
} else {
    console.error(`social card: ${failures.length} problem(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
}
