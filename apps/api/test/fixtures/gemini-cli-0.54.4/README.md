These are unmodified stream-json stdout records from published
`@google/gemini-cli@0.54.4`, captured by `test/live/fixtures/gemini-tool-wire.mjs`
in image `sha256:8ce6a516ebae47845efc74cd95f3aff506a8ad21465eadc0d1d67ef3c33579fc`.
The container has no external network; a loopback Google-compatible provider
requests only `printf gemini-wire-fresh` or `printf gemini-wire-resume`.

The second CLI invocation uses `--resume latest`. Both init events retain the
same session ID, and its provider request includes the first turn's function
call/response. The requested model is `gemini-2.5-flash`; this CLI resolves it
to `gemini-3.5-flash` on the provider wire. No user credentials are captured.
