---
'@manyfold/web': minor
---

New agent: Dify, Langflow and A2A agents can be created from the four-step flow again, and the model-cost step only asks where the answer is used.

- Dify and A2A no longer ask for an app ID; only Langflow asks which flow to call.
- The model-cost step is skipped where there is nothing to choose: a connected service bills on its own side, a framework that picks its models in its own dashboard takes none at create, and an OpenClaw or Hermes agent joining an instance that already runs uses that instance's model. The summary says which.
- On a machine that already runs agents, step ③ marks what the machine pays with today and keeps it when picked. Picking a different account-level option now says beside Next that the agents on that machine billed to the account switch too, because they share one credential.
- Changing the agent type no longer leaves later steps reachable from the step bar, so Create can no longer be pressed over an empty summary. A model-cost pick made for one type or machine no longer shows as chosen on another.
- Enter moves the flow on only from a text field or from the row already picked. On Back, Change and the step bar it does what those controls do, so Enter on a Change link in the last step no longer creates the agent.
- The note telling users of OpenClaw, Hermes and other service frameworks to go back and pick another type is gone.
- "Where it runs" states what each machine costs in waiting, read from whether it is awake: a sleeping sandbox says it wakes first instead of "instant". It no longer predicts a sign-in, which depends on how the agent is paid for and is settled on the model-cost step. The create button on the last step states the same wait.
- An install's time follows its framework, so an edition can state a slower one, and a create that installs no longer promises that a failure leaves nothing behind.
- Rows that cannot be picked say why: a full sandbox quota shows how many exist against the limit and links to where sandboxes are deleted; a framework that cannot run on your own computer says so; an offline computer says to run `mf daemon start`; a cloud computer not enabled for the account says that, not "Needs a plan". The new-sandbox row stays disabled until the quota is known.
- "Connect my computer" opens its dialog from a button that says so, not "Go to settings".
- On the model-cost step, Manyfold managed says when there is no balance left, because such an agent cannot reply until a top-up, and says when the balance could not be read. For OpenClaw and Hermes it names the model the install will use. Accounts read from a sleeping machine say they had expired when last checked. Counts of one agent read "1 agent".
- The workspace field says a typed path must already exist on that machine, and is not offered for a service framework's first agent on a machine, which the API refuses one for.
- An API key can be added from the model-cost step with the settings page's own forms. It is tested and picked without leaving the flow. An edition can also offer its own dialog for adding credit there when the managed balance is empty.
- The flow's step, type and machine (or connected service) are kept in the address bar. The browser's Back and Forward walk the steps, a reload returns to the step it was on, and `?framework=` and `?hostId=` links open the flow with that type or machine chosen. "+ Create agent" beside a connected computer preselects it again.
- The step bar shows a value only for a step that is answered along with every step before it. A name the flow suggested is dropped when the type or machine changes and a fresh one is suggested on the way back to the last step; a name the user typed is kept.
