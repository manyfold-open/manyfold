---
'@manyfold/api': minor
---

Log records exported over OTLP keep the attribute columns the receiver already has, and every other attribute (new names and nested values) goes into the `attributes.custom` map with its type intact. New telemetry fields no longer add receiver columns, so a receiver at its field limit stops rejecting whole log batches, ordinary and process-exit logs included. Query those attributes as `['attributes.custom']['<name>']`. The dataset must hold `attributes.custom` as a map field: Axiom creates it when the first span with a custom attribute arrives; on a new dataset, create it before enabling export.
