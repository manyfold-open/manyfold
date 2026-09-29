---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/admin': minor
'@manyfold/cli': minor
---

The built-in model catalog of Claude Code, Codex and Gemini CLI is one file, `packages/shared/src/framework-model-catalog.yaml`, and every release applies it right after the migrations (`node dist/db/migrate.js`, the self-hosted `api-migrate` service included). A row the file lists is set to what the file says, so admin edits to those rows last until the next release; a row an admin added is left alone. `node dist/db/framework-catalog.js import [--file <catalog.yaml>] [--dry-run]` applies a catalog on demand, and `export` writes the database's catalog as YAML (`just catalog-import`, `just catalog-export`).

Codex agents can run GPT-6 Sol, with reasoning up to `ultra`, and GPT-6 Luna, up to `max`, both with the fast tier. A provider that serves GPT-6 Sol but not GPT-6 Astra defaults new agents to it. GPT-5.4, GPT-5.4 Mini and GPT-5.2 are retired, as they are in Codex itself: an agent set to one of them is asked to choose a supported model. The model the platform writes into a host's Codex config is GPT-5.6 Sol, which every channel serves and ChatGPT sign-in keeps (GPT-5.5 leaves Codex for ChatGPT sign-in on 2026-10-14); a host picks it up the next time its credentials are written. A Codex terminal that resumes a session on the platform provider runs the agent's model.

Claude Code runtime-local model lists offer Opus 5, Opus 5.5, Sonnet 5.5 and Fable 5.1. Opus 5.5 and Sonnet 5.5 fall back to medium effort, as Claude Code starts them, and an explicitly chosen Fable model is labelled Fable in the composer.
