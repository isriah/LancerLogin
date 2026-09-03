---
name: ll-start
description: "Orient a LancerLogin task, triage current ideas, and let the user immediately start the safest viable work. Use at the start of or when resuming a development session."
---

# LancerLogin Session Start

Use this skill as the front door for a new or resumed LancerLogin task. Its outcome is a current, decision-ready view of the project followed by the user-selected next execution phase, so the user does not need to remember work-unit IDs, prior tasks, or follow-up commands.

Read `AGENTS.md`, `docs/WORKFLOW.md`, `docs/idea_inbox.md`, and `docs/future_work.md`. Read only additional project documentation needed to understand an item being proposed.

## Build the current-state view

1. Read the durable inbox. For every `Status: untriaged` entry, follow the **Triage** procedure in `$ll-inbox-process`: identify duplicates, existing coverage, and appropriately scoped candidate work units. This is a proposal only; do not edit either ledger during this step.
2. Read the work-unit ledger and identify:
   - `in progress` units with a branch or explicitly recorded detached candidate that may be ready for integration;
   - `ready` units suitable for a next implementation batch; and
   - merged units that may be unreleased.
3. For an integration candidate, use the read-only assessment criteria from `$ll-integrate all`. For ready units, use the read-only assessment criteria from `$ll-coordinator assess all` when a compatibility judgment is needed. Do not launch tasks, merge, or edit the ledger while making this view.

Summarize only actionable items. For each proposed inbox candidate or ready WU, show its ID or candidate label, a one-line outcome, dependencies or overlap, focused verification, and likely release bundle. For integration candidates, show the WU ID, candidate evidence, and next verification. State clearly when a category has no actionable items.

## Present one next decision and execute it

Choose the highest-value safe next action and present a short numbered menu. Put the recommended option first, state its consequence, and number only the options that are viable in the current state. Explicitly say that the user may reply with the matching digit alone. A message containing exactly one displayed digit is the user's authorization to execute that option. Do not require WU IDs or command names.

Use this priority order:

1. Review existing integration candidates before launching overlapping new implementation work.
2. Triage untriaged ideas before treating them as official work units.
3. Assess a compatible batch from ready work units.
4. Preview an unreleased bundle after the work-unit state is otherwise clear.

Offer the decision that fits the current state. The action names must make clear that choosing one authorizes that phase now. Typical options are:

- **Integrate the proposed candidate batch (recommended when eligible):** treat the choice as authorization to revalidate and serially integrate the candidates using `$ll-integrate`'s batch procedure. Stop at the first conflict, missing evidence, or failed verification.
- **Promote the proposed inbox work and start the first safe batch:** treat the choice as approval of the named inbox candidates. Record them using `$ll-inbox-process`, assess all ready units, then launch only the first safe compatible batch using `$ll-coordinator`. If a material product or grouping decision remains unresolved, ask that decision instead of guessing.
- **Start the recommended ready batch:** re-assess the ready units and launch the first safe compatible batch immediately. Do not make the user repeat `assess all` or `launch suggested`.
- **Preview release:** run `$ll-release preview-unreleased`. If packaging needs a version or other material decision, ask it before creating a release.

For example, show `1. Start the recommended ready batch (recommended)` rather than asking the user to type a skill invocation. Use up to three choices when possible. A custom alternative can be included as the final numbered choice only when it is genuinely useful; if chosen, ask the minimum follow-up needed before acting.

After the user chooses, perform the selected procedure in this same task rather than only explaining the next command. The selected choice is the explicit authorization for its stated promotion, task-launch, or integration action. Re-read the ledger immediately before mutation and stop if its state has changed, a conflict is found, or required evidence is absent.

Do not create a release, deploy, mutate cloud resources, or update the Pi unless the user explicitly selects an option that clearly authorizes that separate action. A release preview alone does not authorize packaging or publication.

If nothing is actionable, say so and offer the smallest useful next action, normally `$ll-wu-create <idea>` or a new inbox entry. Do not inspect old task history to manufacture missing work.
