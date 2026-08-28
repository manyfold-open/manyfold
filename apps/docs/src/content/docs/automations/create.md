---
title: Create and manage automations
description: Create a repeatable Agent task from the Automations page, then update its schedule, model, Channel, or active state as your workflow changes.
order: 9
---
**Click Automations in the sidebar → New automation, enter a title, prompt, schedule, Agent, and model, then click Create.**

After creation, you can update the repeat schedule, model, and result-delivery Channel. You can also pause the task or use Run now to execute it once immediately.

## 1. Open the Automations page

In the Manyfold left sidebar, click **Automations**. When the page opens, click **New automation** in the upper-right corner.

## 2. Configure the Automation

Break the repeatable task into five fields:

- **Automation title:** name the task clearly, such as *Daily Research Brief*.
- **Prompt:** describe what the Agent should do, what it should return, and any required scope or format.
- **Schedule:** choose when the task should run and how often it should repeat.
- **Agent:** select the Agent that will execute the task. This guide uses demo as the example.
- **Model:** choose the model for this Automation, such as Gemini-3.6-flash-high.

![Manyfold New automation form with Daily Research Brief, a prompt, Daily at 9:00 AM, the demo Agent, and Gemini-3.6-flash-high](../../../assets/docs/automations/automation-03-new-automation-demo.webp)

*Set the title, prompt, schedule, Agent, and model in one place.*

A useful prompt should be specific enough to run without another clarification. For example:

```text
Summarize the top 3 AI agent stories from the last 24 hours.
Include source links and key takeaways.
Return the result as a short Markdown brief.
```

Review the fields, then click **Create**.

## 3. Manage and update settings after creation

Open a created Automation to see its status, next run, and previous runs. The Details panel lets you change:

- **Status:** check whether the task is Active.
- **Repeats:** change the execution time or repeat schedule.
- **Model:** switch the model used by this task.
- **Channel:** choose where results should be delivered; leave it Off when no team delivery is needed.

Use **Pause** to stop scheduled runs temporarily. Use **Run now** to execute it once without waiting for the next scheduled time.

![Manyfold Daily Research Brief Automation details showing Active status, Daily at 9:00 AM, the demo Agent, model, and Channel settings](../../../assets/docs/automations/automation-04-automation-details-demo.webp)

*The details page centralizes Status, Repeats, Model, Channel, Pause, and Run now.*

## 4. Manage multiple Automations

Once you have more than one task, use the Automations overview to see which ones are running and which ones are paused.

- **Current:** active Automations and their next run times.
- **Paused:** Automations that will not run on their saved schedule until resumed.
- **Task name and Agent:** quick context for what each Automation does.

![Manyfold Automations overview showing several demo Automations grouped under Current and Paused](../../../assets/docs/automations/automation-05-automation-list-demo.webp)

*Use Current and Paused groups to manage multiple Automations.*

Give each Automation a clear, searchable name and review its previous runs regularly so stale tasks do not keep running unnoticed.

## Frequently asked questions

- **How are Automations different from Agents?**

  The Agent performs the work. The Automation defines when it runs, which Agent and model it uses, and whether the result is delivered to a Channel.
- **Can I run it once without changing the schedule?**

  Yes. Click **Run now** on the details page to execute it once while keeping the saved repeat schedule.
- **When should I use a Channel?**

  Use a Channel when the result should go to a team tool such as Slack, Telegram, or Discord. Otherwise, leave Channel set to Off.

**Want the concept first?** Read [What are Manyfold Automations?](/docs/automations/). To deliver results to a team tool, see the [Slack Channel guide](/docs/channels/slack/).

## See also

- [Manyfold Automation documentation](/docs/cli/automations/)
- [mf CLI guide](/docs/cli/)
