# Governance

## Editions and the single source of truth

Manyfold ships in two compositions from one core:

- **Open-source edition** — this repository. Complete and self-hostable:
  API, web workbench, admin console, CLI, docs, runtime integrations.
- **Cloud edition** — [manyfold.ai](https://manyfold.ai). A private
  superproject that includes this repository as a git submodule and composes
  closed commercial modules (billing, managed model supply, growth tooling)
  through the seams visible in this tree: NestJS DI ports, same-path overlay
  slots, and extension registries.

**This repository is canonical for the core.** All core changes — from the
community and from the Manyfold team alike — land here as public PRs. The
superproject only moves its submodule pointer; it does not patch the core.

The single sanctioned exception is a security embargo: the cloud edition may
temporarily carry a fix before public disclosure, as a revertable standalone
commit with a tracking issue, upstreamed here within 7 days (see
[SECURITY.md](./SECURITY.md)).

## Contract discipline

1. **One shape.** A port interface is the only contract; the open-source
   default implementation and any downstream adapter implement the same
   interface, enforced by the type checker.
2. **No conditional editions.** Core code never branches on an edition flag
   and never dynamically imports commercial modules. The `edition` string in
   health/telemetry output is diagnostic only — never an authorization,
   billing, or security input.
3. **Capabilities are visibility, not entitlement.** The capabilities
   endpoint reports which features exist so UIs can hide what is absent;
   every server-side check stays in place regardless (absent modules are
   absent routes).
4. **Breaking changes are named.** Port interfaces, composition-root seams,
   the capabilities contract, and `@manyfold/*` package exports are
   downstream contracts; PRs that change them say so.
5. **Hermetic tests.** This repository's tests run against its own
   composition with zero external secrets. Downstream adapter tests live
   downstream.

## Data ownership

Core tables are declared in this repository's ownership list and only
migrated from here. Downstream editions own their tables in their own
migration journals, may reference core rows (FKs pointing at core), and are
forbidden from being referenced by core. CI checks migration SQL against the
ownership list on every PR.

## Releases

The core versions its product surfaces with Changesets. Hotfixes follow the
same one-way flow: fix lands here first, downstream editions pick it up by
bumping their submodule pointer. Nothing ships from a fork of the core.

## Decision making

Maintainers are NetMind AI engineers today; substantial design changes are
proposed as issues or RFC-style PRs before implementation. The
feature-placement question in [CONTRIBUTING.md](./CONTRIBUTING.md) — "useful
to everyone self-hosting, with no proprietary dependency?" — is the
placement test applied to every feature.
