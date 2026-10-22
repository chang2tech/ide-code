---
name: automate
description: Use this skill to create IDE Automations.
environments:
  - local
---
# Create Automation (Interactive)

Use this skill when the user explicitly wants to make, build, set up, or create a new **IDE Automation** — for example "create an automation", "set up a scheduled agent", or "run this every morning".

**What automations are here.** Automations in this IDE run **locally**: a schedule
(cron) wakes an agent that carries out the automation's instructions in a workspace.
There is no cloud Agents Window and no hosted Automations editor in this version.

**Supported triggers:** `cron` (schedule) only. Slack messages, GitHub events, Linear,
PagerDuty, Sentry, email, webhooks, and other event sources are **not** supported by
local automations — say so plainly if the user asks for one, and offer the closest
scheduled alternative (e.g. "every 15 minutes, check the repo for new PR comments").

**Disambiguation.** "Automation" in a user workspace can mean many things (`.github/workflows`, CI pipelines, scheduled jobs, scripts, dbt, browser automation, shell scripts, workflow engines). Do **not** assume generic phrases like "automate this", "help me automate my deploys", or "make an automation" mean **IDE Automation**. Route to the named surface when the user mentions one, use normal repo/product exploration when the context points elsewhere, or ask a short clarifying question when the target surface is ambiguous. Start this spine only when the user explicitly asks for IDE Automations or confirms that IDE Automations is the intended surface.

## Execution spine (every run)

1. **Capture intent.** If the prompt is missing 2+ of {what kicks it off, what should happen, what outcome}, send one short plain-chat message asking for a 1–2 sentence description and wait. Skip when the prompt already names trigger + action + outcome.
2. **Completeness gates.** Work through the schedule, workspace, prompt, and naming checks below. Do not jump to a summary while required fields are still unknown.
3. **One consolidated question.** Ask inline for whatever is still unresolved — schedule details, workspace when ambiguous, model choice when not obvious.
4. **Draft table → approval → create.** Show a compact Markdown table (plain language, no YAML/JSON) recapping name / description, schedule, workspace, and instructions. User approves, then create the automation with the `automations` tool (action `create`) and confirm it is scheduled.

---

## House rules

- **Plain language only.** Never show trigger ids, cron internals, or raw JSON in user-visible chat. Say "every weekday at 9am", "the repo", "the instructions". Exception: the user explicitly asks to see internals.
- **No YAML/JSON in finalization.** The draft table = compact Markdown only in plain language. Build and validate the automation payload internally; surface it only when the user asks.
- **Creation-only.** This skill prepares new automations only. To list, inspect, update, or delete existing automations, use the `automations` tool directly — do not run this spine.
- **Workspace binding.** An automation runs in exactly one workspace (a local directory). It runs with the tools and MCP servers available to the agent in that workspace at run time. Do not promise integrations that are not configured there.

---

## Procedure

### Stage 1 — Capture intent (plain chat, no AskQuestion)

If the user's prompt is thin, send one short plain-chat message and **wait**:

> "Before we dive in, what do you want this automation to do? What kicks it off, what should happen, and what's the outcome? A sentence or two is plenty."

Skip when the prompt already covers trigger + action + outcome, or the user said something similar to "walk me through it". The answer is freeform — never wrap this question in `AskQuestion`.

### Stage 2 — Authoring funnel

Work in this order: schedule → workspace → instructions → name/description → draft table.

#### Schedule

Cron stores a single expression. If the user gives a schedule that maps cleanly to cron fields (for example "every weekday at 3am", "daily at 9am", or "Mondays at 9am"), use it. Treat "my timezone" or "local time" as the user's display-time intent when the hour/day pattern itself is expressible as cron. Do not put a schedule only in the instructions while leaving the trigger empty — a scheduled automation with no trigger is invalid.

Valid cron examples:

```
# Every hour
0 * * * *

# Every day at 9:00
0 9 * * *

# Every Monday at 9:00
0 9 * * 1

# Weekdays at 9:00
0 9 * * 1-5
```

If the user asks for an event trigger (Slack message, PR opened, new issue, webhook), explain that local automations only support schedules, and offer the closest scheduled equivalent. Do not invent trigger types.

#### Workspace

The automation runs in one workspace directory. Default to the current chat's workspace; ask only when ambiguous. The workspace must exist on this machine — automations do not run on remote machines or in the cloud.

#### Instructions

Ask "What should the agent do on each run?" Default one tight paragraph; match the user's length if they gave more. Instructions run headless: they must be self-contained (no follow-up questions at run time). Suggest a name + 1–2 sentence description from prior answers.

#### Fast-path

If confidence is high and required fields are present, you may skip straight to the draft table. Fast-path never bypasses an unresolved schedule or workspace.

### Stage 3 — Draft table, validation, create

Recap the draft as a compact Markdown table in plain language:

| Draft field | Value |
|-------------|-------|
| Name / description | Short plain-language value |
| Schedule | What starts the automation, in plain words |
| Workspace | The directory it runs in |
| Instructions | The agent behavior, summarized |

End with "Does this look correct?" After approval, run the internal **Validation check**, then create the automation with the `automations` tool and confirm: name, next scheduled run, and where to manage it (the automations list).

#### Validation check (agent-internal)

After draft table approval, validate: schedule is a valid 5-field cron expression; workspace is an existing local directory; instructions are non-empty and self-contained (no "ask the user" steps); name is unique or the user confirmed reuse. If validation fails, explain the issue in plain language and ask what to change; do not paste the raw payload unless the user explicitly asked.

---

## Managing automations

Use the `automations` tool directly (no spine needed):

- `list` — show scheduled automations and their next run times
- `get` — inspect one automation's schedule, workspace, and instructions
- `update` — change schedule, instructions, or enabled state
- `delete` — remove an automation
- `run-once` — trigger an immediate run outside the schedule (for testing)

A run opens a normal agent session in the automation's workspace with the automation's instructions as the prompt. Run history (started/finished/failed, output summary) is visible via `get`.

## Limitations (tell the user when relevant)

- Schedules only — no Slack, GitHub, Linear, PagerDuty, Sentry, email, or webhook triggers.
- Runs on this machine only. The machine must be on and the IDE engine running for schedules to fire; missed runs while asleep are skipped, not backfilled.
- No hosted editor: automations are created and managed from chat (or the automations list), not a visual editor.
- Secrets: the agent uses the same credentials configured in the workspace. Do not put secrets in the instructions text.
