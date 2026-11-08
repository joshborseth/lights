# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: true

## Finishing a task

When a task changes files in this repo, finish it by following the [`merge-and-deploy`](./.agents/skills/merge-and-deploy/SKILL.md) skill. It opens the PR, merges it, and deploys. Do this without being asked, unless Josh said not to push, open a PR, merge, or deploy.

Add new skills under `.agents/skills/<name>/`, and link each one from `.claude/skills/<name>` so every agent finds it.

## Project Notes

Read [`docs/migration-plan.md`](./docs/migration-plan.md) for the architecture and milestones. Its "Rules for commands to the bulbs" section is binding for any code that sends light commands.

Do not send commands to the real lights during development unless Josh has asked for that run. Test against recorded frames.

`repos/foldkit` landed through a squash merge, so `git subtree pull` cannot find it. To upgrade it, remove the folder, commit, and run `git subtree add` again at the new release tag.

UI components come from foldcn and live in `src/components/ui/`, with `src/lib/icons.ts` and `src/lib/utils.ts`. They are copied source: Oxlint and Oxfmt skip them, and `tsc` checks them. Before adding one, read the guidance below.

- `npx shadcn@latest add @foldcn/foldcn` downgrades `foldkit`, `@foldkit/ui`, `effect`, and `@effect/platform-browser`. Do not rerun it without restoring those versions afterward.
- `button`, `input`, `slider`, and `switch` carry small local changes for `exactOptionalPropertyTypes`, and `slider` fills to the thumb's far edge. `--overwrite` removes those changes.
- Theme colors are the `.dark` tokens in `src/styles.css`. The app is dark only.
