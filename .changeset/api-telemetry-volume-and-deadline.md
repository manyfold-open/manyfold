---
'@manyfold/api': patch
---

Keep Sentry's default performance instrumentation from adding duplicate Axiom spans, and carry one three-second fatal exit deadline through turn handoff and telemetry delivery. Flush the exit record and captured error before pending span conversion while preserving the graceful signal budget.
