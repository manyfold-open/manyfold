# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for suspected vulnerabilities. Use
GitHub's private vulnerability reporting on this repository ("Report a
vulnerability" under the Security tab). You will get an acknowledgement and
a private advisory thread to work in.

## What happens next (embargo policy)

1. The fix is developed in the advisory's private fork.
2. If the hosted cloud edition is exposed, it may temporarily carry the fix
   before public disclosure — as a revertable standalone commit with a
   tracking issue, upstreamed here within 7 days.
3. Disclosure order is deploy-then-disclose: fixed artifacts are produced
   and deployed (hosted edition patched, a fixed version available for
   self-hosters), the fix merges to public `main`, and **then** the advisory
   is published with affected versions and upgrade guidance.

## Supported versions

Security fixes target the latest release of each product surface. If you run
an older self-hosted version, upgrade to the newest release before reporting
behavior as a vulnerability — the advisory will name the affected range.

## Credentials

Never put real tokens, keys, or customer data in issues, PRs, or discussion
threads. This repository's CI runs with zero secrets by design.
