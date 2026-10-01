---
'@manyfold/api': minor
'@manyfold/admin': minor
---

An A2A turn that runs past the blocking limit keeps running instead of being stopped. A blocking `message/send` (or a `message/stream`) that reached the blocking cap, 10 minutes by default, used to cancel the agent's turn and fail the task with `turn_timeout`, however close the work was to done and even when the caller had already hung up and was polling. Now the caller gets the task back as `working` (a stream ends on a non-final `working` status update), and the same turn carries on under the async cap, 2 hours by default, which is what bounds a task now whichever way it was sent. Follow it with `tasks/get`, or reattach with `tasks/resubscribe`.

An agent backed by a remote A2A server follows such a task to its end with `tasks/get` instead of taking the stream's early end as the answer, and forwards a cancel made while it follows.

The admin A2A turn timeouts page describes the two caps this way.
