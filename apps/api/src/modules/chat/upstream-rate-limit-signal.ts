// #803. Google answers a throttled or quota-exhausted generation with HTTP 429
// and the RESOURCE_EXHAUSTED RPC status, and the agent CLIs print that envelope
// through: in the `got status: 429 …` line the client raises, in the
// `{"error":{"code":429,…,"status":"RESOURCE_EXHAUSTED"}}` body they quote, and
// in the per-attempt status their own retry ladders log.
//
// Only those machine-emitted shapes are matched. The sentence inside the
// envelope ("Resource has been exhausted (e.g. check quota).", a per-metric
// quota name, whatever a gateway rewords it to) is vendor prose, and the cause
// this feeds is a Sentry grouping key: deriving one from text a vendor can
// reword under us is the mistake the closed taxonomy exists to prevent. For the
// same reason the status has to appear where a status is actually printed — the
// HTTP reason phrase, a labelled status or code, or immediately in front of the
// response body the adapters quote — so a bare number in prose cannot file an
// incident under this name.
//
// Case-insensitive: this is read from a raw adapter message as well as from the
// lowercased message the cause classifier matches its anchors against.
export const UPSTREAM_RATE_LIMIT_SIGNATURE =
    /\bresource_exhausted\b|\b429\s+too many requests\b|\b(?:http|status(?:\s*code)?|code)[^0-9a-z]{0,12}429\b|\b429\s*\{/i