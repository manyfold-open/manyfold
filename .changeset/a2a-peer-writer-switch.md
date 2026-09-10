---
'@manyfold/api': major
---

Internal A2A grants now write only the policy table. Remove the fake credential
hash generator, mirror mutations and caller-bound database bearer path. New
grants use their own IDs; existing public IDs continue to work. External A2A
credentials retain their target-bound storage and behavior.

Deploy the prior authority preparation release to every API instance first.
This migration removes its ID alignment trigger. Mirror data and the remaining
revocation bridge are cleaned up only after every instance uses this writer.
