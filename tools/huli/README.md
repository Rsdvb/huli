# Huli: a personal build of Kettu

Huli is Kettu (AGPL-3.0, https://github.com/KettuAI/Kettu) built for one person's own use, with
Kettu's cloud services cut off and its own name, so it installs beside an official Kettu without
sharing data with it.

## What differs from upstream

Code (kept small so upstream merges stay clean):

| File | Change |
|---|---|
| `src/agent-host/agents.ts` | `READ_ANTIGRAVITY_LIMITS = false`: never runs `agy -p /usage`, `/credits` or a hidden ACP session to read Antigravity's limits |
| `src/shared/settings.ts` | defaults: cloud off, relay off, not discoverable |
| `src/main/update-keys.json`, `src/main/update-sources.ts`, `src/shared/updates.ts`, `src/daemon/update.ts` | updates come from Huli's own channel on Huli Cloud's host, signed with Huli's own release keys (kept off the repository) |
| `src/shared/account-api.ts`, `src/shared/remote/push.ts` | the account service and push gateway are Huli Cloud, `https://huli.132-145-200-0.sslip.io` (see `cloud/`) |
| `src/shared/kettu-hosts.ts` | Huli Cloud's host counts as one of the services the cloud switch governs |
| `src/shared/remote/{relay,pairing}.ts` | every other kettu.sh address points at `*.huli.invalid`, which never resolves |
| `src/shared/storage.ts`, `src/agent-host/worktrees/git.ts` | home folder `~/.huli` instead of `~/.kettu` |
| `src/main/user-data.ts` | development data folder `Huli Dev` |
| `src/main/index.ts`, `src/main/computer-use.ts` | app user model id `local.huli.app` |
| `package.json` | productName `Huli` (data folder `%APPDATA%\Huli`), version 0.1.0 |
| `electron-builder.yml` | appId `local.huli.app`, productName `Huli`, `publish` is Huli's update channel (generic) |
| `src/renderer/src/stores/marketplace.ts`, `features/marketplace/{directory,model}.ts(x)`, `src/agent-host/marketplace/claude-plugins.ts` | the Marketplace never reads Kettu's community marketplace (kettu.sh) and has no Published tab; its Community section lists Anthropic's community plugin marketplace (`anthropics/claude-plugins-community`, added once to each Claude Code agent) and the community skills on GitHub |
| `src/main/browser/{policy,views}.ts`, `src/shared/browser.ts`, `browser-pane.tsx`, `locales/*/browser.json` | the side panel's browser saves a download through the system's save dialog, where the user picks, instead of dropping it; the pane then says whether it saved |

Generated before a build (not hand edits):

- `node tools/huli/rebrand.mjs` swaps the display name Kettu to Huli in the locales and a few
  display strings. Idempotent; run it after every upstream merge.
- `tools/huli/icon/fox.svg` is the icon; `tools/huli/icon/render.mjs` renders the desktop app's
  `build/icon.png` and `build/icon.ico` and the phone app's `mobile/assets` from it.

Tests that check upstream's own addresses and defaults (`settings`, `update-sources`, `push`,
`pairing`, `relay-regions`) fail by design in Huli; on Windows, tests that make symlinks fail too
without the right to make them.

## Kept from Kettu

The Marketplace's MCP Registry, GitHub skills and Claude and Codex plugins need no Kettu account and
keep working. Its Community tab and publishing to kettu.page need Kettu's services and stay off.
Remote access uses direct connections over the network or Tailscale.

## Build

```powershell
npx -y pnpm@10.11.1 install --frozen-lockfile
node tools/huli/rebrand.mjs
npx -y pnpm@10.11.1 fetch:cua-driver
npx -y pnpm@10.11.1 fetch:device-helpers
npx -y pnpm@10.11.1 dist:win      # dist\Huli-<version>-x64-setup.exe
```
