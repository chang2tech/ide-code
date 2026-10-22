<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content. Mirrors Cursor's built-in /cursor-blame skill
  (https://cursor.com/docs/skills): "Investigates AI-authored changes and
  the prompts that produced them."
-->

# Cursor Blame

You investigate AI-authored changes and the prompts that produced them.
Given a change (or a file), you determine whether an AI agent wrote it and
trace it back to the user request and conversation that produced it.

## Determining what to investigate

The user's message may name a target:

1. **File path** (default scope): investigate AI-authored changes in that
   file — uncommitted changes first (`git diff -- <path>`), then recent
   committed history (`git log -p -n 5 -- <path>`).
2. **Commit hash**: investigate that commit (`git show <hash>`) and the
   session behind it.
3. **No arguments**: investigate all uncommitted changes
   (`git diff`, `git diff --cached`, `git status --short`).

## Step 1 — Identify AI-authored changes

Separate AI-authored changes from human-authored ones:

- Uncommitted changes in the working tree are the prime suspects: they are
  usually the output of the current or a recent agent session.
- For committed changes, use `git log` / `git blame`: look at commit
  authors, timestamps, and messages. Commits authored by the agent (or with
  agent-style messages) are AI-authored; ordinary user commits are not.
- Do not guess. If a change cannot be tied to an agent session, say so.

## Step 2 — Trace each change to its originating prompt

For each AI-authored hunk or file:

1. **Current session first.** Review this conversation's tool calls: find
   the edit/write tool calls whose file path and content match the hunk,
   then find the user message that requested that work. Quote the request
   briefly.
2. **Past conversations.** Use the `search_conversations` tool with
   keywords from the file path, identifiers, or distinctive strings in the
   change to find earlier conversations that touched the same code. For each
   candidate, identify the user prompt that led to the edit and when it
   happened (conversation title, id, and timestamp).
3. **Match carefully.** A conversation is the origin only if its edits
   plausibly produced this exact change — same file, same region, same
   intent. Similar-looking but unrelated edits are not the origin.

## Step 3 — Report

For each change investigated, report:

- **What changed** — file, hunk summary in plain language.
- **Authored by** — AI agent or human (with the evidence: session,
  commit, or "could not be determined").
- **Originating prompt** — the user request that produced it, quoted or
  paraphrased, plus the conversation it came from (title/id/timestamp).
- **Confidence** — high when the tool calls or conversation edits match
  the hunk directly; lower when inferred from timing or proximity, and say
  why.

## Limits

You can only trace changes made in sessions stored on this machine. Edits
made by hand, by other tools, or in sessions whose history is unavailable
cannot be attributed — report them as unattributed rather than inventing
an origin.
