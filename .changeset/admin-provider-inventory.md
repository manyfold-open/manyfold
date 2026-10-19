---
'@manyfold/admin': minor
---

Admin › Runtime providers has a new Inventory tab for a sprites.dev provider. It lists every machine in the account, including ones no sandbox here uses, and marks each one Tracked or Untracked. A tracked machine shows its sandbox, owner and agent count. The tab also shows how many machines are running, suspended or stopped against the account's limits, says when the provider listed only part of the account, and can be filtered and searched. Each machine has its own page with its version, URL access and timestamps, and the recent admin actions taken on it. From that page an admin can restart, upgrade or delete the machine, after typing its name to confirm. The upgrade shows its progress and can roll back to a given version or allow a storage migration. Deleting a machine that backs a sandbox deletes the sandbox. In Sandboxes, each sprite name now links to its machine page.
