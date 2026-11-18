# Huli: a personal build of Kettu

Huli is Kettu (AGPL-3.0, https://github.com/KettuAI/Kettu) built for one person's own use, with
Kettu's cloud services cut off and its own name, so it installs beside an official Kettu without
sharing data with it. People see it as **Kite**, **纸鸢** in Chinese: the agent flies on the
computer, you hold the string on your phone. Huli stays its name inside (see Names).

## Names

Only what people see is named Kite. These stay Huli, so existing installs, pairings and syncs keep
working:

- Ids: the desktop appId and app user model id `local.huli.app`; the phone's bundle ids
  `io.github.rsdvb.huli*`, App Group `group.io.github.rsdvb.huli`, keychain groups, the `huli://`
  scheme, widget kinds and activity types.
- Data: `%APPDATA%\Huli` (and `~/Library/Application Support/Huli`, `~/.config/Huli`), which
  `PACKAGED_DATA_FOLDER` in `src/main/user-data.ts` pins now that the product name is Kite;
  `Huli Dev`; the home folder `~/.huli`.
- Services: the update channel and Kite Cloud's host (`huli.132-145-200-0.sslip.io`), the server's
  `huli-cloud` command and `HULI_*` settings, the pairing, relay and push constants, the repository
  `Rsdvb/huli` and the `huli-*` workflows.
- The phone app's `expo.name`, which names its Xcode project, scheme and `Huli.app` that
  `tools/huli/ios` builds; the name people see comes from `mobile/plugins/appName.js` and
  `mobile/locales/zh-Hans.json`.
- Code identifiers (`HuliIcon`, `HuliLive`, `Huli*.swift`, …) and comments.

Chinese copy says 纸鸢 wherever it names the product; English copy, window titles, the installer,
shortcuts, the macOS menu bar, the tray's tooltip and file names say Kite; About says 纸鸢 Kite in
Chinese. The account service is Kite Cloud in both.

## What differs from upstream

Code (kept small so upstream merges stay clean):

| File                                                                                                                                     | Change                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agent-host/agents.ts`                                                                                                               | `READ_ANTIGRAVITY_LIMITS = false`: never runs `agy -p /usage`, `/credits` or a hidden ACP session by itself to read Antigravity's limits; only a refresh the user presses (`agents.refreshLimits` with `ask: true`) runs `/usage` and `/credits` once                                |
| `src/shared/settings.ts`                                                                                                                 | defaults: cloud off, relay on (Huli Cloud's, used only with the cloud on and signed in), discoverable (the account's phones and browsers may ask to be added; the owner allows each)                                                                                                 |
| `src/remote-host/start.ts`, `src/shared/remote/relay.ts`                                                                                 | signed in to the relay, the host always sends its profile, so Huli Cloud registers it as the account's computer; `pairable: false` in it while it is not discoverable                                                                                                                |
| `src/main/update-keys.json`, `src/main/update-sources.ts`, `src/shared/updates.ts`, `src/daemon/update.ts`                               | updates come from Huli's own channel on Huli Cloud's host, signed with Huli's own release keys (kept off the repository)                                                                                                                                                             |
| `src/shared/account-api.ts`, `src/shared/remote/push.ts`                                                                                 | the account service and push gateway are Huli Cloud, `https://huli.132-145-200-0.sslip.io` (see `cloud/`)                                                                                                                                                                            |
| `src/shared/kettu-hosts.ts`                                                                                                              | Huli Cloud's host counts as one of the services the cloud switch governs                                                                                                                                                                                                             |
| `src/shared/remote/relay.ts`, `relay-regions.ts`                                                                                         | `RELAY_URL` is Huli Cloud too (its relay, one region, Ashburn); `REGION_KEYS` are Huli's own region list keys (`tools/huli/region-list.mjs`, private halves in `~/.huli-keys`)                                                                                                       |
| `src/shared/remote/pairing.ts`                                                                                                           | `HOSTED_WEB_URL` is Huli's web client, `https://app.huli.132-145-200-0.sslip.io`; `PAIRING_URL` points at `huli.invalid`, which never resolves                                                                                                                                       |
| `src/shared/storage.ts`, `src/agent-host/worktrees/git.ts`                                                                               | home folder `~/.huli` instead of `~/.kettu`                                                                                                                                                                                                                                          |
| `src/main/user-data.ts`                                                                                                                  | development data folder `Huli Dev`; an installed build's, `Huli` (`PACKAGED_DATA_FOLDER`), which `src/main/index.ts` pins                                                                                                                                                            |
| `src/main/index.ts`, `src/main/computer-use.ts`                                                                                          | app user model id `local.huli.app`                                                                                                                                                                                                                                                   |
| `package.json`                                                                                                                           | productName `Kite`, version 0.1.0                                                                                                                                                                                                                                                    |
| `electron-builder.yml`                                                                                                                   | appId `local.huli.app`, productName `Kite`, `publish` is Huli's update channel (generic)                                                                                                                                                                                             |
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

### Session folders

Folders the user makes to organize sessions, kept by the agent host so every window and paired
device shows the same ones. A folder only groups sessions: a session's project is unchanged, and
deleting a folder puts its sessions back among the ungrouped ones, never deleting a session.

Huli's own files:

- `src/shared/session-folders.ts`: `SessionFolder` (name, pinned, collapsed, its session ids) and
  helpers.
- `src/agent-host/session-folders.ts` (+ `.test.ts`): the store, kept in
  `state/session-folders.json`, and the validators of `folders.list`, `folders.create`,
  `folders.rename`, `folders.update` (pinned, collapsed), `folders.delete`, `folders.reorder` and
  `folders.move` (into a folder, or out with `folderId: null`). A change is broadcast as
  `folders.changed`; sessions that went away are left out as the folders are read. Paired devices
  may call them all.
- `src/renderer/src/features/session-folders/`: each host's folders (`store.ts`), the sidebar's
  Folders section above or below the projects (`folder-section.tsx`, the choice kept per
  device), naming and deleting (`folder-dialogs.tsx`), Move to folder › in the session menus
  (`move-menu.tsx`) and dropping dragged sessions on a folder, a project or the Folders label
  (`drag.ts`).
- `src/shared/locales/*/sessionFolders.json`: the desktop's copy.

Hooks into upstream files, one or two lines each:

- `src/shared/agent-host.ts` (the `folders.*` methods and the `folders.changed` event),
  `src/shared/host-request-limits.ts`, `src/agent-host/validate.ts` (spreads
  `folderValidators`), `src/agent-host/host.ts` (the store, its load and flush, the handlers).
- `src/shared/i18next.d.ts` (the namespace), `src/renderer/src/app/bootstrap.ts` (loading, the
  `folders.changed` event, another host connecting).
- `features/sidebar/app-sidebar.tsx` (the `FolderSection`s, `SessionFolderDialogs`, and in
  `ProjectGroup` the sessions left out because a folder holds them and the header's drop),
  `features/sidebar/session-menu.tsx` (two `MoveToFolderMenu`s), `features/sidebar/session-row.tsx`
  (a range selection in the order folders show), `features/split/session-drag.tsx` (a drop on a
  folder).

The phone app (`mobile/`) shows them on its home list, with the system's context menus and the
other paired computers' sessions (`mobile/src/fleet.ts`, `folders.tsx`, `homeList.ts`).

Generated before a build (not hand edits, never committed):

- `node tools/huli/rebrand.mjs` swaps the display name Kettu to Kite, and to 纸鸢 in Chinese copy
  (`ZH_NAME`), dropping the spaces that set a Latin word off from Chinese, and puts Kite's artwork
  in place. Idempotent; the build workflow runs it, and so must a local build (see Build) or a
  `pnpm dev` meant to look like Kite.
  - Every locale but `star.json` (the prompts to star Kettu's repository) and `kettuImport.json`
    (the import from an official Kettu) has its values rewritten:
    the word Kettu, except in `KettuAI/Kettu` and in the phrases `KEEP` lists (the attribution and
    Star Kettu); Kettu's service copy (`COPY`), `kettu.sh` and the home folder `.kettu/`; and
    pairing-link placeholders (`LINKS`), which are swapped even though they are URLs.
  - `ZH_APP_NAME` lists the Chinese strings whose `{{name}}` is the app's own (the macOS app menu,
    the quit dialog, the tray's menu), which main fills with `app.name`, Kite: in Chinese they say
    纸鸢. `ADD` adds the keys rebranded code reads: About's title, 纸鸢 Kite in Chinese.
  - `CODE` lists the exact display strings swapped in code: window titles, About, the update cards,
    the account menu's version line, the built-in theme's name, the Marketplace's own server, the
    first run's pictures, the Linux login item and the sign-in pages. When upstream changes one of
    those spellings the script warns `no longer holds …`; add the new spelling there.
  - It never touches tests: they read the constants the code uses (below).
  - `ARTWORK`: it copies `tools/huli/brand/assets/desktop/`, a mirror of the repository, over
    Kettu's icons (`build/icon.png`, `build/icon.ico`, `build/icon.icon`, emptied first), the
    tray's images (`resources/tray`), the renderer's icon, mark and glyphs
    (`src/renderer/src/assets/kettu-*.svg`) and the first run's pictures
    (`assets/onboarding/fox-*.webp`, now paper kites). The tree keeps Kettu's, so Kettu's own icon
    changes merge cleanly; it warns about a tray image or brand file upstream adds that Kite lacks.

### Kite's artwork

`tools/huli/brand/` holds the masters, SVG on a 1024 grid: `kite-light.svg` (the icon, white kite
on orange), `kite-dark.svg`, `kite-tinted.svg`, `kite-glyph.svg` (one color, for themed icons),
`kite-tray.svg` (the 18 pt tray glyph) and the first run's `scene-flying.svg` and
`scene-resting.svg`. `render.mjs` renders the rest, all committed: the desktop's files into
`assets/desktop/` (above) plus `assets/icon.icns` for a Mac without Xcode 26, and the phone's
straight into `mobile/assets`: `kite.icon` (Icon Composer: ground, kite and string layers with
their dark appearances, which iOS 26 draws in Liquid Glass and derives tinted and clear from),
`ios/icon-{light,dark,tinted}.png` (the same flat, for `ios.icon` as an object should the
`.icon` not build), `icon.png`, the splash, the favicon and Android's adaptive layers. After
changing a master:

```powershell
npm i --no-save --no-package-lock --prefix tools/huli/brand @resvg/resvg-js sharp
node tools/huli/brand/render.mjs ..\ref\kite-preview.png   # the optional sheet of every icon
```

### Agent network

Each agent can reach the network through a node of the user's proxy subscriptions (机场订阅)
instead of the system's network, which may be a Clash or Karing TUN. The agent host runs mihomo
(`tools/install/mihomo.mjs`, GPL-3.0, a separate program) with one `mixed` listener on 127.0.0.1
per agent that uses a node, and gives that agent only its listener in `HTTP_PROXY`, `HTTPS_PROXY`
and `ALL_PROXY`, with loopback, the private ranges and Tailscale in `NO_PROXY`. Kite's own traffic
keeps Advanced › Proxy.

It fails closed: every group starts on REJECT, lists it and falls back on it (an empty group
would fall back to DIRECT), the rules reject everything, and the host picks each group's node
through the API; a node that left its subscription leaves its group on REJECT. While mihomo is
starting, stopped or crashed (it is restarted on the same ports) the listener refuses
connections. Nodes and their DNS (DoH by address) are bound to the physical interface of the
default route, found with the system's tools and checked every minute, or named in Settings.
Only programs that follow the proxy variables are held to the node; one that ignores them still
goes out on the system's network.

The exit check (`agentNetwork.exitIp`, `exit-ip.ts`) proves the path: the agent host fetches
`https://www.cloudflare.com/cdn-cgi/trace` through the agent's own listener with HTTP CONNECT
(or, for an agent on the system's network, through its HTTP proxy variable or directly) and
reads `ip=` and `loc=`. A check stands a minute, runs again after the agent's node changes, and
shows 无法连接 when the listener refuses the tunnel, which is the fail-closed case. A SOCKS or
HTTPS system proxy is reported as unsupported rather than gone around.

Huli's own files:

- `src/shared/agent-network.ts`: the settings' part (on, default node, each agent's choice, the
  interface), the status and node types, `NODE_NO_PROXY`.
- `src/agent-host/node-proxy/`: `config.ts` (the configuration, pure, + `config.test.ts`),
  `api.ts` (mihomo's REST API on 127.0.0.1 with a random secret), `interface.ts`, `files.ts`
  (`agent-network/subscriptions.json`, which alone holds the links, and
  `state/agent-network.json`, the listener ports and the running mihomo, to stop one a crash
  left), `service.ts` (the process, its restarts, the picks, the exits), `exit-ip.ts` (the
  trace request through a listener), `validate.ts` and `network.test.ts`.
- `src/renderer/src/features/settings/agent-network-section.tsx`, `agent-network-rows.tsx`,
  `src/renderer/src/stores/agent-network.ts`: Settings › Agent network and the agent page's
  Network exit row; `network.*` in `locales/*/settings.json`.

Subscription links carry tokens: they never go into settings.json, a status, an event or a log
(each link and its parts are log secrets), and the `agentNetwork.*` methods are refused to paired
devices (`src/shared/remote/allow-list.ts`), whose ports never hear `agentNetwork.changed`.

Hooks into upstream files: `src/shared/settings.ts` and `src/main/settings-schema.ts` (the
`agentNetwork` section, a client's own like `computerUse`), `src/shared/agent-host.ts`,
`host-request-limits.ts`, `host-control.ts` (`mihomoPath`), `src/agent-host/host.ts`, `start.ts`,
`validate.ts`, `rpc.ts` (`sendToWindows`), `shell-env.ts` (`applyNodeProxy`), `agents.ts`
(`networkChanged`: an idle agent's process stops so its next start takes the new variables),
`src/main/computer-use.ts`, `agent-host.ts`, and in the renderer `bootstrap.ts`,
`settings-page.tsx`, `web-sections.ts`, `agents-section.tsx` and `stores/view.ts`. The phone app
does not show it.

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
Remote access uses direct connections over the network or Tailscale and, with Huli Cloud on and
signed in, Huli Cloud's relay from any network, which the hosted web client at
`HOSTED_WEB_URL` uses too (`cloud/README.md` describes both and their deployment).

## Relay and web client

- `cloud/src/relay.ts` is the relay, `cloud/src/relay-tokens.ts` the tokens it takes (access
  tokens and HMAC-signed relay tokens from `POST /api/v1/relay/token`), both in the Huli Cloud
  process; `cloud/test/relay.test.ts` drives them with the clients' own `RelayHost` and
  `dialRelay`.
- `src/shared/huli-cloud.ts`: Huli's own OAuth client for the phone (`huli-mobile`, redirect
  `huli://signin`) beside Kettu's `kettu-desktop`, `kettu-daemon` and `kettu-web`.
- The phone (`mobile/src/relay.ts`) falls back to the relay when no direct address answers, with
  the token `relayTokens()` is given by the phone's Huli Cloud sign-in.
- `tools/huli/deploy-cloud.ps1` builds the service and the hosted web client and installs both.

## Account and computers

Huli Cloud keeps a registry of the account's computers (`cloud/src/store.ts`); `cloud/README.md`
describes it, the pairing without a code and its threat model.

- `src/shared/huli-cloud.ts`: the account API beyond Kettu's (`GET /api/v1/account/devices`,
  `POST /api/v1/account/devices/revoke`), its types and parsers, and `HOST_CLIENTS`, the sign-ins
  that may put a host on the relay.
- `src/shared/huli-signin.ts` (+ `.test.ts`): the phone's sign-in (PKCE, the vault, refresh
  rotation, sign out), apart from the phone's APIs; `mobile/src/cloud.ts` gives it the Keychain and
  ASWebAuthenticationSession and hands the relay its tokens.
- `src/shared/remote/pair-account.ts`: the device side of Kettu's discovery for the phone and the
  hosted web client; `src/remote-host/account-pairing.test.ts` checks that a computer adds a device
  only with both yeses, and that a device refuses a welcome before its user's.
- Desktop: `src/main/huli-account.ts` (+ `.test.ts`, the IPC calls `account:devices` and
  `account:revoke-device`), `src/renderer/src/stores/account-devices.ts`,
  `features/settings/account-devices.tsx`, `locales/*/huliAccount.json`.
- Phone: `mobile/src/app/settings/account.tsx`, `mobile/src/app/pair-computer.tsx`,
  `mobile/src/components/AccountComputers.tsx`. Hosted web client:
  `src/renderer/src/web/hosted/account-pairing.tsx`.

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
npx -y pnpm@10.11.1 fetch:mihomo
npx -y pnpm@10.11.1 fetch:device-helpers
npx -y pnpm@10.11.1 dist:win      # dist\Kite-<version>-x64-setup.exe
```

The rebrand leaves its output in the working tree; never commit it.
