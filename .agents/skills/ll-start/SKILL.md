---
name: ll-start
description: "Orient a LancerLogin task, triage current inbox ideas into proposed work, and present the safest viable next decision. Use at the start of or when resuming a development session; do not execute work on its own."
---

# LancerLogin Session Start

Use this skill as the front door for a new or resumed LancerLogin task. Its outcome is a current, decision-ready view of the project so the user does not need to remember work-unit IDs, prior tasks, or the next command.

Read `AGENTS.md`, `docs/WORKFLOW.md`, `docs/idea_inbox.md`, and `docs/future_work.md`. Read only additional project documentation needed to understand an item being proposed.

## Build the current-state view

1. Read the durable inbox. For every `Status: untriaged` entry, follow the **Triage** procedure in `$ll-inbox-process`: identify duplicates, existing coverage, and appropriately scoped candidate work units. This is a proposal only; do not edit either ledger during this step.
2. Read the work-unit ledger and identify:
   - `in progress` units with a branch or explicitly recorded detached candidate that may be ready for integration;
   - `ready` units suitable for a next implementation batch; and
   - merged units that may be unreleased.
3. For an integration candidate, use the read-only assessment criteria from `$ll-integrate all`. For ready units, use the read-only assessment criteria from `$ll-coordinator assess all` when a compatibility judgment is needed. Do not launch tasks, merge, or edit the ledger while making this view.

Summarize only actionable items. For each proposed inbox candidate or ready WU, show its ID or candidate label, a one-line outcome, dependencies or overlap, focused verification, and likely release bundle. For integration candidates, show the WU ID, candidate evidence, and next verification. State clearly when a category has no actionable items.

## Present one next decision

Choose the highest-value safe next action and ask the user one structured Plan-mode decision when available. Give a recommended option and its consequence; do not imitate clickable controls in Markdown. Do not require the user to remember or retype WU IDs unless they choose a custom option.

Use this priority order:

1. Review existing integration candidates before launching overlapping new implementation work.
2. Triage untriaged ideas before treating them as official work units.
3. Assess a compatible batch from ready work units.
4. Preview an unreleased bundle after the work-unit state is otherwise clear.

Offer the decision that fits the current state. Typical options are:

- **Review integration candidates (recommended):** run the read-only `$ll-integrate all` assessment; the user may later approve its immediately preceding proposal with `$ll-integrate suggested`.
- **Triage inbox:** present the inbox-promotion proposal and wait for approval before recording work units, following `$ll-inbox-process`.
- **Assess ready work:** run the read-only `$ll-coordinator assess all` assessment; the user may later approve its first proposed batch with `$ll-coordinator launch suggested`.
- **Preview release:** run the read-only `$ll-release preview-unreleased` procedure.

After the user chooses, perform only that selected existing-skill procedure in this same task. Keep its original approval boundaries: do not promote inbox candidates, launch a WU, merge, create a release, deploy, mutate cloud resources, or update the Pi without the explicit authorization required by that procedure.

If nothing is actionable, say so and offer the smallest useful next action, normally `$ll-wu-create <idea>` or a new inbox entry. Do not inspect old task history to manufacture missing work.
