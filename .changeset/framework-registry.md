---
'@manyfold/api': minor
'@manyfold/web': minor
---

Framework facts — runtimes, chat capabilities, version sources, reserved env prefixes — now come from one framework registry that an edition can extend with frameworks of its own. An agent whose framework this build does not provide now gets `409 framework_unavailable` instead of an internal error, and the web shows it under its raw framework id instead of failing to render it.
