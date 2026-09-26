// The stderr a managed Gemini turn actually ends in when the sub2api pool is
// empty, and the lookalikes that must never be mistaken for it.
//
// #660 was reopened because the breaker was proven against a JSON envelope the
// gateway sends and the CLI does not always print, and reopened a second time
// because the capture that replaced it was a paraphrase missing a field the
// real one has. Every layer that has to agree about this shape — the adapter,
// the failure classifier, the ChatService settle step and the Postgres breaker
// — reads the bytes from here, so a grammar that stops recognising the real
// thing cannot keep any of them green.
//
// Captured by re-running the printer rather than by paraphrasing it: gemini-cli
// lets an `_ApiError` reach Node's top level, and Node formats it with
// util.inspect. Hence bare identifier keys, single-quoted values, `[cause]` for
// the non-enumerable own property `new Error(msg, { cause })` installs, and the
// wrap across lines that any pair past the 80-column break gets — which this
// literal is. Reproduce with:
//
//     node -e "const e = new Error('got status: 503.', { cause: { code: 503, \
//       message: 'No available Gemini accounts: no available accounts', \
//       details: [] } }); console.error(e)"
//
// `details: []` is the third field and the reason #660 stayed open past #808
// (Seen on staging [2026-08-13]): the cause is the gateway's google.rpc.Status
// body, which always carries `details` beside `code` and `message`, and the
// first reader's cause grammar rejected any `[` in the body. The paraphrased
// capture that omitted it passed every layer while production matched nothing,
// so the whole point of this literal is that it is not paraphrased.
//
// Note what is NOT here: the pool literal appears only inside the inspected
// cause. The 503 the CLI names in its own first line carries no JSON copy of
// it, which is exactly why a reader that only understands JSON envelopes came
// away with nothing.
export const GEMINI_NODE_INSPECT_POOL_EMPTY = [
    '_ApiError: got status: 503. Gateway refused the request.',
    '    at handleResponse (/usr/lib/node_modules/@google/gemini-cli/node_modules/@google/genai/dist/node/index.mjs:1:1)',
    '    at async retryWithBackoff (/usr/lib/node_modules/@google/gemini-cli/dist/src/utils/retry.js:1:1)',
    '    at async GeminiChat.sendMessageStream (/usr/lib/node_modules/@google/gemini-cli/dist/src/core/geminiChat.js:1:1) {',
    '  status: 503,',
    '  [cause]: {',
    '    code: 503,',
    "    message: 'No available Gemini accounts: no available accounts',",
    '    details: []',
    '  }',
    '}'
].join('\n')

// The whole trace, in the order staging produced it: gemini-cli meets a
// throttle, quotes a perfectly valid structured 429, walks its own retry ladder
// for minutes, and only then reports the empty pool in the shape above.
//
// The mixed shape IS the regression. A reader that takes the FIRST structured
// error it can parse finds the 429 and stops; the terminal then claims a
// throttle the user should retry, and the breaker is told the pool is fine.
export const GEMINI_MIXED_THROTTLE_THEN_POOL_EMPTY = [
    'ApiError: got status: 429 Too Many Requests. {"error":{"code":429,' +
        '"message":"Resource has been exhausted (e.g. check quota).",' +
        '"status":"RESOURCE_EXHAUSTED"}}',
    ...Array.from(
        { length: 9 },
        (_, i) =>
            `Attempt ${i + 1} failed with status 429. Retrying in ${5 * 2 ** i}s...`
    ),
    GEMINI_NODE_INSPECT_POOL_EMPTY
].join('\n')

// Everything that looks like the real thing to a human and must not to us.
// Shared so the adapter, the classifier and the breaker refuse the same set —
// a shape one layer rejects and another accepts is how a generic 503 ends up
// taking a healthy channel away from every user.
//
// The last three cover loose model-authored echoes. The exact-block provenance
// boundary is exercised through the adapter in gemini-rate-limit.test.ts.
//
// The middle group is the negative half of reading a cause body that can
// contain brackets at all. Reading one costs a real reader for the inspect
// grammar, and each of those rows is a way that reader could be talked into a
// verdict the printer never made: the pair one level down, a code that is a
// string, a body the stderr bound cut, a body spliced back together across the
// elision, or two answers to the same key.
const POOL_LITERAL = 'No available Gemini accounts: no available accounts'

// A terminal in the exact grammar of the captured one, around a cause body the
// row controls, so each row reads as the single thing it changes.
const inspectedTerminal = (causeBody: string): string =>
    `_ApiError: got status: 503. Gateway refused the request.\n    at handleResponse (/usr/lib/node_modules/@google/gemini-cli/dist/index.js:1:1) {\n  status: 503,\n  [cause]: ${causeBody}\n}`

export const MANAGED_POOL_EMPTY_LOOKALIKES: readonly (readonly [
    string,
    string
])[] = [
    ['bare prose', '503 No available Gemini accounts: no available accounts'],
    [
        'a generic 503 in the real grammar',
        "_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    message: 'Service Unavailable'\n  }\n}"
    ],
    [
        'the pool literal under a status that is not 503',
        "_ApiError: got status: 500 {\n  [cause]: {\n    code: 500,\n    message: 'No available Gemini accounts: no available accounts'\n  }\n}"
    ],
    [
        'the pool literal in a cause block with no status at all',
        "_ApiError: failed {\n  [cause]: {\n    message: 'No available Gemini accounts: no available accounts'\n  }\n}"
    ],
    [
        'the pool literal nested below the cause',
        "_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    detail: { message: 'No available Gemini accounts: no available accounts' }\n  }\n}"
    ],
    [
        'the pool literal under a key that is not message',
        "_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    hint: 'No available Gemini accounts: no available accounts'\n  }\n}"
    ],
    [
        'an escaped run inside the value',
        "_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    message: 'No available Gemini accounts: no available accounts\\'\n  }\n}"
    ],
    [
        'a double-quoted value, which Node never prints for this string',
        '_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    message: "No available Gemini accounts: no available accounts"\n  }\n}'
    ],
    [
        'a reworded literal',
        "_ApiError: got status: 503 {\n  [cause]: {\n    code: 503,\n    message: 'No available Gemini accounts right now, try later'\n  }\n}"
    ],
    [
        'the literal on a cause key it only looks like',
        "_ApiError: got status: 503 {\n  rootcause: {\n    code: 503,\n    message: 'No available Gemini accounts: no available accounts'\n  }\n}"
    ],
    [
        'the pair one level down, inside the details array',
        inspectedTerminal(
            `{\n    details: [ { code: 503, message: '${POOL_LITERAL}' } ]\n  }`
        )
    ],
    [
        'the message at this level and the code below it',
        inspectedTerminal(
            `{\n    detail: { code: 503 },\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'a code that is a string, which is not what Node printed',
        inspectedTerminal(
            `{\n    code: '503',\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'a bigint code, for the same reason',
        inspectedTerminal(
            `{\n    code: 503n,\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'a body the stderr bound cut off mid-array',
        inspectedTerminal(
            `{\n    code: 503,\n    message: '${POOL_LITERAL}',\n    details: [`
        )
    ],
    [
        'a body with mismatched nested delimiters',
        inspectedTerminal(
            `{\n    code: 503,\n    message: '${POOL_LITERAL}',\n    details: [}\n  }`
        )
    ],
    [
        'a body spliced back together across the stderr elision',
        inspectedTerminal(
            `{\n    code: 503,\n...\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'two answers to the same key, so neither is the printed one',
        inspectedTerminal(
            `{\n    code: 503,\n    message: 'Service Unavailable',\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'two answers to the same key under different inspect spellings',
        inspectedTerminal(
            `{\n    code: 503,\n    'code': 500,\n    message: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'the literal with an expression tacked onto it',
        inspectedTerminal(
            `{\n    code: 503,\n    message: '${POOL_LITERAL}' + '',\n    details: []\n  }`
        )
    ],
    [
        'a key that only starts like message',
        inspectedTerminal(
            `{\n    code: 503,\n    messages: '${POOL_LITERAL}',\n    details: []\n  }`
        )
    ],
    [
        'a cause given as an array of causes',
        inspectedTerminal(
            `[ { code: 503, message: '${POOL_LITERAL}', details: [] } ]`
        )
    ],
    [
        'model prose quoting the incident',
        'I checked the logs and the gateway said 503 No available Gemini accounts: ' +
            'no available accounts, so the cause is code 503 and the message is ' +
            'that no accounts are available.'
    ],
    [
        'model prose reproducing the block without a cause key',
        "Here is what the runner printed:\n{\n  code: 503,\n  message: 'No available Gemini accounts: no available accounts'\n}"
    ],
    [
        'a user pasting the block into the chat as JSON',
        'why does my agent say {"code": 503, "message": "No available Gemini accounts: no available accounts"}?'
    ]
]

// What a managed codex turn ends in when the pool is empty, as production
// printed it with codex-cli 0.148.0: five retry lines, the refusal, then the
// turn.failed that carries it as the verdict. Only the opaque values are
// fixtures here (thread id, url host, cf-ray, request id); every other byte is
// the printer's. codex unwraps the gateway's JSON envelope into the message
// before printing, so no line holds an envelope, and stderr stays empty.
// Reproduce by pointing `codex exec --skip-git-repo-check --json -` at a local
// /responses that answers 503 with
// `{"error":{"message":"Service temporarily unavailable","type":"api_error"}}`
// and `cf-ray` / `x-request-id` headers.
const CODEX_SUFFIX =
    ', url: https://gateway.example.test/responses, cf-ray: cf-ray-fixture-AMS, request id: request-id-fixture'

export const CODEX_POOL_EMPTY_TERMINAL = `unexpected status 503 Service Unavailable: Service temporarily unavailable${CODEX_SUFFIX}`

export const CODEX_EXEC_JSON_POOL_EMPTY = [
    { type: 'thread.started', thread_id: 'thread-id-fixture' },
    { type: 'turn.started' },
    ...Array.from({ length: 5 }, (_, i) => ({
        type: 'error',
        message: `Reconnecting... ${i + 1}/5 (${CODEX_POOL_EMPTY_TERMINAL})`
    })),
    { type: 'error', message: CODEX_POOL_EMPTY_TERMINAL },
    { type: 'turn.failed', error: { message: CODEX_POOL_EMPTY_TERMINAL } }
]
    .map((event) => `${JSON.stringify(event)}\n`)
    .join('')

// The same refusal in the printer's other two shapes: the gateway's other
// wording for an empty pool, and a gateway with no cf-ray or request id to
// report. Both captured the same way.
export const CODEX_POOL_EMPTY_VARIANTS: readonly (readonly [string, string])[] =
    [
        [
            'the gateway wording the other routes use',
            `unexpected status 503 Service Unavailable: No available accounts${CODEX_SUFFIX}`
        ],
        [
            'no cf-ray or request id',
            'unexpected status 503 Service Unavailable: Service temporarily unavailable, url: https://gateway.example.test/responses'
        ]
    ]

// Terminals that sit next to the real one and must not read as it. The first
// three are the printer's own output for the gateway's neighbouring refusals
// (captured as above): its concurrency wait, an upstream 5xx behind it, and a
// generic 503. The rest are built around the real terminal.
export const CODEX_POOL_EMPTY_LOOKALIKES: readonly (readonly [
    string,
    string
])[] = [
    [
        'the concurrency wait, which extends the literal',
        `unexpected status 503 Service Unavailable: Service temporarily unavailable, please retry later${CODEX_SUFFIX}`
    ],
    [
        'an upstream 5xx behind the gateway',
        `unexpected status 502 Bad Gateway: Upstream service temporarily unavailable${CODEX_SUFFIX}`
    ],
    [
        'a generic 503',
        `unexpected status 503 Service Unavailable: Service Unavailable${CODEX_SUFFIX}`
    ],
    [
        'the literal under a status that is not 503',
        `unexpected status 500 Internal Server Error: Service temporarily unavailable${CODEX_SUFFIX}`
    ],
    [
        'the proxy-page capitalisation',
        `unexpected status 503 Service Unavailable: Service Temporarily Unavailable${CODEX_SUFFIX}`
    ],
    [
        'the literal with more prose after it',
        `unexpected status 503 Service Unavailable: Service temporarily unavailable. Try again later${CODEX_SUFFIX}`
    ],
    [
        'a retry line, which is a diagnostic and not the verdict',
        `Reconnecting... 1/5 (${CODEX_POOL_EMPTY_TERMINAL})`
    ],
    [
        'model prose quoting the terminal',
        `The gateway said ${CODEX_POOL_EMPTY_TERMINAL}`
    ]
]
