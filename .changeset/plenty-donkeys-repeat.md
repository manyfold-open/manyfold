---
'@manyfold/web': patch
---

Label system and in-flight rows in a channel's Recent deliveries table

A delivery whose direction is `system` — the row recorded when a provider sends an event the channel does not handle — had no label in any language, so the table printed the translation key itself. The long dotted string overflowed the narrow Direction column and overlapped the cell beside it. The four in-flight and dead-letter statuses (`pending`, `queued`, `processing`, `dead`) were unlabelled the same way. All eleven catalogs now carry them, and the Direction cell wraps so an unlabelled value can no longer overlap its neighbour.
