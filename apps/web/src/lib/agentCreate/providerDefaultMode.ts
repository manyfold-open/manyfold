// Editions slot (§3.3): the provider-picker mode the create form starts on
// for claude-code / codex / gemini-cli. Self-hosted starts on the in-runtime
// subscription sign-in — the user signs in with their own plan inside the
// sandbox/computer and Manyfold stores no key. The cloud overlay shadows
// this with 'saved' (protagolabs/manyfold#1112), which must merge there
// before the pin bump that carries this file: a missing counterpart fails
// soft, silently defaulting the cloud form to the self-hosted mode.
//
// Typed as `string` because the two editions hold different literals.
export const PROVIDER_PICKER_DEFAULT_MODE: string = 'runtime'
