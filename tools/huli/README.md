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
- Services: the update channel (under a secret path, see Update channel) and Kite Cloud's host
  (`huli.132-145-200-0.sslip.io`), the server's `huli-cloud` command and `HULI_*` settings, the
  pairing, relay and push constants, the repository `Rsdvb/huli` and the `huli-*` workflows.
- The phone app's `expo.name`, which names its Xcode project, scheme and `Huli.app` that
  `tools/huli/ios` builds; the name people see comes from `mobile/plugins/appName.js` and
  `mobile/locales/zh-Hans.json`.
- Code identifiers (`HuliIcon`, `HuliLive`, `Huli*.swift`, …) and comments.

Chinese copy says 纸鸢 wherever it names the product; English copy, window titles, the installer,
shortcuts, the macOS menu bar, the tray's tooltip and file names say Kite; About says 纸鸢 Kite in
Chinese. The account service is Kite Cloud in both.

## What differs from upstream

Code (kept small so upstream merges stay clean):

| File                                                                                                                                     | Change                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent-host/agents.ts`                                                                                                               | `READ_ANTIGRAVITY_LIMITS = false`: never runs `agy -p /usage`, `/credits` or a hidden ACP session by itself to read Antigravity's limits; only a refresh the user presses (`agents.refreshLimits` with `ask: true`) runs `/usage` and `/credits` once                                                               |
| `src/shared/settings.ts`                                                                                                                 | defaults: cloud off, relay on (Huli Cloud's, used only with the cloud on and signed in), discoverable (the account's phones and browsers may ask to be added; the owner allows each)                                                                                                                                |
| `src/remote-host/start.ts`, `src/shared/remote/relay.ts`                                                                                 | signed in to the relay, the host always sends its profile, so Huli Cloud registers it as the account's computer; `pairable: false` in it while it is not discoverable                                                                                                                                               |
| `src/main/update-keys.json`, `src/main/update-sources.ts`, `src/shared/updates.ts`, `src/daemon/update.ts`                               | updates come from Huli's own channel on Huli Cloud's host, signed with Huli's own release keys (kept off the repository); its path is a placeholder the build fills in (see Update channel), and a build without it has no updates; nothing else, GitHub included, is a source (`updater.ts`, `use-github-only.ts`) |
| `src/shared/account-api.ts`, `src/shared/remote/push.ts`                                                                                 | the account service and push gateway are Huli Cloud, `https://huli.132-145-200-0.sslip.io` (see `cloud/`)                                                                                                                                                                                                           |
| `src/shared/kettu-hosts.ts`                                                                                                              | Huli Cloud's host counts as one of the services the cloud switch governs                                                                                                                                                                                                                                            |
| `src/shared/remote/relay.ts`, `relay-regions.ts`                                                                                         | `RELAY_URL` is Huli Cloud too (its relay, one region, Ashburn); `REGION_KEYS` are Huli's own region list keys (`tools/huli/region-list.mjs`, private halves in `~/.huli-keys`)                                                                                                                                      |
| `src/shared/remote/pairing.ts`                                                                                                           | `HOSTED_WEB_URL` is Huli's web client, `https://app.huli.132-145-200-0.sslip.io`; `PAIRING_URL` points at `huli.invalid`, which never resolves                                                                                                                                                                      |
| `src/shared/storage.ts`, `src/agent-host/worktrees/git.ts`                                                                               | home folder `~/.huli` instead of `~/.kettu`                                                                                                                                                                                                                                                                         |
| `src/main/user-data.ts`                                                                                                                  | development data folder `Huli Dev`; an installed build's, `Huli` (`PACKAGED_DATA_FOLDER`), which `src/main/index.ts` pins                                                                                                                                                                                           |
| `src/main/index.ts`, `src/main/computer-use.ts`                                                                                          | app user model id `local.huli.app`                                                                                                                                                                                                                                                                                  |
| `package.json`                                                                                                                           | productName `Kite`, version 0.1.0                                                                                                                                                                                                                                                                                   |
| `electron-builder.yml`                                                                                                                   | appId `local.huli.app`, productName `Kite`, `publish` is Huli's update channel (generic), its path a placeholder as above                                                                                                                                                                                           |
| `src/renderer/src/stores/marketplace.ts`, `features/marketplace/{directory,model}.ts(x)`, `src/agent-host/marketplace/claude-plugins.ts` | the Marketplace never reads Kettu's community marketplace (kettu.sh) and has no Published tab; its Community section lists Anthropic's community plugin marketplace (`anthropics/claude-plugins-community`, added once to each Claude Code agent) and the community skills on GitHub                                |
| `src/main/browser/{policy,views}.ts`, `src/shared/browser.ts`, `browser-pane.tsx`, `locales/*/browser.json`                              | the side panel's browser saves a download through the system's save dialog, where the user picks, instead of dropping it; the pane then says whether it saved                                                                                                                                                       |
| `features/settings/about-section.tsx`, `locales/*/settings.json` (`about.version.basedOn`)                                               | About says Huli is a personal build based on Kettu under the AGPL-3.0; the rebrand keeps that phrase naming Kettu                                                                                                                                                                                                   |
| `eslint.config.mjs`, `.prettierignore`                                                                                                   | lint and formatting reach the phone app in `mobile/` (see Workflows)                                                                                                                                                                                                                                                |

### Import from agents

Brings every past session of Claude Code, Codex or an ACP agent on this computer over, across all
the folders it ran in, instead of a project at a time with the sidebar's Import sessions: Settings ›
General › Import from agents. Nothing is listed until its dialog opens; the agents' own files are
only read.

Huli's own files:

- `src/agent-host/agent-history.ts` (+ `.test.ts`): `agentHistory.list`. Claude Code's
  transcripts are read here, under its config folder's `projects/` (`CLAUDE_CONFIG_DIR` or the
  folder chosen for the agent): only each project folder's own `<uuid>.jsonl`, never
  `<session>/subagents/`, and of each only the first and last 64 KB, 16 at a time, kept by path,
  size and time so a second look reads only what changed. A session's folder is the `cwd` it
  recorded (a `relocated` one's new folder), never the lossy folder name; a copy Claude Code left
  in another folder when it moved a session is listed once, from the folder that fits. Its title
  is its custom title, else its AI title, else its first prompt. Codex's threads and an ACP
  agent's sessions come from the agent (`listAllSessions`: `thread/list` or `session/list` without
  a `cwd`), since Codex keeps most rollouts zstd-compressed and indexes them itself. Sidechains,
  subagents' threads and sessions without a message are counted and left out; one whose id a
  session here has (`agentSessionIds`) is marked imported, one whose folder is gone missing.
  What was listed keeps its title and times for `sessions.import`, which imports each as the
  sidebar does (adding its project if needed). A window's alone (`WINDOW_ONLY`): it names every
  folder an agent ran in, which a paired device otherwise learns only by naming a folder.
- `src/agent-host/memory/codex-import.ts` (+ `.test.ts`): Codex's own memory for the memory
  import beside Claude Code's (`memory.importScan`, `memory.import`). Only the curated files of
  `$CODEX_HOME/memories`: each `# Task Group:` of MEMORY.md (without its lists of rollout files),
  placed by the folder its `applies_to` names when that is a project here, else global; and the
  profile, preferences and tips of memory_summary.md, global. `raw_memories.md`,
  `rollout_summaries/` (what those were made from), `extensions/` (notes already merged into them)
  and `skills/` are not memory. `memories_v2` is read only when `memories` has neither file. A
  re-run brings nothing new, as an entry whose title and body memory holds is skipped.
- `src/shared/agent-history.ts`: the listing's types.
- `src/renderer/src/features/agent-history/`: the dialog (agents as tabs, sessions by folder with
  search and the quick picks Last 30 days, All and None; three imports at a time with progress,
  Stop and a summary that offers the memory import and the latest session), its model and the
  Settings row.
- `src/shared/locales/*/agentHistory.json`: its copy.

Hooks into upstream files, one or two lines each:

- `src/agent-host/connection.ts` (`ListedEverywhere`, the optional `listAllSessions`), its
  implementations in `codex/connection.ts` and `acp/connection.ts`.
- `src/agent-host/sessions.ts` (`agentSessionIds`; `importSession` takes an optional `kept`, the
  title, times, pin and archive, and the `KeptField` type), `src/agent-host/host.ts` (the handler,
  and `sessions.import` taking over a listed session's title and times through `keptFor`; the
  Codex agents for memory).
- `src/agent-host/memory/service.ts` (`codexAgents`, Codex's sources in `importScan` and
  `import`), `src/shared/memory.ts` and `memory.import` (a source's `project` may be null: global
  memory), `features/settings/memory-rows.tsx` (a tick per source, its entries' titles, a source of
  global memory, and `MemoryImportDialog` for the summary).
- `src/shared/agent-host.ts`, `src/shared/host-request-limits.ts`, `src/agent-host/validate.ts`,
  `src/shared/remote/allow-list.ts`, `src/shared/i18next.d.ts`,
  `features/settings/section-defs.tsx` (the row), `locales/*/settings.json`
  (`memory.import.sourceGlobal`).

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
  in place. Idempotent; the build workflow runs it, and so must a local build (see Build).
  `pnpm dev` needs none (see Kite in development). What it swaps in text, and how, is in
  `brand-text.mjs`; the script reads and writes the files.
  - Every locale but `star.json` (the prompts to star Kettu's repository) has its values
    rewritten: the word Kettu, except in `KettuAI/Kettu` and in the phrases `KEEP` lists (the
    attribution and Star Kettu); Kettu's service copy (`COPY`), `kettu.sh` and the home folder
    `.kettu/`; and pairing-link placeholders (`LINKS`), which are swapped even though they are URLs.
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
  - Last it runs `update-path.mjs` (below), unless given `--no-update-path`, as
    `deploy-cloud.ps1` does: the hosted web client is public, so the path stays out of it.
- `node tools/huli/update-path.mjs` fills in the update channel's path (see Update channel). The
  rebrand runs it; the phone builds run it alone, before bundling.

### Kite in development

`pnpm dev` runs the tree as committed, yet looks like Kite: `tools/huli/dev-brand.mjs`, a Vite
plugin in `electron.vite.config.ts`'s main and renderer builds that applies only in development
mode (`electron-vite dev`), makes the rebrand's swaps from the same tables in `brand-text.mjs` as
each file loads. Locale files get `brandLocale`, the files `CODE` lists get their swaps (the HTML
pages through `transformIndexHtml`), and an import of Kettu's artwork that Kite has its own of in
`ARTWORK` resolves to Kite's. The window's icon (`build/icon.png`) and the tray's images
(`resources/tray`), which an unpackaged run reads from the tree, point at Kite's in `ARTWORK`. The
name in the taskbar and the tray's tooltip is `app.name`, the `productName` Kite; the data folder
stays `Huli Dev` (or `KETTU_USER_DATA`). It never fills in the update channel's path, so a dev run
has no updates, as before. A spelling upstream changed shows as a Vite warning,
`… no longer holds …`, as the rebrand's does.

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
per agent of the host, whatever its choice, so a change of choice never changes that mihomo, and
gives an agent that uses a node or an interface only its listener in `HTTP_PROXY`, `HTTPS_PROXY`
and `ALL_PROXY`, with loopback, the private ranges and Tailscale in `NO_PROXY`; the group of an
agent on the system's network stays on REJECT. Kite's own traffic keeps Advanced › Proxy.

It fails closed: every group starts on REJECT, lists it and falls back on it (an empty group
would fall back to DIRECT), the rules reject everything, and the host picks each group's node
through the API; a node that left its subscription leaves its group on REJECT. While mihomo is
starting, stopped or crashed (it is restarted on the same ports) the listener refuses
connections. Nodes and their DNS (DoH by address) are bound to the physical interface of the
default route, found with the system's tools and checked every minute, or named in Settings.
Only programs that follow the proxy variables are held to the node; one that ignores them still
goes out on the system's network.

An agent can instead be bound to one network interface (选择网卡), any the computer has, such as a
proxy client's TUN or Wi-Fi: `{ interface: <name> }` beside `'system'` and a node. Its listener
stays the same, in the nodes' mihomo, whose group for each agent also holds a hop: a `socks5`
proxy to 127.0.0.1 on a port of the agent's own, signed in with a password the host makes at
start, and bound to the loopback interface (mihomo binds no socket to 127.0.0.1, but on Windows
and macOS it looks the interface up first, so the physical one would fail the hop while gone).
Behind the hop the host runs a mihomo of that agent's own (`interfaceConfig`, in
`agent-network/mihomo/interfaces/<n>/`), whose one `socks` listener on 127.0.0.1 takes only the
hop's user (`skip-auth-prefixes: []`), and whose group holds REJECT first and a `type: direct`
proxy with `interface-name`, and nothing else; the global DIRECT is in no group. Binding an agent,
unbinding it or moving it to another interface so starts or stops that agent's mihomo alone, on
the same hop port, and picks its group through the API: the nodes' mihomo, the other agents'
mihomo processes and every connection through them carry on. The nodes' group picks the hop only
while the agent's mihomo answers and the interface is up, else REJECT; that mihomo's group picks
the direct proxy under the same rule. mihomo binds that proxy's sockets to the interface
(IP_UNICAST_IF on Windows, IP_BOUND_IF on macOS, SO_BINDTODEVICE on Linux) and a dial fails when
the interface is gone (`interface not found`) or down (unreachable), never on another interface.
While an agent is bound, the host reads `os.networkInterfaces()` every 2.5 s (`InterfaceWatch`:
a few ms, no child process; Node lists an interface only while it is up with an address, by the
name mihomo uses), puts the agent's groups on REJECT as soon as its interface is gone, and when it
is back starts the agent's mihomo anew, since mihomo keeps its interface table for 20 s, and
picks the hop again: measured with the pinned mihomo, cut off 2.1 to 2.7 s after the interface
went and through again 1.3 to 3.0 s after it came back. The full list (`interface.ts`:
`Get-NetAdapter`, `ifconfig` with `networksetup`, `ip -o link`) is read for the windows, on
`agentNetwork.interfaces` and after such a change, and decides only while that read fails. A
direct proxy resolves names with mihomo's process-wide `direct-nameserver`, which is why each
bound agent needs its own mihomo: there names go out as plain UDP DNS (223.5.5.5, 119.29.29.29)
bound to the same interface, which a TUN's DNS hijack answers, with a fake IP in fake-ip mode, so
the TUN sees the name and routes by its domain rules; DoH would hide the query from it.

Subscriptions are downloaded by Kite, not mihomo (`download.ts`): the way Kite's own requests go,
through Advanced › Proxy or the environment's `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (HTTP,
HTTPS or SOCKS5, honouring `NO_PROXY`), else directly, which a Clash or Karing TUN still catches,
since many providers cannot be reached in China without a proxy. The list of nodes says nothing
about who uses them; the agents' traffic still goes only through the nodes on the physical
interface. The request sends `User-Agent: clash.meta mihomo/<pinned version>` so providers answer
with Clash YAML, follows at most 5 redirects and only to http(s), takes at most 10 MiB and 30 s,
and reads `subscription-userinfo` for the traffic and expiry. `content.ts` refuses content without
a node, keeps YAML as it came and writes a list of node links back as standard base64 (mihomo's
v2ray parser takes no URL-safe or wrapped base64), and the result goes atomically to
`agent-network/mihomo/providers/<id>.yaml` (0600). mihomo reads it as a `file` provider (with
the interface override, the name prefix and the health check) and is told to read it again with
`PUT /providers/proxies/<name>`; it never downloads anything, so no provider or rule names DIRECT.
A subscription is added only once its first download gave nodes; Kite downloads each again every
12 hours while the network is on (30 minutes after a failure) and on 更新. A failed download keeps
the last nodes and shows why and when, beside when it last succeeded. A subscription can also be
imported from a file (`agentNetwork.importSubscription`, `reimportSubscription`): stored the same
way with no link, never refreshed, imported again with 重新导入.

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
  `state/agent-network.json`, the listener ports, the running mihomo, to stop one a crash
  left, and each subscription's last download), `download.ts` and `content.ts` (the download
  and what it may hold), `service.ts` (the process, its restarts, the picks, the downloads, the
  exits), `exit-ip.ts` (the trace request through a listener), `validate.ts`,
  `network.test.ts` and `subscription.test.ts`.
- `src/renderer/src/features/settings/agent-network-section.tsx`, `agent-network-rows.tsx`,
  `src/renderer/src/stores/agent-network.ts`: Settings › Agent network and the agent page's
  Network exit row; `network.*` in `locales/*/settings.json`.

Subscription links carry tokens: they never go into settings.json, a status, an event or a log
(each link and its parts are log secrets), and the `agentNetwork.*` methods are refused to paired
devices (`src/shared/remote/allow-list.ts`), whose ports never hear `agentNetwork.changed`, but
for two device-safe ones: `agentNetwork.deviceStatus` (on, state, problem, interface name, the
computer's interfaces as name, state and TUN mark, subscriptions as id, name, node count and
traffic, nodes as subscription id, name and latency, the default node, each agent's choice and
the exits; `network.test.ts` checks no link, host or token is in it) and `agentNetwork.deviceLatency`. A device changes the default node and an agent's
choice through the admin calls `settings.setDefaultNode` and `settings.setAgentNetwork`
(`src/shared/remote/host-admin.ts`, `src/main/host-admin.ts`, `withDefaultNode` and
`withAgentNetworkChoice` in `settings-schema.ts`); the generic `settings.update` still refuses the
section, so its switch and interface stay the computer's, as adding, removing and refreshing
subscriptions do.

Hooks into upstream files: `src/shared/settings.ts` and `src/main/settings-schema.ts` (the
`agentNetwork` section, a client's own like `computerUse`), `src/shared/agent-host.ts`,
`host-request-limits.ts`, `host-control.ts` (`mihomoPath`), `src/agent-host/host.ts`, `start.ts`,
`validate.ts`, `rpc.ts` (`sendToWindows`), `shell-env.ts` (`applyNodeProxy`), `agents.ts`
(`networkChanged`: an idle agent's process stops so its next start takes the new variables),
`src/main/computer-use.ts`, `agent-host.ts`, and in the renderer `bootstrap.ts`,
`settings-page.tsx`, `web-sections.ts`, `agents-section.tsx` and `stores/view.ts`. The phone app
shows it in `mobile/src/app/settings/network.tsx` (设置 › Agent 网络), `network-node.tsx` (the
node picker with latencies), the 网络出口 group of `settings/agent.tsx`, and
`mobile/src/manage/network.ts`.

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
  The macOS app and the iOS app build on GitHub's `macos-26` runners; `tools/huli/restore-apple-keys.sh`
  first unpacks the `HULI_APPLE_KEYS` secret (the Developer ID and Apple Distribution certificates,
  the build keychain's password and the App Store Connect key) into `~/.huli-keys`, where
  `build-ios.sh` and the signed macOS build look for them, and `signing.mjs` refuses to make a new
  certificate in CI. Setting the `HULI_MAC_RUNNER` variable to `true` moves both jobs back to the
  owner's Mac, which a public repository must never do: a pull request could run code there.
  `tools/huli/newest-xcode.sh` selects the newest Xcode on the runner first and prints its SDK,
  since App Store Connect only takes builds made with the newest major SDK (ITMS-90725: iOS 27
  from April 2027); if the image has none new enough, move to a newer `macos-*` image.
- `huli-monitor.yml`, every half hour (at :07 and :37) and by hand: checks from outside that Kite
  Cloud answers `/healthz` with `ok`, the relay's `/v1` gives its info, the web client's page and
  its script load, and the update channel's `latest/download/latest.yml` (under the
  `HULI_CHANNEL_URL` secret, never printed, nor named in the issue) answers with a `version:`.
  Each request gives up after 30 s; a check that fails is tried twice more a minute apart, so a
  blip raises nothing. One still failing opens an issue, `Kite 服务异常：<what>`, labelled
  `monitor` and mentioning the owner; while it is open the monitor comments only when what fails
  changes, and the first run that finds everything healthy closes it with a comment. Closing it by
  hand while something still fails gets a new one on the next run. The run itself fails only when
  the monitor could not report, which GitHub mails as a failed run. To try the issue without an
  outage: `gh workflow run huli-monitor.yml -R Rsdvb/huli -f rehearse=true`, which reports a
  made-up failure that the next run closes.

The monitor's alerts are GitHub's notifications: the owner keeps this repository watched
(Watching, or Custom with Issues) and email notifications on in GitHub's settings, or a new issue
or comment reaches no inbox. The workflows that open issues (`huli-monitor.yml`, `huli-sync.yml`)
set `GH_REPO`, so gh never takes the repository from a git remote: `huli-sync.yml` adds Kettu's as
`upstream`, which gh prefers over `origin`, and its issues used to go to KettuAI/Kettu and fail.
GitHub disables the scheduled workflows of a public repository after 60 days without activity in
it; the nightly sync's merges normally keep it active, but should upstream go quiet and nothing be
pushed for that long, the schedules stop until re-enabled under Actions or with
`gh workflow enable <file> -R Rsdvb/huli` for each `huli-*` workflow that has one.

Lint covers `mobile/` too, through the root ESLint config: the phone app gets the React hooks
rules as the renderer does, may `require()` images as Metro needs, and drops props by leaving them
out of a rest spread. `mobile/src/artifact-view/page-runtime.generated.ts` is generated, so
Prettier skips it.

## Public code, private builds

The repository is public so macOS and iOS can build on GitHub's free runners; the builds are not,
and once a run ends GitHub offers none of them for download:

- Every job seals its files before `upload-artifact`: `tools/huli/seal-artifacts.mjs seal` packs
  them, `latest*.yml` and the blockmaps too, into one `sealed/<artifact>.sealed`, encrypted with
  AES-256-GCM under a key derived (HKDF-SHA256, a random salt each time) from the
  `HULI_ARTIFACT_KEY` secret. The release job opens each bundle into `files/` beside it before
  Gather and sign; a wrong key or a damaged bundle fails it, and nothing is written until the whole
  bundle authenticates. The script uses Node alone, so it runs alike on the Linux, Windows and
  macOS runners; the `version` job fails the run at once when the secret is missing, and the
  script never prints the key. A signed-in GitHub user who downloads an artifact while the run is
  going gets only the sealed bundle. To open one by hand, with the key in the environment:
  `node tools/huli/seal-artifacts.mjs open huli-macos.sealed out`.
- Every `upload-artifact` keeps its file a day at most (`retention-days: 1`), and the `cleanup`
  job, which waits for every job that uploads or downloads them and runs even when one failed or
  the run was cancelled, deletes all of the run's artifacts through the REST API.
- The release on GitHub is a pre-release with notes only: the Kettu commit merged and the files'
  SHA-256 sums. It attaches no file, `SHA256SUMS.txt` included. Its tag stays, since the nightly
  `changes` job compares main with the latest release's.
- The installers go only to the update channel, whose path the code never holds (see Update
  channel). The release job takes the channel's URL from the `HULI_CHANNEL_URL` secret, not a
  variable, so the log masks it.
- iOS builds go to TestFlight for its internal testers only; there is no public link, and
  `publish-testflight.mjs`, which put each build on it, is gone. The same build, signed ad hoc,
  goes to the update channel, where only the team's registered devices can install it (see Phone
  updates).
- Signing material comes from the `HULI_APPLE_KEYS` secret (above), Android's key from
  `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD`, and the update files' key from
  `UPDATE_SIGNING_KEY`; nothing prints them. The artifacts' key, `HULI_ARTIFACT_KEY`, is random
  and used nowhere else; make or replace it with
  `openssl rand -base64 48 | gh secret set HULI_ARTIFACT_KEY -R Rsdvb/huli`, which never shows it.

## Update channel

The channel lives at `https://huli.132-145-200-0.sslip.io/u/<path>`, where `<path>` is 32 hex
characters that only the builds know. The code holds the placeholder `__HULI_UPDATE_PATH__` in
its place, in `electron-builder.yml` (`publish`), `src/daemon/update.ts`,
`src/main/update-sources.ts` and `src/shared/updates.ts` (whose `RELEASES_URL` the phone reads
too). `tools/huli/update-path.mjs` fills it in before a build, from the `HULI_UPDATE_PATH`
environment variable, else from `~/.huli-keys/update-path.txt` (`%USERPROFILE%\.huli-keys` on
Windows), never printing it. In CI (`GITHUB_ACTIONS=true`) a missing path, one that is not 32
lowercase hex characters, or a file that no longer holds the placeholder fails the build; a local
build without it warns and leaves the placeholder.

Every job that builds something that names the channel fills it in: the desktop and macOS jobs
through the rebrand, and the iOS and Android jobs with `update-path.mjs` alone before
`expo prebuild`, each with the `HULI_UPDATE_PATH` secret. A build that still holds the placeholder,
such as `pnpm dev`, has no updates rather than failing: `UPDATE_CHANNEL_READY` in
`src/shared/updates.ts` turns the desktop updater off (as in development), the phone's update
check off, and `kettu update` finds no place of its own.

The channel is the one place the desktop app updates from (`CHANNEL_ONLY` in
`src/shared/updates.ts`): the builds are on no GitHub release. Upstream's choice of download source
(Automatic, or GitHub only) stays out of Settings, and `sourceChoiceFor` in
`src/main/update-sources.ts` takes upstream's GitHub only path whatever an older settings file
chose, with the cloud on or off, since `GITHUB_SOURCE` names the channel (`RELEASES_URL`) and the
channel serves no source list. `use-github-only.ts` makes the updates row's error name the
channel, and `locales/*/settings.json` (`about.updates.githubUnreachable*`, `about.source.*` and
`general.others.items.updates.source`) says so. A stored `updates.source:
'github'` is left as it is: it no longer picks a source, and still keeps the harness manifest from
Kettu's download service.

The path the code used to spell out is in the repository's history, so it was rotated when the
repository went public: the server serves the channel under the new path (`/etc/huli-updates.path`,
which `cloud/deploy/install.sh` reads), and only that file, the secret and
`~/.huli-keys/update-path.txt` hold it. Installs from before the rotation still ask the old
path; unless the server keeps answering there for a while, they need a new build installed once by
hand. The filled-in files stay in the working tree like the rebrand's output; never commit them.

## Phone updates

The phone app hears of its own new builds from the channel (`mobile/src/update.ts`): at start and
on each return to the foreground, at most every six hours, it reads its platform's `latest.json`,
and when the build number there (the run number) is above its own it shows a banner on the session
list and the newest version in Settings › About, which also checks by hand.

- Android: `android/latest.json` (`version`, `versionCode`, `url`, `size`, `sha256`) names
  `android/Huli.apk`. The browser downloads it, and Android installs it over the app only when
  Huli's key signed it.
- iOS: TestFlight cannot reach the owner's iPhone (external review answers 422, internal
  invitations never arrive), so the `ios` job also exports its archive ad hoc.
  `tools/huli/ios/export-adhoc.sh`, which `build-ios.sh` runs with `ADHOC=1` after the App Store
  export and before the upload, has `signing.mjs` (`SIGNING=adhoc`) give every target (the app,
  widgets, notification service and share extension) an `IOS_APP_ADHOC` profile named
  `Huli Ad Hoc <bundle id>`, of the same Apple Distribution certificate and listing every enabled
  iOS device of the team, then exports with method `release-testing` (Xcode's name for ad hoc).
  A profile is kept from build to build while it is active, has that certificate, lists exactly
  the enabled devices and ends a month or more away (or with the certificate); otherwise it is
  deleted and made again. In this mode `signing.mjs` asks App Store Connect each thing once and
  never again, and a build that keeps its profiles makes three calls (certificates, devices,
  ad-hoc profiles). `check-ipa.sh` then checks that the app and every extension in the IPA carry
  an ad-hoc profile (devices listed, no debugger), printing counts and dates but no UDID, since
  the logs are public. The job seals `Huli-<version>.ipa` even when the TestFlight upload failed;
  when the ad-hoc part fails a warning says so, and the release goes out without it while the
  channel keeps its last iOS build. The release job, which waits for the iOS job whatever its
  result, puts the IPA and its `manifest.plist` (itms-services: the IPA's URL, bundle id
  `io.github.rsdvb.huli`, the version, title 纸鸢) into `download/v<version>/`, a copy of that
  manifest into `ios/manifest.plist`, and last `ios/latest.json` (`version`, `build`, `manifest`).
  `cloud/deploy/install.sh` serves `.plist` as `text/xml` and `.ipa` as bytes, as Apple asks.
- `huli-build.yml` run by hand with `ios_dry_run`, on a branch too
  (`gh workflow run huli-build.yml --ref <branch> -f ios_dry_run=true`), runs the iOS job alone:
  it signs (making or replacing profiles as a build does), archives, exports both ways and fails
  when `check-ipa.sh` does, but uploads nothing to TestFlight, keeps no artifact and publishes no
  release.
- On the iPhone only a build that carries a device profile checks: expo-application's
  `getIosApplicationReleaseTypeAsync()` reads its `embedded.mobileprovision` and says ad hoc or
  development, while TestFlight's and the App Store's carry none and leave updates to them. The
  update opens `itms-services://?action=download-manifest&url=<manifest>`; iOS asks, then installs
  the build over the app and keeps its data.
- Only the devices a profile lists can install the build. To add an iPhone, register its UDID with
  the team (developer.apple.com › Devices, or `install-dev.sh`, which registers the phone it
  installs on); the next build finds the device list changed and makes new profiles, and from that
  build on the iPhone can install it.
- The first install, or one over a development build (whose build number, a date, stays above
  every run number, so it never hears of one): in Safari on the iPhone, open
  `itms-services://?action=download-manifest&url=<channel>/ios/manifest.plist`, with the channel's
  URL from `HULI_CHANNEL_URL`.
- An ad-hoc build stops opening once its profile expires: a year after the profile was made, or
  when the distribution certificate expires if that is sooner. Installing a newer build renews it;
  after a new certificate every phone needs a build signed with it.

## Build

```powershell
npx -y pnpm@10.11.1 install --frozen-lockfile
node tools/huli/rebrand.mjs
npx -y pnpm@10.11.1 fetch:cua-driver
npx -y pnpm@10.11.1 fetch:mihomo
npx -y pnpm@10.11.1 fetch:device-helpers
npx -y pnpm@10.11.1 dist:win      # dist\Kite-<version>-x64-setup.exe
```

The rebrand leaves its output in the working tree; never commit it. It fills in the update
channel's path from `%USERPROFILE%\.huli-keys\update-path.txt` (see Update channel), so that output
holds the secret path. To put the placeholder back:

```powershell
git checkout -- electron-builder.yml src/daemon/update.ts src/main/update-sources.ts src/shared/updates.ts
```
