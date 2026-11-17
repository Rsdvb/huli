# Huli: a personal build of Kettu

Huli is Kettu (AGPL-3.0, https://github.com/KettuAI/Kettu) built for one person's own use, with
Kettu's cloud services cut off and its own name, so it installs beside an official Kettu without
sharing data with it.

## What differs from upstream

Code (kept small so upstream merges stay clean):

| File                                                                                                                                     | Change                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agent-host/agents.ts`                                                                                                               | `READ_ANTIGRAVITY_LIMITS = false`: never runs `agy -p /usage`, `/credits` or a hidden ACP session by itself to read Antigravity's limits; only a refresh the user presses (`agents.refreshLimits` with `ask: true`) runs `/usage` and `/credits` once                                |
| `src/shared/settings.ts`                                                                                                                 | defaults: cloud off, relay off, not discoverable                                                                                                                                                                                                                                     |
| `src/main/update-keys.json`, `src/main/update-sources.ts`, `src/shared/updates.ts`, `src/daemon/update.ts`                               | updates come from Huli's own channel on Huli Cloud's host, signed with Huli's own release keys (kept off the repository)                                                                                                                                                             |
| `src/shared/account-api.ts`, `src/shared/remote/push.ts`                                                                                 | the account service and push gateway are Huli Cloud, `https://huli.132-145-200-0.sslip.io` (see `cloud/`)                                                                                                                                                                            |
| `src/shared/kettu-hosts.ts`                                                                                                              | Huli Cloud's host counts as one of the services the cloud switch governs                                                                                                                                                                                                             |
| `src/shared/remote/{relay,pairing}.ts`                                                                                                   | every other kettu.sh address points at `*.huli.invalid`, which never resolves                                                                                                                                                                                                        |
| `src/shared/storage.ts`, `src/agent-host/worktrees/git.ts`                                                                               | home folder `~/.huli` instead of `~/.kettu`                                                                                                                                                                                                                                          |
| `src/main/user-data.ts`                                                                                                                  | development data folder `Huli Dev`                                                                                                                                                                                                                                                   |
| `src/main/index.ts`, `src/main/computer-use.ts`                                                                                          | app user model id `local.huli.app`                                                                                                                                                                                                                                                   |
| `package.json`                                                                                                                           | productName `Huli` (data folder `%APPDATA%\Huli`), version 0.1.0                                                                                                                                                                                                                     |
| `electron-builder.yml`                                                                                                                   | appId `local.huli.app`, productName `Huli`, `publish` is Huli's update channel (generic)                                                                                                                                                                                             |
| `src/renderer/src/stores/marketplace.ts`, `features/marketplace/{directory,model}.ts(x)`, `src/agent-host/marketplace/claude-plugins.ts` | the Marketplace never reads Kettu's community marketplace (kettu.sh) and has no Published tab; its Community section lists Anthropic's community plugin marketplace (`anthropics/claude-plugins-community`, added once to each Claude Code agent) and the community skills on GitHub |
| `src/main/browser/{policy,views}.ts`, `src/shared/browser.ts`, `browser-pane.tsx`, `locales/*/browser.json`                              | the side panel's browser saves a download through the system's save dialog, where the user picks, instead of dropping it; the pane then says whether it saved                                                                                                                        |
| `features/settings/about-section.tsx`, `locales/*/settings.json` (`about.version.basedOn`)                                               | About says Huli is a personal build based on Kettu under the AGPL-3.0; the rebrand keeps that phrase naming Kettu                                                                                                                                                                    |
| `eslint.config.mjs`, `.prettierignore`                                                                                                   | lint and formatting reach the phone app in `mobile/` (see Workflows)                                                                                                                                                                                                                 |

### Import from Kettu

Brings an official Kettu's sessions on the same computer over: Settings › General › Import from
Kettu, and a one-time offer over the sidebar's account row while there is no session yet.

Huli's own files:

- `src/agent-host/kettu-import.ts` (+ `.test.ts`): finds Kettu's data folder (`%APPDATA%\Kettu`,
  `~/Library/Application Support/Kettu`, `$XDG_CONFIG_HOME` or `~/.config/Kettu`;
  `HULI_KETTU_DATA` points elsewhere), copies `state/sessions.json` and `state/projects.json` into a
  temporary folder and reads the copies with the index's own parsers. It never writes there, and
  reads nothing when that folder is Huli's own (a build named Kettu). Each chosen session is
  imported through `importSession`, as the sidebar's Import sessions does, so Huli resumes the
  agent's own session; one another program has open (Kettu itself) comes over as a fork. Subagent
  sessions are not imported: the parent's history brings them back under it when it is opened.
  Sessions in a Kettu worktree or Kettu's scratch folder, for an agent Huli lacks, or in a folder
  that is gone are skipped. `state/kettu-import.json` remembers which Kettu session became which.
- `src/shared/kettu-import.ts`: the scan's and the run's types.
- `src/renderer/src/features/kettu-import/`: the store, the dialog, the Settings row
  (`settings-row.tsx`) and the sidebar offer.
- `src/shared/locales/*/kettuImport.json`: its copy, which the rebrand leaves whole (`KEEP_FILES`).

Hooks into upstream files, one or two lines each:

- `src/agent-host/sessions.ts`: `importSession` takes an optional `kept` (title, times, pin,
  archive) and the `KeptField` type.
- `src/shared/agent-host.ts` (`kettuImport.scan`, `kettuImport.run`, the `kettuImport.progress`
  event), `src/shared/host-request-limits.ts`, `src/agent-host/validate.ts`, `src/agent-host/host.ts`.
- `src/shared/i18next.d.ts` (the namespace), `src/renderer/src/app/bootstrap.ts` (the progress
  event), `features/settings/section-defs.tsx` (the row), `features/sidebar/app-sidebar.tsx` (the
  offer).

Generated before a build (not hand edits, never committed):

- `node tools/huli/rebrand.mjs` swaps the display name Kettu to Huli. Idempotent; the build
  workflow runs it, and so must a local build (see Build) or a `pnpm dev` meant to look like Huli.
  - Every locale but `star.json` (the prompts to star Kettu's repository) and `kettuImport.json`
    (the import from an official Kettu) has its values rewritten:
    the word Kettu, except in `KettuAI/Kettu` and in the phrases `KEEP` lists (the attribution and
    Star Kettu); Kettu's service copy (`COPY`), `kettu.sh` and the home folder `.kettu/`; and
    pairing-link placeholders (`LINKS`), which are swapped even though they are URLs.
  - `CODE` lists the exact display strings swapped in code: window titles, About, the update cards,
    the account menu's version line, the built-in theme's name, the Marketplace's own server, the
    first run's pictures, the Linux login item and the sign-in pages. When upstream changes one of
    those spellings the script warns `no longer holds …`; add the new spelling there.
  - It never touches tests: they read the constants the code uses (below).
- `tools/huli/icon/fox.svg` is the icon; `tools/huli/icon/render.mjs` renders the desktop app's
  `build/icon.png` and `build/icon.ico` and the phone app's `mobile/assets` from it.

## Tests

`pnpm test` passes on Linux, as CI runs it, and on Windows. Tests of what Huli changes read the
same constants as the code, so they pass on Huli and on upstream alike and survive a sync:
`DEFAULT_SETTINGS.cloud` (settings), `GITHUB_SOURCE` and the shared release keys (update-sources),
`PAIRING_URL` and `HOSTED_WEB_URL` (pairing), `PUSH_URL` (push), `RELAY_URL` (relay-regions) and
`KETTU_HOME_FOLDER` (worktrees). When a sync brings a test that spells out a kettu.sh address or
`.kettu`, make it read the constant rather than teach the rebrand to rewrite tests.

On Windows, links to folders in tests are junctions (`src/agent-host/testing/links.ts`), which
need no right; tests that need a link to a file are skipped unless Windows lets the user make one
(an administrator or Developer Mode).

## Fixes carried here

Not Huli's own changes but fixes upstream does not have yet; keep them through merges, and drop
one once upstream fixes the same thing:

- `src/agent-host/git/{exec,executable}.ts`: git is looked for in Git for Windows' folders and in
  Homebrew's and the system's bin folders when it is not on `PATH`.
- `src/agent-host/files.ts`: on Windows a copy makes junctions again instead of following them.
- `src/agent-host/marketplace/mcpb.ts`: an MCP bundle's paths in Windows' separators.
- `src/agent-host/settings-file.ts`: an unreadable agent settings file is reported translated, with
  its line; a byte order mark is accepted.
- `src/renderer/src/app/crash-screen.tsx`: a render error shows a recoverable screen.
- `features/files/change-badge.tsx` (U for untracked), `features/routines/routines.css` (the
  state column's width).
- Tests made to pass on Windows: native paths, junctions, hosts and databases closed before their
  folders are removed, and more time for git and for writing many files (`vitest.config.mts` raises
  the defaults on Windows only).

## Kept from Kettu

The Marketplace's MCP Registry, GitHub skills and Claude and Codex plugins need no Kettu account and
keep working. Its Community tab and publishing to kettu.page need Kettu's services and stay off.
Remote access uses direct connections over the network or Tailscale.

## Workflows

Only the `huli-*` workflows run here. Kettu's own (`ci.yml`, `docker.yml`, `issue-closed.yml`,
`release.yml`) stay in the tree unchanged, so syncs merge cleanly, but disabled: `huli-sync.yml`
disables every other workflow after each merge, new ones included.

- `huli-checks.yml`, on every push to main and every pull request that changes more than Markdown
  and the licenses (or by hand): on Linux, `pnpm typecheck`, Huli Cloud's types, `pnpm test`,
  `pnpm lint` and `pnpm format:check`; beside it, the phone app's `npm ci` and `tsc --noEmit`. A
  newer push to the same branch cancels the run before it. It stands in for Kettu's `ci.yml`,
  which only runs on pull requests.
- `huli-sync.yml`, every night at 03:23 Beijing time: merges Kettu's main, checks it, pushes and
  starts `huli-build.yml`; a conflict or failed check opens an issue instead.
- `huli-build.yml`, by hand, from a sync that merged, and every night at 03:41 Beijing time. The
  night's run first compares main with the commit of the latest release and builds only when they
  differ, and not while a sync is running (the sync starts its own build) nor for a commit whose
  build failed already (run it by hand to retry); otherwise every job is skipped. Versions stay
  `0.<UTC date>.<run number>`, and skipped runs use up run numbers, so they only grow.

Lint covers `mobile/` too, through the root ESLint config: the phone app gets the React hooks
rules as the renderer does, may `require()` images as Metro needs, and drops props by leaving them
out of a rest spread. `mobile/src/artifact-view/page-runtime.generated.ts` is generated, so
Prettier skips it.

## Build

```powershell
npx -y pnpm@10.11.1 install --frozen-lockfile
node tools/huli/rebrand.mjs
npx -y pnpm@10.11.1 fetch:cua-driver
npx -y pnpm@10.11.1 fetch:device-helpers
npx -y pnpm@10.11.1 dist:win      # dist\Huli-<version>-x64-setup.exe
```

The rebrand leaves its output in the working tree; never commit it.
