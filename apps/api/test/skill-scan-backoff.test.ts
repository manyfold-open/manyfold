import assert from 'node:assert/strict'
import test from 'node:test'
import { Logger } from '@nestjs/common'
import {
    GitHubRequestError,
    githubRetryAt
} from '../src/common/github-request-error'
import {
    SKILL_SCAN_RETRY_CAP_MS,
    SKILL_SCAN_RETRY_FLOOR_MS,
    skillScanRetryDelayMs
} from '../src/modules/skills/skill-catalog-scan'
import { fetchSkillSource } from '../src/modules/skills/github-skill-source'
import { LibrarySkillsService } from '../src/modules/skills/library-skills.service'
import { githubFixture } from './helpers/github-discovery-fixture'

const NOW = Date.parse('2026-10-02T17:24:00Z')

test('Retry-After seconds, Retry-After dates and an exhausted x-ratelimit-reset each name the retry time', () => {
    assert.equal(
        githubRetryAt(new Headers({ 'retry-after': '120' }), NOW),
        NOW + 120_000
    )
    assert.equal(
        githubRetryAt(
            new Headers({ 'retry-after': 'Fri, 02 Oct 2026 17:30:00 GMT' }),
            NOW
        ),
        Date.parse('2026-10-02T17:30:00Z')
    )
    assert.equal(
        githubRetryAt(
            new Headers({
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(NOW / 1000 + 1800)
            }),
            NOW
        ),
        NOW + 1_800_000
    )
    // Retry-After wins over the primary window, as GitHub documents.
    assert.equal(
        githubRetryAt(
            new Headers({
                'retry-after': '60',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(NOW / 1000 + 1800)
            }),
            NOW
        ),
        NOW + 60_000
    )
})

test('a reset time with requests remaining, or no usable header, names no retry time', () => {
    assert.equal(
        githubRetryAt(
            new Headers({
                'x-ratelimit-remaining': '12',
                'x-ratelimit-reset': String(NOW / 1000 + 1800)
            }),
            NOW
        ),
        undefined
    )
    assert.equal(
        githubRetryAt(new Headers({ 'retry-after': 'soon' }), NOW),
        undefined
    )
    assert.equal(
        githubRetryAt(
            new Headers({
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': 'later'
            }),
            NOW
        ),
        undefined
    )
    assert.equal(githubRetryAt(new Headers(), NOW), undefined)
})

test('a failed scan waits at least a minute, doubling per consecutive failure up to an hour', () => {
    const exact = () => 0
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 40].map((failures) =>
            skillScanRetryDelayMs(failures, undefined, NOW, exact)
        ),
        [1, 2, 4, 8, 16, 32, 60, 60, 60].map((minutes) => minutes * 60_000)
    )
    assert.equal(SKILL_SCAN_RETRY_FLOOR_MS, 60_000)
    assert.equal(SKILL_SCAN_RETRY_CAP_MS, 3_600_000)
})

test('a named retry time is a lower bound the scan never undercuts, capped at an hour', () => {
    const exact = () => 0
    assert.equal(
        skillScanRetryDelayMs(1, NOW + 25 * 60_000, NOW, exact),
        25 * 60_000
    )
    // A short Retry-After still waits the minute floor.
    assert.equal(skillScanRetryDelayMs(1, NOW + 5_000, NOW, exact), 60_000)
    // A later failure keeps growing past a short named time.
    assert.equal(
        skillScanRetryDelayMs(4, NOW + 60_000, NOW, exact),
        8 * 60_000
    )
    assert.equal(
        skillScanRetryDelayMs(1, NOW + 5 * 3_600_000, NOW, exact),
        3_600_000
    )
})

test('jitter only lengthens the wait, by at most a fifth', () => {
    for (const random of [0, 0.25, 0.5, 0.999]) {
        const delay = skillScanRetryDelayMs(
            1,
            NOW + 25 * 60_000,
            NOW,
            () => random
        )
        assert.ok(delay >= 25 * 60_000, String(delay))
        assert.ok(delay <= 30 * 60_000, String(delay))
    }
})

test('a GitHub source error with a retry time answers with Retry-After seconds', () => {
    const now = Date.now()
    const limited = new GitHubRequestError(
        'rate_limited',
        'request',
        now + 90_500
    )
    const body = limited.getResponse() as Record<string, unknown>
    assert.equal(body.code, 'github_source_unavailable')
    assert.ok(
        body.retryAfterSec === 91 || body.retryAfterSec === 90,
        String(body.retryAfterSec)
    )
    assert.deepEqual(body.details, { classification: 'rate_limited' })
    const plain = new GitHubRequestError('upstream')
    assert.equal(
        (plain.getResponse() as Record<string, unknown>).retryAfterSec,
        undefined
    )
})

for (const [label, headers, expected] of [
    [
        'an exhausted REST window',
        (now: number) => ({
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(now / 1000) + 900)
        }),
        (now: number) => Math.floor(now / 1000) * 1000 + 900_000
    ],
    [
        'a secondary limit Retry-After',
        () => ({ 'retry-after': '45' }),
        (now: number) => now + 45_000
    ]
] as const)
    test(`a rate-limited source fetch carries the retry time of ${label}`, async (t) => {
        const h = await githubFixture(t)
        h.state.failPath = '/commits/'
        h.state.failStatus = 403
        const now = Date.now()
        h.state.failHeaders = headers(now)
        h.state.failBody = 'API rate limit exceeded'
        await assert.rejects(
            fetchSkillSource(
                'https://api.github.com/repos/fixture-owner/skills/commits/main'
            ),
            (error: unknown) => {
                assert.ok(error instanceof GitHubRequestError)
                assert.equal(error.classification, 'rate_limited')
                assert.ok(error.retryAt !== undefined)
                assert.ok(
                    Math.abs(error.retryAt - expected(now)) < 2_000,
                    `${error.retryAt} vs ${expected(now)}`
                )
                return true
            }
        )
    })

test('a raw-content 429 without headers is rate limited with no retry time of its own', async (t) => {
    const h = await githubFixture(t)
    h.state.failPath = '/SKILL.md'
    h.state.failStatus = 429
    await assert.rejects(
        fetchSkillSource(
            `https://raw.githubusercontent.com/fixture-owner/skills/${'a'.repeat(40)}/SKILL.md`
        ),
        (error: unknown) => {
            assert.ok(error instanceof GitHubRequestError)
            assert.equal(error.classification, 'rate_limited')
            assert.equal(error.retryAt, undefined)
            return true
        }
    )
})

test('a skill import that GitHub refuses logs the stage and classification only', async (t) => {
    const warnings: string[] = []
    t.mock.method(Logger.prototype, 'warn', (message: unknown) => {
        warnings.push(String(message))
    })
    const service = new LibrarySkillsService(
        {} as never,
        {
            fetchDefaultBranch: async () => {
                throw new GitHubRequestError(
                    'rate_limited',
                    'request',
                    Date.now() + 60_000
                )
            }
        } as never,
        {} as never,
        {} as never
    )
    await assert.rejects(
        service.importFromSource('user-1', {
            url: 'https://github.com/private-owner/private-repository'
        }),
        (error: unknown) =>
            error instanceof GitHubRequestError &&
            error.classification === 'rate_limited'
    )
    assert.deepEqual(warnings, [
        'skill import failed: source=github stage=fetch classification=rate_limited'
    ])
})
