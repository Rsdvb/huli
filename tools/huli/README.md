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

| File                                                                                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent-host/agents.ts`                                                                                                                             | `READ_ANTIGRAVITY_LIMITS = false`: never runs `agy -p /usage`, `/credits` or a hidden ACP session by itself to read Antigravity's limits; only a refresh the user presses (`agents.refreshLimits` with `ask: true`) runs `/usage` and `/credits` once                                                                                                                                                                                                                                                       |
| `src/shared/settings.ts`                                                                                                                               | defaults: cloud off, relay on (Huli Cloud's, used only with the cloud on and signed in), discoverable (the account's phones and browsers may ask to be added; the owner allows each)                                                                                                                                                                                                                                                                                                                        |
| `src/remote-host/start.ts`, `src/shared/remote/relay.ts`                                                                                               | signed in to the relay, the host always sends its profile, so Huli Cloud registers it as the account's computer; `pairable: false` in it while it is not discoverable                                                                                                                                                                                                                                                                                                                                       |
| `src/main/update-keys.json`, `src/main/update-sources.ts`, `src/shared/updates.ts`, `src/daemon/update.ts`                                             | updates come from Huli's own channel on Huli Cloud's host, signed with Huli's own release keys (kept off the repository); its path is a placeholder the build fills in (see Update channel), and a build without it has no updates; nothing else, GitHub included, is a source (`updater.ts`, `use-github-only.ts`)                                                                                                                                                                                         |
| `src/shared/account-api.ts`, `src/shared/remote/push.ts`                                                                                               | the account service and push gateway are Huli Cloud, `https://huli.132-145-200-0.sslip.io` (see `cloud/`)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/shared/kettu-hosts.ts`                                                                                                                            | Huli Cloud's host counts as one of the services the cloud switch governs                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/shared/remote/relay.ts`, `relay-regions.ts`                                                                                                       | `RELAY_URL` is Huli Cloud too (its relay, one region, Ashburn); `REGION_KEYS` are Huli's own region list keys (`tools/huli/region-list.mjs`, private halves in `~/.huli-keys`)                                                                                                                                                                                                                                                                                                                              |
| `src/shared/remote/pairing.ts`                                                                                                                         | `HOSTED_WEB_URL` is Huli's web client, `https://app.huli.132-145-200-0.sslip.io`; `PAIRING_URL` points at `huli.invalid`, which never resolves                                                                                                                                                                                                                                                                                                                                                              |
| `src/shared/storage.ts`, `src/agent-host/worktrees/git.ts`                                                                                             | home folder `~/.huli` instead of `~/.kettu`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/main/user-data.ts`                                                                                                                                | development data folder `Huli Dev`; an installed build's, `Huli` (`PACKAGED_DATA_FOLDER`), which `src/main/index.ts` pins                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/main/index.ts`, `src/main/computer-use.ts`                                                                                                        | app user model id `local.huli.app`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `package.json`                                                                                                                                         | productName `Kite`, version 0.1.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `electron-builder.yml`                                                                                                                                 | appId `local.huli.app`, productName `Kite`, `publish` is Huli's update channel (generic), its path a placeholder as above                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/renderer/src/stores/marketplace.ts`, `features/marketplace/{directory,model}.ts(x)`, `src/agent-host/marketplace/claude-plugins.ts`               | the Marketplace never reads Kettu's community marketplace (kettu.sh) and has no Published tab; its Community section lists Anthropic's community plugin marketplace (`anthropics/claude-plugins-community`, added once to each Claude Code agent) and the community skills on GitHub                                                                                                                                                                                                                        |
| `src/main/browser/{policy,views}.ts`, `src/shared/browser.ts`, `browser-pane.tsx`, `locales/*/browser.json`                                            | the side panel's browser saves a download through the system's save dialog, where the user picks, instead of dropping it; the pane then says whether it saved                                                                                                                                                                                                                                                                                                                                               |
| `features/settings/about-section.tsx`, `locales/*/settings.json` (`about.version.basedOn`)                                                             | About says Huli is a personal build based on Kettu under the AGPL-3.0; the rebrand keeps that phrase naming Kettu                                                                                                                                                                                                                                                                                                                                                                                           |
| `features/session/entries/refusal-end.tsx` and its uses, `locales/*/session.json` (`refusal`), `tools/fake-agent` (`/refusal`)                         | a turn the model declined (`stop_reason: "refusal"`) says the API gives no reason, quotes the model's own explanation when a longer reply holds one, and on the latest turn offers Try again (the same message through the queue; the host's retry resends only failed turns) and Edit message                                                                                                                                                                                                              |
| `styles/affect.css` (the sidebar list's scrollbar)                                                                                                     | App Shell hides the sidebar's scrollbar for good; it shows thin while the pointer or the keyboard is in the sidebar and hides at rest, on Windows in a gutter clear of the resize handle; macOS keeps its overlay scrollbar                                                                                                                                                                                                                                                                                 |
| `src/agent-host/{agents,sessions,host,start,validate}.ts`, `src/shared/{agent-host,host-request-limits}.ts`, `agents-section.tsx`                      | an agent's page offers Reset environment…, its sign-in, ids and caches removed and its history and settings kept (see Agent reset)                                                                                                                                                                                                                                                                                                                                                                          |
| `app/window-front.ts`, `turn-dots.tsx`, `styles/globals.css`                                                                                           | every loop of the window (the turn dots, any CSS animation that repeats forever) is held paused and stepped every 120 ms from one timer, only while on screen with the window visible and focused; the running labels' light sweeps stand still                                                                                                                                                                                                                                                             |
| `features/session/markdown/markdown-impl.tsx`                                                                                                          | streamed words show as they arrive, without affectUI's per-word fade                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `features/session/thread.tsx`                                                                                                                          | a thread resting at its end for 3 s with more than 72 items rendered keeps only the newest 24 (`TrimAtEnd`)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `turn-status.tsx`, `turn-dots.tsx`, `styles/session.css`                                                                                               | a running turn's status label, dots, row of work and tool labels change at once instead of replaying an entrance at each step                                                                                                                                                                                                                                                                                                                                                                               |
| `markdown/{in-parts.ts,markdown-impl.tsx,live.ts}`, `thread.tsx`, `find/find-in-session.tsx`, `components/ui/message-scroller.tsx`                     | a written reply opens with its last chunks, about a window's height, the rest following a chunk a frame with the chunk in view held in place (a returning thread renders it whole; a find waits for it); a settling thread hides by opacity, since visibility restyled every element                                                                                                                                                                                                                        |
| `markdown/markdown-table.tsx`                                                                                                                          | a table measures its overflow only near the view, after layout, through one shared pair of observers                                                                                                                                                                                                                                                                                                                                                                                                        |
| `stores/sessions.ts`, `features/overview/use-overview.ts`, `jump-to-latest.tsx`, `entries/run-group.tsx`                                               | in a burst of tool calls: summaries leave out `working` (the phone's) and keep their object when sent again unchanged, the Overview count is selected as a number, the hidden jump button follows no phase, a folded run keeps its steps' stubs                                                                                                                                                                                                                                                             |
| `src/main/window.ts`, `styles/tokens.css`                                                                                                              | the macOS window is opaque, without vibrancy, which no theme showed (`--desk-tint` was 100%)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `eslint.config.mjs`, `.prettierignore`                                                                                                                 | lint and formatting reach the phone app in `mobile/` (see Workflows)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/agent-host/{agents,host,validate}.ts`, `acp/connection.ts`, `src/shared/agent-host.ts`, `agents-section.tsx`, `mobile/src/app/settings/agent.tsx` | an agent added, turned on or whose page opens is started (never installed) to learn its sign-in methods and state (`agents.readSignIn`, `readingSignIn` while it runs), asked once without a session that would stay in an unchecked agent's history; a sign-in waiting on a browser or terminal is checked every 4 s for 3 minutes, at once when its page is done and when the window comes back, and a check that finds it signed in ends a pending `authenticate` as signed in (`sign-in-watch.test.ts`) |
| ----------------------------------------------------------------------------------------------------------------------------------------               | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                         |
| `src/agent-host/{agents,host,validate}.ts`, `src/shared/{agent-host,host-request-limits}.ts`, `agents-section.tsx`, `app/bootstrap.ts`                 | an agent's Remove… also offers to uninstall its program from the computer and to delete its own data there (see Removing an agent from the computer)                                                                                                                                                                                                                                                                                                                                                        |
| `src/agent-host/{agents,sessions,started-mode}.ts`, `agents-section.tsx`, `agent-sign-in.ts`, `sign-in-actions.tsx`, `new-session.tsx`                 | a signed-out agent's status leaves out the account, plan and balances an earlier sign-in read, which go once it names another account; a changed key or a reset reads the sign-in again (`readingSignIn`); a sign-in stops after 5 minutes; a session's sign-in notice leaves once it no longer waits (`signed-out-readings.test.ts`); New session and a waiting session offer the sign-in in place                                                                                                         |

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
  a `cwd`), since Codex keeps most rollouts zstd-compressed and indexes them itself; so do
  OpenCode's (2.3's `GET /api/session` without a `directory`), Pi's (every folder's session files),
  Cline's (its SDK's `ClineCore.list`, unhydrated; one resumes without its history shown), Doubao's
  and DeepSeek Harness's. Sidechains,
  subagents' threads and sessions without a message are counted and left out; one whose id a
  session here has (`agentSessionIds`, with those of the Claude Code agents that read the same
  configuration folder, `sharingHistory`; the sidebar's Import sessions and `sessions.import`
  count the same) is marked imported, one whose folder is gone missing, and one deleted here whose
  agent keeps its copy (`state/deleted-sessions.json`, below) is left out. An agent not started at
  its version yet (`capabilitiesUnknown`) is asked too, in both imports, and left out once it
  says it cannot list (`CANNOT_LIST` in the error's data, as for an ACP agent that refuses
  `session/list` without a folder); one whose listing fails otherwise keeps its tab with the
  agent's words, Retry, from the page that failed when some were listed, and Sign in for one that
  asks for it. A Claude Code session a terminal holds fails with `reason: 'held'`, and the summary
  offers 复制一份, a copy imported with `fork`.
  What was listed keeps its title and times for `sessions.import`, which imports each as the
  sidebar does (adding its project if needed). A window's alone (`WINDOW_ONLY`): it names every
  folder an agent ran in, which a paired device otherwise learns only by naming a folder.
- `src/agent-host/agent-history-folder.ts` (+ `.test.ts`): another folder of an agent's kind,
  for the dialog's Choose folder… (`agentHistory.list` with `folder`, `agentHistory.planCopy`,
  `agentHistory.copy`), as a backup, a WSL home or a folder copied from another computer; the
  folders chosen last are kept per agent kind in the window's storage. Claude Code's: its
  configuration folder, `projects` or one project folder, read as above. Codex's: its home,
  `sessions` or a year, month or day folder, each rollout read up to its first prompt (at most
  1 MiB), compressed ones through `node:zlib`'s zstd, titles from the home's `session_index.jsonl`.
  An import copies each chosen session where the agent resumes it: Claude Code's transcript to
  `projects/<the cwd as Claude Code names it>/<id>.jsonl` with the files of its `<id>/` folder
  (subagents, tool results) that the agent's copy lacks, Codex's rollout to
  `sessions/<year>/<month>/<day>/` under its own name. Nothing is overwritten but a copy that
  holds less of the conversation (`compareTranscripts`; a byte prefix for Codex), kept as
  `.kite-bak-<time>` first; a fork, a whole rollout against a compressed one and a session whose
  folder is not here are left alone. The dialog shows every file first; the host runs only a plan
  it made, once, within 15 minutes, and leaves alone a file that appeared or changed since. The
  folder is checked in `validate.ts` (absolute, no `..` step, no Windows device path) and by the
  host (an existing folder, not the agent's own), and is only read. A WSL session's folder is a
  Linux path, so it shows as gone and is not imported into Windows' agent.
- `src/agent-host/claude-desktop.ts` (+ `.test.ts`): the Claude desktop app's Code sessions, the
  dialog's 「Claude 桌面版」 tab (`agentHistory.list` with `source: 'claude-desktop'` for a Claude
  Code agent), shown once the app's index holds a session. The app runs Claude Code itself (its own
  copy under `claude-code/<version>/`), with the configuration folder of `CLAUDE_CONFIG_DIR` from
  its own settings (kept encrypted, so not read), else the environment's, else `~/.claude`; it has
  no folder of its own for Code sessions, so their transcripts are under the agent's `projects/`
  like any Claude Code's. Its index is one JSON file per session under
  `claude-code-sessions/<account>/<organization>/local_<uuid>.json` in its data folder, found
  without naming a package suffix: Windows' Store app in
  `%LOCALAPPDATA%\Claude-Data\<package family>` (an older one virtualized under
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`), the installer's
  `%APPDATA%\Claude`, `~/Library/Application Support/Claude` on macOS,
  `~/.config/Claude` on Linux, and the `-3p` builds' beside them; `KITE_CLAUDE_DESKTOP_DATA` (a
  list of data folders) replaces the search, for a test copy. Of each file only the folder
  (`cwd`, `originCwd`, `folderPlace.cwd`), the Claude Code sessions (`cliSessionId`,
  `lastAssistantCliSessionId`), the title (`titleSource` `user` becomes the session's own title),
  the times (epoch ms as numbers or strings) and `isArchived` are read; `deleted_<uuid>` markers
  leave a session out, `archived-sessions.idx` (version 1 only) marks one archived. Each is listed
  as the Claude Code session whose transcript is in the project folder of the folder it runs in
  (of the two, the one written last), marked 找不到记录 without one, and imported through
  `sessions.import` as any Claude Code session by the Claude Code agent whose configuration folder
  holds the most of them (the page's `agentId`; the app's own `CLAUDE_CONFIG_DIR` is in its
  encrypted settings), deduped as that agent's own tab is. The app's title, times and archive are
  kept only for a session chosen in this tab (`sessions.import` with `source: 'claude-desktop'`,
  which `keptFor` reads); chosen in the agent's tab, it keeps its transcript's.
  A session in one of the app's scratch folders
  (`scratch-workspaces/<account>/<organization>/scratch-*`) is No project here, still running in
  that folder, so its transcript, resume and outside sync stay as they are: `Sessions` lets
  `ScratchFolders` adopt such a folder at import and at start (`adoptOutsideScratch`), unless it is
  a project here, and an adopted folder is never removed. One that went on in the project it
  started in imports under that project.
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
  implementations in `codex/connection.ts`, `acp/connection.ts`, `dsh/connection.ts`,
  `doubao/connection.ts`, `opencode/connection.ts`, `pi/connection.ts` (`listAllSessionFiles`)
  and `cline/connection.ts` (`session/list` of `cline/host-sessions.ts`).
- `src/agent-host/agents.ts` (`capabilitiesUnknown` in the status), `src/shared/agent-host.ts`.
- `src/agent-host/scratch.ts` (`adopt`), `src/agent-host/sessions.ts` (`adoptOutsideScratch`, and
  `importSession` adding no project for a scratch folder), `src/agent-host/host.ts` (the desktop
  app's folders, `adoptOutsideScratch` once loaded), for the Claude desktop app's sessions.
- `src/agent-host/sessions.ts` (`agentSessionIds`; `importSession` takes an optional `kept`, the
  title, times, pin and archive, and the `KeptField` type), `src/agent-host/host.ts` (the handler,
  and `sessions.import` taking over a listed session's title and times through `keptFor`; the
  Codex agents for memory).
- `src/agent-host/memory/service.ts` (`codexAgents`, Codex's sources in `importScan` and
  `import`), `src/shared/memory.ts` and `memory.import` (a source's `project` may be null: global
  memory), `features/settings/memory-rows.tsx` (a tick per source, its entries' titles, a source of
  global memory, and `MemoryImportDialog` for the summary).
- `src/agent-host/claude-copies.ts` (`compareTranscripts`), and for the folder picker
  `dialog:choose-history-folder` in `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`
  and `src/renderer/src/web/api.ts`, with `locales/*/main.json` and `locales/*/host.json`
  (`agentHistory`).
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

### Best of N (同时交给几个 Agent)

One message runs on 2 to 4 agents or models at once, after Cursor's `/best-of-n`. Each run is an
ordinary session in a new worktree cut from the branch New session shows (the worktree's copy
and setup command run as for any worktree session), and its record names its group
(`group: { id, title, size, kept? }`, which every run carries alike), so no store of its own
exists: the session list, its events and the phone get the groups for free.

- `src/shared/session-groups.ts`: the group reference, `RunChanges`, `runPhase` (working,
  waiting, done, failed) shared by the desktop and the phone.
- `src/agent-host/groups/`: `groups.start` (the runs at once, each with its own copy of the
  prompt's attachments, whose records a sent message releases; worktrees are made one at a time
  per project so their names stay distinct), `groups.changes` and `groups.fileDiff` (a run against
  its base commit, uncommitted and untracked files included, read only when asked), `groups.keep`
  and `groups.discard`. Paired devices may call them all; the host checks everything.
- Keep this merges the run's branch into the project's own checkout (`git merge --no-ff`, as a
  task's parallel branches are merged), after committing what the run left uncommitted to that
  branch. It is refused while the run works, once a run was kept, when that checkout is on no
  branch, amid a merge or rebase, or has tracked changes; a merge that conflicts is aborted and
  the run's commit taken back, so a refusal changes neither checkout.
- Archiving the other runs (offered after a keep, and from the page's note) commits what each
  left uncommitted to its branch, removes its worktree and archives it. Branches always stay, so
  no run's work is lost; they are deleted by hand.
- Desktop: the way-of-working menu's 同时交给几个 Agent and the runs' chips
  (`features/session/new-session/runs-bar.tsx`, `run-starts.ts`, `stores/best-of-n.ts`), the
  group page (`features/groups/`, a `group` page view), whose run cards read their changes again
  on each git status event of their worktrees, and the sidebar's group row
  (`features/sidebar/run-group-row.tsx`; `sidebarRows` folds two or more listed runs into it).
- Phone: `mobile/src/homeList.ts` folds a group's runs into one row where its loudest run would
  be (`components/BestOfRow.tsx`), opening to the runs' rows; a finished run's menu offers 保留这个.
- The fake agent's `/write [file] [text]` makes a real edit, to compare runs with.

### GitHub flow (议题、自动合并、盯 PR、GitHub 触发)

After T3 Code's Issues page, Conductor, Claude desktop's merge when ready and JetBrains Air's
triggers. Everything goes through the user's own `gh` (no auth of Kite's own) and only reads,
except the merge.

- `src/shared/github-flow.ts`: the inbox's issues, a session's linked issue and pull request
  automation (`SessionPrFlow`), the routine events (`GithubEvent`) and a run's cause.
- `src/agent-host/github-flow/gh-api.ts`: the `gh` calls and their mapping. REST reads go through
  `gh api --include` with the last ETag in `If-None-Match`; gh exits 1 on a 304, which is read
  from the status line. The merge is `gh pr merge <url> --squash|--merge|--rebase
--match-head-commit <oid>` (squash, else a merge commit, else rebase, as the repository
  allows), run outside any checkout so gh touches no local branch.
- `decide.ts` (pure, tested with recorded responses in `fixtures/`): merge only an open, not
  draft pull request whose checks all passed, which GitHub calls mergeable and CLEAN (or
  HAS_HOOKS), with no change requested and the session's agent idle; with no checks at all, two
  reads must find the same head ready. The watch tells the agent once per head of failing checks
  (names, links, `gh run view <run> --job <job> --log-failed`) and of a conflict (files from
  `git merge-tree` in the session's folder), and once per review or comment by someone other
  than the author; reviews and comments from before the watch began count as seen. Triggers:
  issues and pull requests opened after the trigger was armed; checks, pushes and a branch
  behind the default branch count from the first read on, each event once.
- `flow.ts`: the reads. Only repositories that a session's automation or an enabled routine
  trigger needs are read, one timer each, at most once a minute, at the git service's cadence
  (60 s while checks run, else 5 min), three times slower while no window shows
  (`host:windows-visible` from `watchWindowsShown` in `src/main/window.ts`), backing off after
  failures up to 30 min, and not at all while the computer sleeps. With nothing turned on there
  is no timer. The issue inbox is read when its page opens or on Refresh, never polled.
- Sessions: `issue` and `prFlow` in the session record (`seen` keys, `ended`); `setPrFlow`
  accepts only one of the session's pull requests. After a merge the session is archived, and its
  worktree removed (its branch kept) unless it has uncommitted changes, commits the merge lacks,
  or another session works in it; a note in the thread says what happened. Routine triggers'
  cursors live in `state/github-flow.json`; a routine on an event keeps its schedule for older
  clients, and a run on an event gets the event appended to its prompt.
- Desktop: the project menu's 议题 opens `features/issues/issues-page.tsx`; the session menus'
  检查通过后自动合并 and 盯着这个 PR, the top bar's issue and automation chips and the row's
  issue badge (`features/git/flow-chips.tsx`, `flow-model.ts`); the routine page's trigger
  (`features/routines/trigger-field.tsx`). Phone: the session's chips show the linked issue and
  the automation's state; routines show their event.
- Checking it without GitHub: a fake `gh.exe` (a C# launcher compiled with the .NET Framework's
  `csc.exe` that runs a Node script of recorded answers) first on the test copy's `PATH`, and a
  repository whose `origin` names a github.com repository nothing is pushed to.

### Task board (看板)

After Conductor 0.95's workspace board, Paradev and Nimbalyst: the user's own top-level sessions
sit in four columns of their own workflow, 待办 / 进行中 / 待审 / 完成 (`todo`, `in_progress`,
`review`, `done`), apart from what Kite marks by itself (working, waiting, done), which each card
still shows. A new session (forks included) starts in 进行中, and so does one from before the
board; an archived one leaves the board and keeps its column for a restore. A routine's runs, a
task's steps and sub-sessions are not on it.

- `src/shared/session-board.ts`: the columns, `SessionBoard` (`status`, and `at`, when it moved
  there, which orders a column the latest first) and `onBoard`.
- Host: `board` in the session record (`state/sessions.json`, parsed by `boardOf` in `storage.ts`)
  and in the summary (`boardOf` in `sessions.ts`, null for a session not on the board);
  `sessions.setBoardStatus` (validated in `validate.ts`; windows and paired phones alike) and the
  agents' `set_board_status` tool (`session-tools.ts`), which moves only the caller's own session.
  Kite's MCP instructions and the sessions guide topic tell agents to move theirs to review when
  their work is ready to check; `list_sessions` and `get_session` give `board_status`.
- Desktop: the Overview page's fourth view, 看板 (`features/task-board/`, chosen there rather than a
  sidebar entry so the nav keeps its rows and the page holds every view of the sessions), with a
  project filter (kept with the page's other choices in `kettu:overview`). Cards drag between the
  columns with `@dnd-kit/react` (`board-view.tsx`; a mouse press that moves, or Space), and their
  context menu sets the column too; `move.ts` moves a card at once and puts it back if the host
  refuses. Every read is a selector over the session list that returns a string (the columns'
  ids, the projects), so a card renders again only when its own session changes and a column only
  when its cards change; cards off screen skip layout (`content-visibility`). Sidebar rows carry
  the column's faint mark (`BoardRowMark`) and the session menus a 看板 › submenu
  (`BoardStatusMenu`, item `board` in `session-menu-model.ts`).
- Phone: a row's meta line says its column (`mobile/src/board.ts`, `SessionRow.tsx`), and the
  list's long-press menu and the session's title menu move it (`SessionActions.tsx`,
  `SessionMenu.ts`); flow `tools/huli/ios/sim/flows/85-board.yaml`.
- Measured in a test copy with 207 sessions on the board (development build): nothing runs at
  rest (0 ms of script in 10 s); while a card is dragged, frames stay under 7 ms; the drop itself
  takes one frame of about 34 ms.

### Worktree ports (KITE_PORT)

After Conductor's `$CONDUCTOR_PORT`: each session Kite makes a worktree for (New session's
worktree, a best-of-N run, a fork into a worktree of its own) holds a block of 10 ports that no
other live session holds, so the dev servers of parallel worktrees never collide. A sub-session
and a fork into the same worktree share their parent's block; a workflow task's worktree gets
none.

- The block is the first one from Settings › Git › 工作树端口 (`git.portBase`, 20000 by default,
  below every system's ephemeral range), on a step of 10, that overlaps no block a live session
  holds and none of whose ports can't be bound on 127.0.0.1 and on every address
  (`src/agent-host/worktrees/ports.ts`); Windows' excluded port ranges (Hyper-V, WSL) count as
  taken. Picks run one at a time, so runs started together never share a block. With no free
  block within 64 tries the session gets none and the log says so.
- It is kept in the session record as `ports` (`{ first, count }`) and held while the session is
  live: archiving it, removing its worktree or deleting it lets the block go. A restored session
  takes its block back unless a session of another worktree holds part of it meanwhile; then it
  shares its worktree's other block or gets a new one. Blocks survive a restart with the index.
- The worktree's setup command sees `KITE_PORT` (the first port) and `KITE_PORT_COUNT` (10),
  beside upstream's `KETTU_PROJECT_PATH` and `KETTU_WORKTREE_PATH`; the names follow Huli's own
  `KITE_*` variables. Claude Code sessions, each a process of its own, get both in their
  environment (`SessionOptions.env`), so their shell commands see them; agents whose process
  serves several sessions (Codex, ACP agents) cannot, and read the block from `get_session`'s
  `ports` (the sessions guide topic says so). A setup command that writes `.env` from them is the
  sure way for every agent: `echo PORT=%KITE_PORT% > .env` on Windows, `echo "PORT=$KITE_PORT" >
.env` elsewhere.
- Shown in the tooltip of the session's worktree chip and row mark (`WorktreeHint`) and on the
  row's card: 端口 20000–20009（KITE_PORT）.
- Tests: `worktrees/ports.test.ts` (no overlap, steps past ports in use, a block back once let go,
  the probe), `sessions.test.ts` (sessions started together, the setup command's and the agent's
  variables, archive, restart and restore), `storage.test.ts` (the stored block and column).

### Risk levels and auto-approve (风险等级、自动批准低风险操作)

After Codex's risk before an action, Kiro's Approve for me and Claude Code's auto mode, without
a model: every permission request gets a level (低, 中, 高) and a one-line reason from a pure,
deterministic classifier, and the user may have the host answer low ones by itself.

- `src/agent-host/risk/`: `shell-words.ts` reads a command line as a POSIX shell, PowerShell or
  cmd.exe would (redirections, wildcards, `2>&1` and the null device; expansions, subshells,
  here-documents and anything unclear are refused), `places.ts` places a path (the project or its
  worktree, its `.git`, elsewhere, the system's folders, or a credential such as `.env`, `.ssh` or
  `*.pem`; Git Bash's `/c/...`, drive-relative and UNC paths, case-insensitively on Windows),
  `command.ts` judges each step by its program, and `classify.ts` judges requests (`RiskSubject`:
  a command, reads, edits, a fetch, an MCP tool, a sandbox grant) and decides `autoApproves`.
  Low: reads in the project, read-only programs and the project's tests, checks and builds run in
  the project. Medium: edits in the project, installs, the network, scripts. High: whatever
  `command-safety.ts` calls unsafe, deleting, Git's push/reset/rebase and the like, writes
  elsewhere, keys and system files, programs it does not know, lines it cannot read. A shell of
  unknown kind on Windows is read as all three and the highest kept. `risk.test.ts` holds the table.
- Drivers say what the tool entry cannot (`PermissionRequest.subject`): Claude Code's tool and
  its shell (Bash or PowerShell), MCP tools by server, Codex's command, `cwd`, network requests and
  sandbox grants; every other agent's request is read from its tool entry.
- `sessions.ts` puts `risk: { level, reason }` on `PendingPermission` (cards, the phone, the
  notification's line, the chat bridge) and, when the setting allows, answers `allow_once` itself:
  `permissionResult.by === 'risk'`, folded as work with 已自动批准 · 低风险, and counted on a folded
  run's line. Never a medium or high request (except, at the edits level, an edit inside the
  project outside agents', editors', hooks' and CI's settings), never in plan mode, never a
  routine's run, never an `allow_always` option.
- Setting: `permissions.autoApprove` (`off`, `low`, `edits`; Settings › Agents › 批准), and each
  project's own in `projects.json` (`autoApprove`, the project menu's 自动批准; absent keeps the
  default). `projects.setAutoApprove` is the windows' alone, so neither a paired device nor a chat
  bridge can widen it, and agents' settings tools may only read the row. The edits level asks to
  confirm.
- Limits: string work only, so a link inside the project that leads out is not seen; running the
  project's tests runs its code, which edits allowed by the agent's own mode (or the edits level)
  may have changed.

### Backup

A daily backup of Kite's own data folder into one zip a day, and restoring one: Settings › Backup,
this computer's alone (the web client has none). Claude Code's `~/.claude` has a backup of its own
and is not part of it.

- What it keeps and leaves out is `src/main/backup/plan.ts`: the settings, `state/` (the thread
  and usage databases, sessions, projects, agents, routines, workflows...), `memory/`,
  `artifacts/content/`, the threads' media under `state/thread-media/`, `attachments/`, themes,
  workflows and what the Marketplace installed. Left out: `remote/` (this computer's keys, its Kite
  Cloud sign-in and paired devices, encrypted by the system for this user here, so a copy opens
  nowhere else, and plain text on Linux without a keyring), `market-keys.json` and
  `published-artifacts.json` (keys and tokens, encrypted the same way), `agent-network/` (the
  subscriptions' tokens and nodes' passwords in plain text), and what is rebuilt or fetched again:
  the search index, thumbnails, the Marketplace's caches, logs, reports and Chromium's folders.
  A restore leaves all of those as they are, so pairings and the sign-in carry on.
- A backup runs in a utility process of its own below normal priority (`worker.ts`). The databases
  are copied with SQLite's `VACUUM INTO`, a consistent copy of a database the agent host has open;
  the content folders they name (`state/thread-media/`, `artifacts/content/`) are copied before
  them and topped up after, so every file a copy names is in the zip; one no copy names does no
  harm. The zip
  (`zip.ts`, streamed, zip64 past 4 GiB) is written as `Kite-backup-<local time>.zip.partial` and
  renamed once whole, with `manifest.json`: the app's version, when, each database's schema
  version, and each file's size and SHA-256. Then the oldest `Kite-backup-*.zip` past the count go; nothing else in the folder is
  touched.
- Main keeps the schedule (`service.ts`, `schedule.ts`) and the last runs in `backup-state.json`
  (never in a backup). A day whose time passed while the computer was off or Kite was closed is
  made up once, five minutes after the next start; while the agent host starts or reports
  `host:migrating` (`src/agent-host/migration-watch.ts`: its thread database opening at a new
  schema, then schema 9's pictures moving out into files), a backup waits ten minutes and looks
  again, a day at most, since the copy is consistent mid-move too. The default folder is
  `Documents\Kite 备份`; a development run uses `<data folder> backups` beside its own data folder.
  The folder and the file to restore come from main's dialogs; the page sends only a token.
- Restore (`restore.ts`) runs between stopping the hosts and starting again, through the quit
  flow's restart (`QuitFlow.restart(relaunch, afterStop)`), which asks first while agents work. It
  checks every file of the backup against its manifest's SHA-256 while unpacking it beside the
  data, saves the data in place as `Kite-before-restore-<time>.zip` in the backup folder (never
  pruned), then swaps what the backup covers by renames, moving everything back if one fails. The
  databases' journals, the search index and thumbnails go, to be rebuilt. Every file is in place,
  the media with the database that names them, before the app starts and opens the database.
- Settings: `backup` in `src/shared/settings.ts` (on, 03:00, 7 kept, the default folder), checked in
  `settings-schema.ts`; the folder is set only through the dialog (`setBackupFolder`), and a patch
  may only clear it. IPC: `backup:*` in `src/shared/ipc.ts`, `registerBackupIpc` in
  `src/main/ipc.ts`, `backup` in the preload. Page: `features/settings/backup-section.tsx`,
  `backup-rows.tsx`, `stores/backup.ts`; Advanced › Data has a row beside Storage that opens it.
  Tests: `src/main/backup/backup.test.ts`,
  `src/main/settings.test.ts`, `src/agent-host/migration-watch.test.ts`.

### Session export

Export… in a session's menus (the row's and the top bar's More) saves the session as Markdown
with its pictures in a `<name>.assets` folder beside it, the same in a zip, or a PDF; the dialog
remembers the format and what to include: the agent's thinking, each tool call's full input and
output, and the sub-agents' sessions. The desktop app's alone (`window.kettu.exportSession`).

- The page reads the whole thread and its pictures from the session's host, so a session of
  another computer exports too, and builds the Markdown with `src/shared/session-export.ts`
  (pure): the title and facts, each speaker's messages, a tool call as one line with its diffs as
  fenced `diff` blocks (paths relative to the session's folder), plans, questions with their
  answers, and the folded parts as `<details>`. Pictures are linked as `kite-export-asset:` names.
- Main (`src/main/session-export/`) checks the request (`request.ts`), asks where with its save
  dialog, masks secrets as the logs do (`mask.ts`: the log's redactor, but a value after a
  secret-like name masked only when it reads as a secret, so `token: Token` in code stays, and
  `‹redacted›` for the mark, which a Markdown viewer would hide as a tag), points the pictures'
  links at where they land, and writes. The PDF is `html.ts`'s page, every piece of text escaped
  but the export's own folds, links to http(s) only and pictures only the export's own, printed
  by Chromium in a hidden window with no script, in light colors whatever the theme.
- Tests: `src/main/session-export/session-export.test.ts`.

### Agent reset

Settings › Agents › an agent › Reset environment… puts an agent back the way a fresh install finds
it, for one whose sign-in is stuck or whose state broke: (1) its sign-in and credentials, the keys
Kite handed or keeps for it included; (2) the anonymous ids it made on this computer, which it
makes again on its next start; (3) its caches, logs and temporary files. Its history (Claude Code's
`projects/` and `history.jsonl`, Codex's `sessions/`, `history.jsonl` and thread databases,
Antigravity's `conversations/` and `brain/`, Kite's own sessions) and its configuration
(`settings.json`, `config.toml`, `CLAUDE.md`/`AGENTS.md`, skills, agents, commands, plugins, MCP
servers, memories, per-project permissions) always stay. It is no machine-wide wipe and touches no
system identifier (MachineGuid, MAC addresses, hardware ids).

- The host's `agents.resetPreview` lists what is there now, with sizes (names and key names, never
  contents), and `agents.reset` removes the categories ticked (`src/agent-host/validate.ts` checks
  both). It refuses while a session of the agent works; otherwise it runs the agent's own sign-out
  first where Kite has one (`codex logout`, `claude auth logout`, ACP `logout`), then lets the
  agent's sessions go (prepared ones removed, idle ones stored and closed), stops its process and
  keeps it stopped (`resetHold`), and removes the rest. It logs what went by category, paths and
  key names only. The window clears the keys Kite keeps for the agent (`setAgentEnv`).
- `src/agent-host/agent-reset/plan.ts` holds every path and key, from the agents' own code: Claude
  Code 2.1.326's bundled source (config folder `CLAUDE_CONFIG_DIR` or `~/.claude`; `.claude.json`
  in the home folder unless the folder was moved; its keychain services `Claude Code-credentials`
  and `Claude Code`, suffixed `-` and 8 hex of the SHA-256 of the variable's value as given when
  moved; Credential Manager `<service>/claude-code-user` and its `#` parts, as Bun.secrets names
  them, behind a flag), Codex 0.171's source (`auth.json`, `.credentials.json` for MCP sign-ins,
  three files of `secrets/` but not `local.age` or the passphrase they share, `installation_id`,
  the keyring entry `cli|<16 hex of the SHA-256 of the canonical folder>` under `Codex Auth`),
  agy 1.5.13's binary (go-keyring's `gemini`/`antigravity`, shared with the Antigravity app,
  `~/.gemini/antigravity-cli/installation_id`, its logs and caches), and Pi, Cline, DimCode and
  OpenCode's sources where they are sure; the others offer only their sign-out and Kite's keys.
  `.claude.json` and its backups lose only the keys named (`json-keys.ts`: every other byte kept,
  a file that does not parse left alone, written beside it and moved over it).
- Left alone on purpose: what every Claude Code shares whatever its folder (`%TEMP%\claude`,
  `claude-cli-nodejs` logs, `~/.claude/.device-keys.json`), Codex's MCP keyring entries (keyed by
  server, shared by every Codex folder), its Windows sandbox users and ACLs, and the Codex and
  Antigravity desktop apps' own files.
- `secrets.ts` reaches the Keychain with `security` (never `-w`/`-g`), Credential Manager with
  `cmdkey` (a name quoted after its switch; cmdkey exits with 0 even when it deleted nothing, so
  the list says whether it did) and the Secret Service with `secret-tool` (output thrown away). A
  test copy (`KITE_TEST_WINDOW=background`, unpackaged) uses names in `<data>/test-secrets.json`
  instead, so its reset reaches none of the owner's entries.
- The phone's agent page opens the same list as a page of its own
  (`mobile/src/app/settings/agent-reset.tsx`), which clears Kite's keys for the agent through
  `marketplace.setAgentEnv`.
- Tests: `src/agent-host/agent-reset/*.test.ts`, and the requests in `validate.test.ts`.

### Removing an agent from the computer

Settings › Agents › an agent › Remove… takes the agent out of Kite as before, and offers two more
options: uninstall its program from the computer the way it was installed, and (off by default)
delete its own data there. The host's `agents.removalPreview` plans both, with sizes; the dialog
lists every command, folder and file, and `agents.removeFromComputer` takes the steps the user
saw, by id (`part:kind:path`), which the host plans again and runs only where they match, so no
path or command a client sends is ever used (`src/agent-host/validate.ts` checks both). Like the
reset, a run is refused while a session of the agent works; otherwise its sessions are let go and
its process stopped, every process of the harness for its program, and each step's start and end
go to the asking port as `agents.removalProgress`. Files and folders go to the system's trash
through main (`host:trash-call`) unless the user unticks it; the daemon has none, so a step fails
there and the dialog's Try again runs it without. The agent leaves Kite when the dialog closes, and
an uninstall marks the harness `uninstalled`, as Settings › Harness's own uninstall does.

- Program (`agent-removal/program.ts`): Kite's own installs for the harness, `<harnesses>/<id>`,
  always go. The user's program goes by where it lives (its path and its launcher's, a `.cmd`
  shim's target on Windows): `npm uninstall -g --prefix <the prefix it lives under> <package>`
  (npm's `.cmd` on Windows, through cmd.exe, so a prefix with `%`, `!`, `"` or a control character
  is refused), `brew uninstall [--cask]` by its keg or cask folder, `winget uninstall --id <id> -e`
  by its `WinGet\Packages\<id>_` folder, `uv cache clean` for uvx, and the files a vendor's own
  installer wrote, where its docs or script say which: Claude Code `~/.local/bin/claude(.exe)` and
  `~/.local/share/claude` (the docs' Uninstall; on macOS and Linux the launcher only when it links
  into it), Codex's install.sh `$CODEX_HOME/packages/standalone` and its links in the bin folder
  (never `packages/app-server-daemon`), agy's install.sh/install.ps1 `~/.local/bin/agy` or
  `%LOCALAPPDATA%\agy\bin\agy.exe`, OpenCode 2's `~/.opencode/bin/opencode` and `opencode2`, and
  Doubao's runtime `<data>/doubao_cli/app` beside its npm package. Anything else (a program the
  user built or moved, a copy inside an app such as Antigravity's `agy`) is left, with its path and
  how to remove it by hand. Nothing is offered while other agents run on the same harness.
- Data (`agent-removal/data.ts`): the reset's folders taken whole, with the credential store
  entries the reset names: Claude Code's folder, `.claude.json` and its backups (its
  `.device-keys.json` kept while other Claude agents remain); Codex's folder but `packages` and, on
  Windows, its sandbox accounts' files; agy's `~/.gemini/antigravity-cli` (the Antigravity app's
  folder, sign-in and older token kept); dsh's folder (never `~/.agents`); Doubao's data folder but
  its program; Pi, Cline, DimCode, Codebuddy and OpenCode's XDG folders; an added agent's own
  folder. The dialog says where Claude's apps and the Codex app share the folder. The other
  agents' places come from their own docs and code, with sources and dates at the top of
  `data.ts`. Where the vendor ships an uninstall that deletes the data, that command runs with the
  agent's own CLI and environment, before any program step, and the dialog shows its line and,
  once it ran, its last lines of output: `devin uninstall --clean --force`, `kilo uninstall
--force`, `hermes uninstall --data --yes` (never over a folder the Hermes IBC relayer keeps keys
  in), `nova uninstall --force` (only over `~/.nova`, never `~/.compass`), CodeWhale's `uninstall
--yes --purge-data` for its receipted install, `cursor-agent logout` and `stakpak autopilot down
--uninstall`; a note says what else it takes, such as the program or what Devin Desktop or
  Kilo's extensions share. Otherwise Kite deletes what is provably the agent's own: Muse Code's
  XDG `muse` folders, CodeWhale's, siGit's, the GLM agent's, fast-agent's, VT Code's but its
  desktop app's, Stakpak's but `plugins`, OMP's but its worktrees, Poolside's and Minion Code's
  own files, Harn's caches, amp-acp's, and the Cursor CLI's own files in the editor's `~/.cursor`.
  A folder another program shares (Gemini CLI's, Qwen Code's, Grok's, Copilot's, goose's, Kimi
  Code's, MiniMax Code's, Junie's and the others the header lists) is never planned: the dialog
  names it and who shares it, and deletes nothing. An agent that keeps nothing, or whose folder is
  not there yet, has no data on this computer. Kite's own sessions of the agent stay.
- `agent-removal/guard.ts` checks every path as it is planned and again as it goes: inside the
  agent's folders, never a drive's root, the home folder or above Kite's data, the harnesses and
  the system's folders, and never at or above another agent's folder.
- Tests: `src/agent-host/agent-removal/*.test.ts` (fake disks of each platform, temp folders, a
  fake npm through cmd.exe), and the requests in `validate.test.ts`.

### Deleting the agent's own copy

A session deleted in Kite is deleted from the agent's own history too, so neither its own CLI and
app nor Import from agents bring it back. `src/agent-host/agent-copies.ts` (+ `.test.ts`,
`agent-copies-host.test.ts`) removes what the agent keeps past its own delete, only names that are
exactly the session's id, inside the agent's own folder; a link is removed as a link and never
followed. The log names the paths removed, never contents.

- Claude Code: the SDK's `deleteSession` (0.3.326) removes `<id>.jsonl` and `<id>/` from one
  project folder only. Kite then removes, under the agent's configuration folder, `<id>.jsonl`,
  `<id>/` and its own `<id>.jsonl.kite-bak-*` backups in every `projects/*/` (copies the Claude
  app left when it continued the session elsewhere), and Claude Code 2.1's per-session
  `file-history/<id>/`, `session-env/<id>/`, `tasks/<id>/`, `uploads/<id>/`, `todos/<id>*.json` and
  `debug/<id>.txt`. `history.jsonl` (prompt history, shared lines) stays.
- Codex: `thread/delete` (0.171) removes the rollout, its state rows and its `session_index.jsonl`
  entries itself; nothing is left to import, so Kite adds nothing.
- DeepSeek Harness (dsh 0.2.2, no delete in its SDK or ACP mode): under its home (`DSH_HOME` or
  `~/.dsh`), `sessions/--<project>--/<id>/` in every project folder and
  `storages/session_projcache/sessions/<id>.json`, and the same of the subagents' sessions its log's
  `subagent/catalog` rows name, each only when its own header names that parent. Its workspace
  registry (`storages/workspace.json`) drops a session whose log is gone as it loads, so it stays.
- Doubao CLI (2.37.2) has no delete or archive and keeps every conversation on its servers, where
  the app and `doubao --list` still show it. Such a session, and any whose copy stays (an ACP agent
  without `session/delete`, a removal that failed), goes into `state/deleted-sessions.json`
  (`deleted-sessions.ts`, + `.test.ts`: agent and id, at most 10,000, the oldest dropped first),
  and neither import offers it again; importing it by its id (`sessions.import`) takes it back.
- Antigravity (agy 1.5.13, no `session/delete`): in `~/.gemini/antigravity-cli` and the app's
  `~/.gemini/antigravity`, under the home folder agy runs with (`USERPROFILE`/`HOME` of its
  environment), `conversations/<id>.db` with its `-wal`/`-shm`, `brain/<id>/`,
  `annotations/<id>.pbtxt`, its row in `conversation_summaries.db` (through SQLite), its entries in
  the summary stores agy syncs that database from at every start (`jetbox_summaries_proto.pb`, the
  app's `agyhub_summaries_proto.pb`: maps keyed by the id as field 1, dropped entry by entry, a
  file of another shape left alone) and in `cache/conversation_metadata.json`; the same for its
  sub-agents' conversations (rows naming it as parent with `nesting_depth > 0`). agy lists only
  conversations whose `.db` is there. `implicit/` holds editor activity under ids of its own and
  stays. A `.db` another agy process holds open cannot be removed on Windows: that conversation is
  left whole and tried again 6 s later (past the session router's kill), then 20 s later, and once
  more as the host stops after its agents; a pass after a removal also catches a summary agy wrote
  back as its process exited. Checked against agy's own `session/list` on a copy of `~/.gemini`.
- A prepared session (New session) or a hidden options session of agy that Kite lets go before its
  first prompt leaves an empty conversation; it goes the same way, unless agy's summary shows
  steps.
- Hooks: `Sessions.delete` (and `deletedIds`, `listImportable`, `importSession` for the deleted
  ones) and `dropPrepared`/`removeLeftovers` in `src/agent-host/sessions.ts`,
  `readInHiddenSession` and `deletesCopy` in `agents.ts`, the service in `host.ts` (flushed at
  shutdown), `AgentStatus.deletesCopy` in `src/shared/agent-host.ts`; the delete confirmations in
  `features/sidebar/session-menu.tsx` and `mobile/src/components/DeleteSessionDialog.tsx` say so
  (`row.deleteRemovesAgentCopy`), keeping `row.deleteKeepsAppCopy` for an agent whose copy stays;
  `FAKE_AGENT_UUID_IDS` in `tools/fake-agent`.

### DeepSeek Harness's sign-in and balance

dsh signs in through its own page (`dsh web`, which never exits), so neither the agent nor a
finished terminal told Kite of a sign-in, and an agent page read while dsh was not running stayed
at 「登录方式 — 未提供」. The agent host now reads the route itself from the home's files
(`$DSH_HOME/.credentials.yaml`, else `~/.dsh`): at start, on the agent page, the model menu and the
background limits read, and whenever the file changes (`dsh/credentials-watch.ts`, the home
watched from its parent until dsh makes it). A DeepSeek account shows as 登录方式 DeepSeek 账号 with
the phone or email DeepSeek masks, a key as DeepSeek API key, another provider's route as 自定义模型服务商,
and neither as signed out, so the sidebar's notice and New session agree. DeepSeek's own routes,
which dsh lists signed in or not, no longer count as another provider's (`reportedRoute`).

The balance shows in 套餐用量, in the model menu's last row (`余额 ¥…`) and on the phone's 余额 group:

- Account sign-in: what dsh's own `@deepseek-ai/dsh-deepseek-account` (0.2.2-rc.5) asks, `GET
https://platform.deepseek.com/api/v0/users/get_user_summary` (`normal_wallets` topped up,
  `bonus_wallets` granted, decimal strings) and, once per sign-in, `/auth-api/v0/users/current`
  for the masked contact, with the grant's token in `x-dsh-auth-token` and dsh's client headers.
  A grant whose issuer is not `https://platform.deepseek.com`, or dsh's mock one, is never sent.
- API key: `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer`.

Both go through `askVendor` (HTTPS to the listed origin only, no redirects, a bounded reply,
errors that quote nothing). The token and key are read for the request and dropped; only a short
hash stays in memory to tell a new sign-in. A read is due at most once a minute (10 s when the
user presses refresh); a file change reads DeepSeek only for a new sign-in. A refused token keeps
the last balance with 「DeepSeek 不再接受这次登录」; dsh itself drops a refused grant, and the watch
then signs the agent out.

Huli's own files: `src/agent-host/dsh/account.ts`, `credentials-watch.ts`,
`src/agent-host/vendor-usage/deepseek.ts` (+ tests and scrubbed `fixtures/deepseek-*.json`),
`features/settings/agent-balance.tsx`. Hooks: `dsh/credentials.ts` (`readAccountGrant`, the home's
`.env` key), `dsh/connection.ts`, `dsh/options.ts`, `agents.ts` (`refreshBalance`, `readBalance`,
the start's read), `ProviderBalance.granted` in `src/shared/agent-host.ts`, `agents-section.tsx`,
`model-menu.tsx`, `composer.tsx`, `new-session.tsx`, `mobile/src/app/settings/agent.tsx`,
`mobile/src/ui/session/limits.ts`, and `dsh.account`/`dsh.balance`, `agents.balance`/`agents.phone`
and `controls.balance` in the locales.

### Plan usage and balances

What the agent page, the model menu, the usage page and the session's usage show beyond upstream's
reads (checked on 2026-11-21):

- OpenCode's providers, with the key OpenCode stores, over HTTPS to the listed vendor only (no
  redirects, a bounded reply, one generic error), at most every minute and every 10 s when the user
  presses refresh: OpenRouter's `GET https://openrouter.ai/api/v1/key`, the key's own limit as a
  window (its `/api/v1/credits` takes a management key, which OpenCode never holds); SiliconFlow's
  `GET https://api.siliconflow.cn/v1/user/info` (`siliconflow-cn`, yuan) and `api.siliconflow.com`
  (`siliconflow`, dollars), `totalBalance` with `balance` as the granted part when the parts add
  up; DeepSeek's `/user/balance` through dsh's parser, its granted part kept; Z.AI's and Zhipu's
  quota rows, the newer `CREDIT_LIMIT` ones too (`vendor-usage/glm.ts`).
- GLM Agent (glm-acp-agent 1.16.0 and later): its own ACP extension `_glm/usage`, which it
  advertises in its capabilities and answers with the key it keeps, so Kite never reads that key.
  Its 5-hour and weekly windows show; the MCP allowance is left out, as a used-up one stops no model.
- Copilot: `account.getQuota`'s `quotaSnapshots` (`entitlementRequests`, `usedRequests`,
  `resetDate`), as `@github/copilot-sdk` types it, and GitHub's own `quota_snapshots` and
  `quota_reset_date`.
- Claude Code: a limits read that fails on a subscription is a `LimitsReadFailed`, which the page
  shows, instead of no windows that kept the last ones as current.
- A window without a reset date (Junie's, Qoder's, Auggie's monthly ones) holds for one period from
  when it was read, a month when the period is not known (`limitHolds` in
  `src/shared/plan-limits.ts`), then leaves the status, the plan quota and the restart's windows.
- The balances beside the windows and DeepSeek Harness's balance are kept in `state/agents.json`
  with when they were read, and show as an earlier run's (`balancesStale`, a `stale` balance) until
  a read replaces them; a sign-out, a gateway or new credentials clear them with the windows.

Huli's own files: `src/agent-host/vendor-usage/glm.ts` (+ test) and the scrubbed fixtures
`openrouter-key.json`, `siliconflow-user-info.json`, `copilot-get-quota.json`, `glm-usage.json`
and `zai-quota-limit.json`. Hooks: `opencode/provider-usage.ts`, `vendor-usage/copilot.ts`,
`agents.ts` (`readGlmLimits`, `setBalances`, `PROVIDERS_FORCED_MS`, the restore), `agents/glm.ts`,
`claude/connection.ts`, `connection.ts` (`LimitsReadFailed`), `storage.ts` (`RememberedBalances`),
`dsh/account.ts`, `src/shared/agent-host.ts` (`balancesAt`, `balancesStale`, `stale`),
`src/shared/plan-quota.ts`, `agent-parts.tsx`, `agent-balance.tsx`, `agent-providers.tsx`,
`composer/usage.tsx`, the renderer's window filters, and `agent.glmUsage`/`agent.limitsReadFailed`
and `agents.usageNoReset`/`agents.balance.kept` in the locales.

### Agents in a terminal

An agent's own CLI, its interactive UI rather than the protocol Kite speaks, runs in a terminal of
Kite's: 在终端中启动 on an agent's page (in the folder the pane in focus works in, else one picked
with Open project's dialog), 在终端中启动 Agent › in a project's menu, and 在终端中继续 in a
session's menus, in its folder. 复制继续会话的命令 copies the same resume after
`Set-Location -LiteralPath '<folder>';` on a Windows host (PowerShell, whose 5.1 has no `&&`) or
`cd '<folder>' &&` elsewhere, by the host's platform.

- The agent host writes every line (`src/agent-host/agent-terminal.ts`): the user's CLI as found on
  PATH (`InstalledCli.launcher`, npm's `.cmd` shim on Windows, where PowerShell refuses the `.ps1`;
  Doubao's launcher, which offers its updates), a package Kite installed as `node <entry>`, a
  program as detection found it; the arguments the definition's `terminal` names, from each CLI's
  reference (checked on 2026-11-21); the configuration folder's variable as the sign-in sets it, a
  session's own folder (`configDir`) for a resume, and an added agent's `addedEnv`. A resume id
  is one line of an id's characters (or Pi's session file), and a line with a control character is
  never written.
- It runs only lines the agent host allows: `host:auth-commands` now lists each agent's start
  (`AgentStatus.terminal`) beside the sign-ins, and `sessions.terminalCommand` with `run` adds that
  resume for 2 minutes (`TerminalGrants`, the newest 32); the terminal host presses Enter only for
  a line on the list exactly, typing any other without it. The request takes a session id alone,
  refuses a sub-agent's session and one at work here, and lets the session go first, so two
  processes never hold it.
- Resumes: Claude Code `--resume <id>`, Codex `resume <id>`, Doubao `--resume <conversation>`,
  Gemini CLI and Qwen Code `--resume <id>`, OpenCode `--session <id>`, agy `--conversation <id>`,
  Pi `--session <file>`. Starts only: DeepSeek Harness (`dsh --profile web`: dsh ships no terminal
  UI, so its own web UI opens in the browser), Copilot, Cursor, Kimi, Kilo, goose (`goose session`),
  Grok, Droid, Cline, Auggie, Codebuddy and Qoder, whose resume ids no source ties to their ACP
  sessions'.
- A Claude Code session resumed so is followed shown or not until its CLI lets it go (`inTerminal`
  in `sessions.ts`): held while the CLI works, open in a terminal while it waits, and what it wrote
  comes in as each turn ends, as for any terminal's. Kite follows no other agent's CLI: their turns
  go on in the agent's own history, which Kite's thread shows only after an import.
- The fake agent's `--terminal [--resume <id>]` (`tools/fake-agent/terminal.ts`) stands in for a
  CLI. It runs on the `node` of the terminal's PATH (`nodeOnPath`): Electron's own is a Windows GUI
  program, which PowerShell does not wait for, so the shell would take its input.
- Tests: `agent-terminal.test.ts`, the allow-list in `terminals.test.ts`, `validate.test.ts`.
- Hooks: `catalog.ts` (`TerminalCli`), the agents' definitions, `agents.ts` (`terminalOf`,
  `resumeCommand`, `sendRunnable`), `installed-cli.ts`, `sessions.ts` (`terminalTarget`,
  `resumingInTerminal`), `host.ts`, `validate.ts`, `src/shared/agent-host.ts`,
  `host-request-limits.ts`, `features/agents/agent-terminal.ts`, `agents-section.tsx`,
  `project-menu.tsx`, `session-menu(-model).ts(x)` and `locales/*/{host,settings,sidebar}.json`.

### File preview on the phone

A document an agent made on the computer opens on the phone with a tap: PDF, Word, Excel and
PowerPoint files, Keynote, Pages and Numbers, RTF, OpenDocument, EPUB, pictures, audio, video and
zip archives, in Quick Look on iOS and in the app that opens it on Android. Text and code keep the
app's own viewer.

- `files.readBytes` (`src/shared/files.ts`, `src/agent-host/files.ts`, `agent-files.ts`): up to
  4 MiB (`FILE_BYTES_PART`) of a file from an offset, with the file's size and mtime and the part's
  SHA-256, of files up to 100 MiB (`FILE_BYTES_LIMIT`); a larger one answers `too-large` and is
  not read. A project's file is checked as `files.read` checks one (relative, no `..`, its real
  path inside the project, so no link leads out), an agent's own file as `files.readAgentFile`
  does, and `validate.ts` takes one or the other, never both. With `expect`, the first part's
  stamp, a file that changed since answers `changed`, as one that changed while a part was read
  does. Paired devices may call it, as nothing in `allow-list.ts` keeps it from them; the result's
  bytes reach a device as a byte stream inside the encrypted channel, over the network, Tailscale
  or the relay alike, and the request log counts it among the reads.
- `src/shared/file-download.ts`: a client's download through it, 1 MiB at a time with three parts
  asked ahead, each checked against its hash, offset and length before it is written in order; a
  file that changes meanwhile starts over, twice at most.
- `mobile/src/preview/`: `preview.ts` downloads into the cache through expo-file-system's
  `FileHandle` (never the whole file in memory) with expo-crypto's SHA-256, then opens it with
  expo-file-system's own `File.preview()`, Quick Look's `QLPreviewController` on iOS and an
  `ACTION_VIEW` intent on a `content://` URI on Android, and a PDF Quick Look declines in a web
  view of the copy (`app/pdf.tsx`); it shares through React Native's `Share` on iOS and
  `HuliShare` on Android. `cache.ts` keeps each copy under a hash of the computer, the
  folder and the path (`<cache>/huli-preview/`): one whose size and mtime the computer still
  reports opens at once, and while the computer cannot be reached (or takes over 4 s to say) it
  opens with a note that it may be old; copies not opened for a week go, then the oldest past
  512 MB. `kinds.ts` names the extensions that open in the viewer and their MIME types.
  `PreviewSheet.tsx` is the sheet a download that takes over 350 ms shows, with its progress and
  取消, and why a file could not open, with 重试 or 用其他 App 打开 / 分享.
- `mobile/modules/huli-system/android/` (`HuliShareModule.kt`): Android's share sheet for a file
  by expo-file-system's content URI, which React Native's `Share` cannot hand over there.
- Where a file opens: `openFile` (`ui/session/fileRefs.tsx`) sends a document to the viewer and
  anything else to the file screen, so file links and paths in replies and prompts, mentions and
  carried references follow it. A tool call's card lists the files it read or wrote
  (`toolFiles`), the turn's changed files open the file at the end of their row, the Files browser
  and the changes list open documents and offer 用系统预览打开 and 用其他 App 打开 / 分享 on a long
  press, the file screen offers the viewer for a binary, media or too-large file and sharing for
  any, and a binary diff offers the viewer. The session screen reads its folder's files again as a
  turn ends, so a file the turn made is a link in its reply; a session with no project lists the
  files of its own folder, as the desktop does.
- Tests: `validate.test.ts`, `files.test.ts`, `agent-files.test.ts` and `file-download.test.ts`.
  The fake agent's `/documents` writes a PDF, a Word document and a 24 MB PDF for the simulator's
  `60-preview` and `61-preview-word` flows and the emulator's `preview` (see Workflows).

### Comments on a diff's lines

The lines of an agent's diff take comments that go back to the agent together, as Claude
desktop, Warp, Conductor and Vibe Kanban have them. On the desktop it is the Files pane's diff,
whichever way it opened (the Changes list, a turn's changes card, the branch popover); on the phone
the diff screen, for a working-tree or commit diff and for a turn's or a tool's edit.

- `src/shared/diff-notes.ts`: a note (file, commit, the lines' numbers on one side or none for an
  edit's partial diff, up to 40 quoted lines with their `+`/`-`/space mark, the comment), its
  check for stored drafts, and the message they go as: for each, `path:start-end`, the quoted
  lines in a `diff` fence, the comment. The desktop words it in the interface's language
  (`files:notes.message.*`), the phone in Chinese.
- Kept in the session's draft beside its text and attachments (`notes`): the desktop's
  `composer/drafts.ts` (`draft:<session id>` in localStorage), whose `clearDraft` on a send now
  leaves them and `forgetDraft` drops them with a deleted session, and the phone's `drafts.ts`,
  whose composer writes leave them. At most 50 a session.
- Desktop (`features/diff-notes/`): a + by the line number the pointer rests on (120 ms), or
  Comment for lines picked by their numbers, opens a box under the lines; comments mark their rows'
  numbers, show a pin to edit them and gather in a tray under the diff and over the composer
  (`NotesTray`), whose Send to agent puts them in one message through `sessions.queue`, which sends
  at once when the session is free and queues it during a turn. Nothing in the diff renders for a
  comment: the marks are a `data-note` attribute on a few number cells, styled by paint alone, and
  the pins, the box and the + sit on a layout-contained layer over the scrolled diff. The library's
  own gutter + is not used: it moves into the hovered row's cell, and every row lays the whole
  grid out again (over 100 ms a row on 7,000 rows). The diff's scroller is layout-contained, so a
  change elsewhere in the window (the composer growing) no longer lays out its rows.
- Phone (`components/DiffNotes.tsx`, `DiffView.tsx`): a tap picks a line and a second stretches
  the pick, a long press comments, a bar under the diff has 写意见 or the comments' count, 发送给
  Agent and 清空, and a strip over the session's composer does the same. Rows stay memoized and
  take only booleans for their state, so a pick redraws the rows it changed. A turn's or a tool's
  edit opens with the session's id; its comments name the file alone.
- The simulator's `80-diff-notes` flow walks the phone's part.

### Comments on page elements (点选元素)

The browser pane's Pick element toggle (点选元素), in the address row, comments on elements of the
page for the agent, as Cursor's Design Mode, Codex's browser comments and Factory's design mode
do. They join the session's comment tray beside the diff's and go with them as one message.

- `src/shared/page-notes.ts`: the element's path as the page reports it, the selectors that may
  name it (a steady id or test id, a name or label, tag and classes, under the nearest anchored
  ancestor, and last the full path by place, which only it matches), a note (page, selector,
  label, visible text, box, viewport, the screenshot's attachment record, the comment), its check
  for stored drafts, and the message: for each, the page, selector, text, box and which attached
  image is its screenshot, then the comment (`browser:pick.message.*`, the interface's language).
- Main (`src/main/browser/pick.ts`): the page's own DevTools inspect overlay
  (`Overlay.setInspectMode`, `searchForNode`) outlines the element under the pointer with its
  tag, classes and size in the theme's accent, which the pane reads from `--pane-fox`. Nothing is
  put in the page: Chromium draws the overlay in a layer of its own, which the page's styles and
  scripts never reach, only while the mode is on. A click ends inspect mode until the comment
  closes; the element is read in an isolated world (`Page.createIsolatedWorld`), its selector is
  the first candidate that matches it alone there, a field's value is never read, and its
  screenshot is `Page.captureScreenshot` clipped to its visible part. Escape in the page, another
  tab, hiding the pane or the agent taking the page ends the mode (`browser:pick` event).
- Renderer (`features/browser/pick-mode.tsx`, `features/page-notes/`): a click freezes the page
  into its still, and the comment's box opens at the element over it; Add comment uploads the
  screenshot with `attachments.add` on the session's host, as a pasted image, and keeps the note
  in the draft's `pageNotes` (at most 20), then the page and the mode come back. The tray
  (`NotesTray`) lists both kinds, under the page too, and Send to agent puts them in one message
  with the screenshots as its images.

### Ports of other computers (端口转发)

A computer added over SSH (or any other host) runs dev servers on its own loopback, which this
computer's browser cannot reach. As T3 Code's and Conductor's port forwarding do, a port of the
host is forwarded to this computer and opens in the session's browser.

- No new SSH process: a forward is the remote host link's existing `ClientForwards` listener on
  this computer's 127.0.0.1, at the host's own port number when free, whose connections go as
  byte streams over the encrypted channel the host's session already runs on (the one an agent's
  navigation to the host's localhost uses). The host's remote host grants the port
  (`ports.forward`, `ports.unforward`, scope a session's id or none) and lists its user's listening
  ports above 1024 with each program's name and folder (`ports.list`, from
  `src/remote-host/listening-ports.ts`: /proc on Linux, lsof on macOS, netstat on Windows),
  Kite's own left out.
  Only main asks these (`hosts:ports`, `hosts:forward-port`, `hosts:stop-forward`, checked in
  `src/main/port-forwards.ts`); a window cannot send them to a host.
- Main keeps the forwards (`PortForwards`, `ForwardBook`, `hosts:forwards` event): one listener a
  port of a host; a session's forward goes with the session, every forward with the host's session.
- Where: the browser pane of a session on another host has Ports (forwarded ports, and those
  listening there, read when it opens and on Refresh); its address field and a remote terminal's
  link open the host's `localhost` through a forward; Settings › Computers › the host has Ports.
  Its switch forwards on their own the dev servers a session's terminals print on that host,
  watching the terminals only while some host has it on (`stores/forwards.ts`).

### Moving a session to another computer (搬到另一台电脑)

As Codex moves a chat with its Git state to a remote host, a session's menu offers 搬到另一台电脑…:
an idle session in a Git project moves to any other computer this one connects to (a paired Kite
or a machine added over SSH), or from one back to this computer, and goes on there with the same
kind of agent.

- Main runs it (`src/main/session-move.ts`, `SessionMover`), never a window: this computer's agent
  host through main's own messages (`host:main-call`, `PortHub.callFromMain` with `MAIN_PORT`),
  another host as this computer's desktop device of it over its existing encrypted channel. The
  hosts refuse `moves.*` to window ports and to devices that are no desktop app (a phone), and
  `isOtherHostMethod` keeps them off the windows' relay. IPC: `sessions:move-preview`,
  `sessions:move-start`, `sessions:moves`, event `sessions:move-progress`.
- Steps: check both sides (`moves.inspect`, `moves.check`: the target's agent of the session's
  harness installed, on and signed in; its project whose remote is the same repository, matched by
  `remoteKey`, else a clone into `~/.huli/projects/<repo>` with its own Git sign-in), prepare the
  project (`moves.prepare`, which sends back the target's branch tips), pack on the source
  (`moves.pack`), carry the pack in 8 MiB parts (`moves.part` → `moves.receive`, SHA-256 checked),
  apply on the target (`moves.apply`), then mark the source (`moves.finish`) and commit
  (`moves.commit`). A failure at any step has the target undo all it did (`moves.undo`) and the
  source drop its pack (`moves.abort`); the session stays where it was, working.
- Git (`src/agent-host/session-move/git.ts`): the uncommitted changes become two commits made aside
  through copies of the index (staged, then the whole working tree with `git add -A`, so ignored
  files stay behind), bundled with the branch's commits the target lacks under temporary
  `refs/kite-move/<id>/*` refs removed right after; nothing is pushed and the source's index, files
  and branches are untouched. The target unbundles (no refs), makes the branch (`-2`... when taken)
  in a new worktree under the project's worktree root, or checks it out in a clone made for a
  session that had none, restores the working tree and index with `read-tree`, and sets the
  upstream when its remote has the branch. Remote URLs lose any user name and password first.
- Conversation (`service.ts`, `transcript.ts`): Claude Code's transcript and its `<id>/` files go to
  `projects/<the target folder as Claude Code names it>/`, Codex's rollout to its day folder, every
  `cwd` and path inside the source's folder rewritten to the target's across Windows and POSIX
  (`mapPath`); an id the target already has gets a new one. Other agents, or a session whose
  transcript is missing, get Kite's copy of the thread carried as a takeover's (`adoptMoved`).
- Undo: the target journals each step in `<data>/moves/<id>/journal.json` and takes them back in
  reverse (session, files, folders it made only while empty, worktree, branch only at the oid it
  set, project, clone only inside the clone folder); a journal a crash left is undone at the next
  move. Afterwards the local session shows 已搬到 <computer> in place of its composer
  (`movedTo` in its record), with Open, Clean up local worktree… and 在这台继续
  (`sessions.clearMoved`). The phone does not offer moves.
- Tests: `src/agent-host/session-move/*.test.ts` (Git transfer with temp repositories, transcript
  rewriting, validation, Claude Code and Codex placement, crash undo) and
  `src/main/session-move.test.ts` (two whole agent hosts on temp folders, with rollbacks).

### Recap, one-tap compact and image markup (离开期间摘要、一键压缩、图片标注)

Three small things Claude Code, Cursor and Moshi have, on the desktop and the phone alike.

- Recap: a session opened again after half an hour away, with something new in it, greets the
  user with one quiet line over the thread's top ("你离开期间：改了 4 个文件（+120 −30），跑了 12
  条命令，2 次需要你批准，最后回复：……") and 跳到离开处, which brings the first new item to the
  top. `src/shared/recap.ts` works it out from the entries after the one the device last saw, with
  no model: distinct files of completed edits and their lines (a Myers count, bounded, or a
  digest's own counts on the phone), commands that ran, requests that asked the user, errors and
  the latest reply's first line. Each device keeps where it last saw each session (300 at most):
  the desktop in localStorage (`session-seen`, `features/session/recap/`), written when a pane
  shows another session or the window goes to the back, and checked again when it comes to the
  front; the phone in `<documents>/huli/seen/<computer>.json` (`mobile/src/seen.ts`), written when
  the screen is left or covered or the app leaves the front. A line goes when it is closed, its
  jump arrives, or a message is sent. Nothing runs between: the desktop's line takes the thread's
  items only when its jump is pressed.
- Compact: the context card on the desktop (`composer/usage.tsx`) and the context sheet on the
  phone offer 压缩上下文 for an agent that lists `/compact` (Claude Code, Codex, OpenCode, Pi, agy)
  or `/compress` (Gemini CLI, Qwen Code), only while the session is free (`ready`, nothing
  queued). It goes as an ordinary message through `sessions.queue`, so no host call is new and the
  thread's compaction divider shows it running.
- Markup: an image tile in the desktop's composer has a pen button (or E on a focused tile) that
  opens `features/session/markup/`, a lazy chunk: pen (perfect-freehand), arrow, box, label, crop,
  four colors (`--markup-*`, alike in every theme), undo (Ctrl/Cmd+Z, tool keys P A R T C). Done
  draws the picture and its marks on an OffscreenCanvas cut to the crop and replaces the tile's
  record with the PNG under the same name. On the phone a photo tile's sheet has 标注
  (`components/MarkupEditor.tsx`, lazy): the same tools in SVG over a copy no larger than
  `IMAGE_SIDE`; Done takes react-native-svg's own `toDataURL` snapshot (the view's size at the
  screen's scale) and crops it with expo-image-manipulator, and a crop alone cuts the photo
  itself. `src/shared/markup.ts` holds the marks both draw.
- The simulator's `85-recap-compact-markup` flow walks the phone's part; a developer build's
  `-huliRecapAwayMs` launch argument shortens the half hour for it.

### Dev servers on the phone (开发服务器预览)

The phone previews the computer's dev servers, which usually listen on the computer's loopback
alone, in a web view of the app, as Moshi's and Replit's phone previews do.

- List: 开发服务器, from a session's ⋯ menu (that session's first) and the computer's page
  (Settings › 线路), is `ports.list` read when it opens and on a pull, never on a timer
  (`mobile/src/devServers.ts`). Each port is named by the worktree session whose folder or
  `KITE_PORT` block it is in, or by its project.
- Proxy (`src/remote-host/previews.ts`, contract in `src/shared/dev-preview.ts`): `preview.open`
  `{ port }` lists the ports again and takes only one a program of the computer's user listens on
  above 1024, on the loopback or every interface; the preview then connects to 127.0.0.1 or ::1
  alone. It opens a listener of its own on the address the phone's direct connection came in on
  (one per device and port, the same port again while free, so the dev server keeps its origin and
  what its pages stored) and answers `{ port, path, idleMs }`. Its own listener, not a path under
  the direct port, gives the dev server an origin apart from the web client's, so its absolute
  paths and HMR socket work as on localhost.
- Who gets through: `path` is `/__kite_preview/<ticket>`, a one-time ticket good for 2 minutes
  that the entry trades for the preview's cookie (`kite_preview_<port>`, 32 random bytes,
  HttpOnly, SameSite=Lax) and a redirect to the preview's own path. Every request then needs that
  cookie, a Host as a browser sends one, and to come from the preview's own pages (Origin, and
  `Sec-Fetch-Site` same-origin or none), since another preview's page shares the site and so the
  cookies. Only origin-form requests pass: an absolute URL, `*` or `CONNECT` is refused, so it is
  never a forward proxy.
- Headers: Host becomes `localhost:<port>`, the preview's Origin and Referer localhost's, which
  Vite's and Next.js's host and origin checks accept; the preview's cookies, hop-by-hop headers
  and `X-Forwarded-*` stay behind. A redirect to the dev server's own address becomes a path; a
  Set-Cookie loses its Domain and Secure, and one naming a preview's cookie is dropped.
- Streams both ways, a WebSocket upgrade (HMR) becomes a byte tunnel; 64 MiB a request body, 1 GiB
  a response, 48 connections a preview, 8 previews a device, 32 in all.
- Ends: unused for 30 minutes (a request or WebSocket bytes are use), 8 hours in any case, the
  phone leaving the preview (`preview.close`), the device removed, direct connections off, or the
  remote host stopping. Nothing listens until a phone opens one.
- The relay carries no preview: the phone's web view needs an address of the computer to load a
  page from, and tunnelling it over the encrypted channel would need a local HTTP listener on the
  phone (a native module) for the web view, so the phone says 需要直连（同一 Wi-Fi 或 Tailscale）才能
  预览 and the host answers `needs_direct`. A computer behind a port-based firewall needs the
  preview's port open too; Windows' and macOS' per-app rules already allow it.
- iOS: `NSAllowsLocalNetworking` lets the web view load the computer's address over http. The
  simulator flow `90-dev-preview` checks a page, a fetch and a WebSocket through it against
  `tools/huli/ios/sim/dev-server.mjs`, which `run.sh` starts for it.

### Doubao (豆包)

ByteDance's Doubao CLI (`@bytedance/doubao-cli`, checked on 2.37.2) as the agent 豆包 / Doubao,
free with a Doubao account; Windows x64, macOS arm64 and Linux x64 only. Kite runs the user's own
install: npm installs a launcher whose install script downloads the native program into
`%LOCALAPPDATA%\doubao_cli\app\current` (Application Support, or `XDG_DATA_HOME`/`~/.local/share`),
and Kite runs that program itself, never cmd.exe or the PowerShell shim. The install plan is
`npm install -g --allow-scripts=@bytedance/doubao-cli @bytedance/doubao-cli` (`allowScripts` in
`binary-install.ts`), since npm 11 blocks the install script.

- One process per turn: `doubao -C <folder> [--resume <id>] -p - --output-format stream-json
--model <id> --effort <level> --permission-mode <mode>`, the prompt on stdin. Stop ends the
  process tree; the next turn resumes the conversation. The stream has text deltas, whole
  messages (again when completed or replaced), tool calls and results, and a result with the
  confirmations the CLI refused; no thoughts and no token counts.
- `-p` cannot answer the CLI's confirmations: it rejects each one itself. The mode menu offers the
  CLI's own modes and says so: 沙箱 (`ask_always`, the default: a sandbox that writes only in the
  folder), 拒绝风险操作 (`ask_risky`: no sandbox, risky actions refused) and 完全访问
  (`always_allow`). A refused call shows as denied, and the turn ends with a notice that lists
  what was refused. The agent's page takes one as the mode new sessions start in; a session
  another agent starts never takes full access from it (`startedStartMode`), since Kite does not
  rank Doubao's modes.
- Every `doubao` process uses one shared service per account, the child of whichever process
  started it; ending that process's tree (Stop, or the host reaping an exited process) ends every
  other run. So `doubao/gate.ts` runs one turn or sign-in at a time per account, and a read
  (listing, export, models, status) alone or beside a turn already at work. A waiting turn shows
  「豆包同一时间只能运行一个会话，前面还有 N 个」 until it starts.
- Doubao names a conversation only once its first turn runs: a session Kite creates gets an id of
  its own (`doubao-…`), mapped to the conversation in `harnesses/.extensions/doubao/
conversations.json`, so it resumes after a restart and lists as imported.
- Sign-in: `doubao login --qr=png` in the host; each `QR_IMAGE=<path>` picture goes to the asking
  client as `agents.signInImage` (Settings' agent page, a session's sign-in, the phone's agent
  page) until the CLI exits. `auth status` reads the sign-in, `logout` signs out. The phone,
  which usually runs the Doubao app that must scan it, offers to save or send the picture
  (`mobile/src/system/shareImage.ts`, the share sheet's Save Image needing
  `NSPhotoLibraryAddUsageDescription`) and says to scan it from another device or sign in on the
  computer; Doubao documents no link that opens a sign-in in its app, so none is offered.
- Import: `--list --all --json` lists every unarchived conversation, from every folder and device;
  one with no folder (the app's, another device's) comes under the home folder. The sidebar's
  Import sessions reads `--list --limit 100 --json` pages on with `--cursor` until one is the
  folder's, at most five a time (an empty `next_cursor` ends them). Its history comes
  from `--export` (each turn's question and answer, as text), and it continues with `--resume`.
- The models and levels come from `model list --json`, kept 10 minutes.

Huli's own files: `src/agent-host/doubao/` (+ tests and scrubbed `fixtures/` of real 2.37.2
output), `src/agent-host/agents/doubao.ts`, `src/agent-host/testing/fake-doubao.ts`, and the marks
`components/agents/marks/doubao.tsx` (a neutral bean, not ByteDance's logo). Hooks: `catalog.ts`,
`drivers.ts`, `installed-cli.ts` (`resolve` gets the agent's environment), `binary-install.ts`,
`agent-details.ts`, `connection.ts` and `agents.ts` (`SignInClient.showImage`), `host.ts` and
`src/shared/agent-host.ts` (`agents.signInImage`), `src/shared/agents.ts` (the harness,
`always_allow` as full access), `stores/agents.ts`, `app/bootstrap.ts`,
`features/session/sign-in.tsx`, `features/settings/agent-parts.tsx` and `agents-section.tsx`,
`locales/*/host.json` (`doubao`) and `session.json` (`signIn.scan*`); on the phone
`mobile/src/app/settings/agent.tsx`, `agentName.ts`, `manage/agents.ts` and `ui/agent-marks.tsx`.

Generated before a build (not hand edits, never committed):

- `node tools/huli/rebrand.mjs` swaps the display name Kettu to Kite, and to 纸鸢 in Chinese copy
  (`ZH_NAME`), dropping the spaces that set a Latin word off from Chinese, and puts Kite's artwork
  in place. Idempotent; the build workflow runs it, and so must a local build (see Build).
  `pnpm dev` needs none (see Kite in development). What it swaps in text, and how, is in
  `brand-text.mjs`; the script reads and writes the files.
  - Every locale but `star.json` (the prompts to star Kettu's repository) has its values
    rewritten: the word Kettu, except in `KettuAI/Kettu` and in the phrases `KEEP` lists (the
    attribution and Star Kettu); first, where the copy names Kettu's service after the app (its
    account, relay, cloud and published pages), Kite Cloud in both languages (`SERVICE`), so 纸鸢
    and Kite name only the app; Kettu's service copy (`COPY`), `kettu.sh`, the home folder
    `.kettu/` and the phone app's platforms (Android too); and pairing-link placeholders
    (`LINKS`), which are swapped even though they are URLs.
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

### Testing without disturbing the owner

Agents that run the app to check a change do so on the owner's own computer. Start such a copy with
`KITE_TEST_WINDOW=background` beside its own data folder and debugging port, for instance in
PowerShell:

```powershell
$env:KITE_TEST_WINDOW = 'background'; $env:KETTU_USER_DATA = "$env:TEMP\kite-test-1"; $env:REMOTE_DEBUGGING_PORT = '9333'; npx -y pnpm@10.11.1 dev
```

Its main window then shows without taking the focus, past the right edge of every display and out
of the taskbar, and every later show (a second launch, the quit dialog) leaves the focus alone too.
It has no tray icon and shows no notifications (Settings' test notification still does). The page
still paints at the display's full rate, so CDP's `Page.captureScreenshot` and `capturePage` see
it as on a screen; measured on Windows, a minimized or never-shown window instead paints only when
captured and throttles its animation frames, so it is not used. An installed build ignores the
variable. Stop the copy by ending its process tree (`taskkill /PID <electron-vite's node> /T /F`);
it saves no window position. `src/main/test-window.ts` holds it; hooks in `src/main/window.ts`
(the place and `keepInBackground`), `src/main/index.ts` (no tray) and `src/main/notifications.ts`.

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

- `src/shared/agent-network.ts`: the settings' part (on, the default way out, each agent's
  choice, the interface nodes dial out on), the status and node types, `NODE_NO_PROXY`. The
  default (`defaultNode`, Settings' 默认出口) is a node or one interface, as with no subscription
  an agent's way out may be a proxy client's TUN; `agentRoute` gives an agent that follows an
  interface default that interface, so it is bound just as one that chose it.
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

### Agents yield to you (让 Agent 让着你)

Builds and tests start bursts of short processes, and on Windows the antivirus scans each, so the
whole computer stuttered while agents ran them. With `general.lowerAgentPriority` on (the default,
Settings › Agents › Performance), the agent host lowers its own priority to below normal
(`os.setPriority`, a niceness of 10 on macOS and Linux) when `host:init` arrives, before it starts
anything, and every agent, MCP server, mihomo and command it starts inherits it: Windows'
`CreateProcess` passes the below normal and idle classes on, and a forked process keeps its
niceness. Given the processor alone they run as fast as before. Main, the window and the terminal
host keep their priority, so the user's own shells, Kettu's `terminal_run` tool, an agent's CLI
opened in a terminal and sign-ins in a terminal run at normal priority. A change applies at once to
the host and to what it starts afterwards; programs already running keep theirs. Turning it off
raises the host back on Windows; macOS and Linux refuse an unprivileged raise, so there it stays
low until Kite (or the daemon) restarts. A host that started that low or lower, as under `nice`, is
left alone. The daemon's agent host does the same from the same setting.
`src/agent-host/priority.ts` (with its test) and `start.ts` hold it; the row is in
`section-defs.tsx` and `settings-catalog.ts`.

### Kite's own Node.js

Agents that run on Node.js (most package agents; DeepSeek wants ≥ 24.9) said 「需要 Node.js」 and
only linked nodejs.org. Kite now installs Node.js itself, the same on Windows, macOS and Linux:
no administrator rights, no package manager, nothing written to the system's PATH or shell
profiles.

- What: the newest release of `index.json` with `lts` set that has this computer's official
  archive (`win-x64`/`win-arm64` `.zip`, `darwin-arm64`/`darwin-x64` and `linux-x64`/`linux-arm64`
  `.tar.gz`; none on musl) and meets every built-in agent's `requiresNode`
  (`strictestRequirement`), into `<userData>/runtimes/node/<version>/` with its `kite-node.json`.
  The newest two installs stay.
- Where from: `https://nodejs.org/dist/`, unless its `index.json` fails or takes more than 3 s;
  then `https://npmmirror.com/mirrors/node/` races it and whichever answers first serves the
  archive; a failed download tries the other. The archive's SHA-256 is checked against
  `SHASUMS256.txt` from nodejs.org, or from the mirror when nodejs.org does not answer (a weaker
  trust path: the mirror then vouches for its own file). A mismatch deletes it.
- How: the requests go the way Kite's own do, as subscriptions download (Advanced › Proxy, else
  the environment's proxy variables, else directly, which a TUN still catches), never through an
  agent's node. The archive streams into `.partial-<random>/`, is extracted there by the system's
  tar (Windows' own `System32\tar.exe`, which reads `.zip`; Git's GNU tar takes `C:` for a host),
  with only paths Kite made as arguments and no shell, its `node --version` must say the version,
  and the folder is renamed into place last. A stall of 30 s fails the download.
- The harnesses' own downloads go the same way (`transport.ts`, `AgentManager`'s `downloads`):
  a release archive from the ACP Registry, the Registry's listing and the harness manifest, which
  upstream fetches with Node's bare `fetch`, past every proxy. An archive that receives nothing
  for 30 s fails at once, not at its 15-minute limit. Tests: `src/agent-host/downloads.test.ts`.
- Which runs: `EnvironmentService` (`shell-env.ts`) probes the user's node on PATH, then
  `chooseNode` picks it while it meets the agents' needs, else Kite's; `kite` in
  `state/node-runtime.json` (`环境` › 始终用纸鸢的 Node.js) takes Kite's whenever installed.
  When Kite's runs, `agentEnv()` puts its folder first on PATH (`withNodeBin`), so agents' launches,
  npm installs, git and commands, and `ctx.node` in detection all use it. After an install, an
  update, a removal or a change of choice the host probes again, detects every agent again (a
  `node-missing` agent becomes installable without a restart) and stops idle agents' processes so
  their next start takes the new PATH.
- Requests: `environment.installNode` (resolves when done; `installed: false` when that version is
  there), `environment.cancelNodeInstall`, `environment.removeNode` (refused, with the rest kept
  whole, while an agent still runs on it: Windows cannot move a folder whose node runs) and
  `environment.setNodeChoice`, checked in `node-runtime/validate.ts`; paired devices may call them.
  Progress comes in `environment.changed` as `node.task` (at most every 250 ms, and at each phase).
- Where it shows: an agent's page, the harness row and page (Settings › Harness), New session's
  line while no agent can start, and the environment lines under Settings › Harness, which say
  which Node.js agents use and offer 更新, 移除 and the choice: 「一键安装 Node.js」 with its
  progress and error, and a small 「手动安装」 link to nodejs.org. The phone's 设置 › Agent › 环境
  offers the same, and so do its agent and harness pages and New session wherever an agent waits
  for Node.js (`mobile/src/manage/node.tsx`).

Huli's own files: `src/agent-host/node-runtime/` (`release.ts`, `install.ts`, `transport.ts`,
`service.ts`, `validate.ts`, with `release.test.ts`, `install.test.ts`, `environment.test.ts` and
`fixtures/index.json`), `src/renderer/src/features/agents/node-install.tsx` and `node-runtime.ts`.
Hooks into upstream files: `src/agent-host/shell-env.ts` (`ManagedNode`, `chooseNode`,
`withNodeBin`, `setNodeSetup`, `info().node`), `src/agent-host/host.ts` (the service, its load
before the first detection, `nodeSetupChanged`, the handlers, `ownProxy`),
`src/agent-host/node-proxy/download.ts` (`request` exported with headers),
`src/agent-host/validate.ts`, `src/shared/agent-host.ts` (`NodeRuntimeInfo`, the methods),
`src/shared/host-request-limits.ts`, `features/agents/readiness.ts`, `agents-section.tsx`,
`harness-section.tsx`, `new-session.tsx`, `mobile/src/app/settings/agents.tsx` and the
`node`/`nodeRuntime` keys of `locales/*/{agents,settings,host}.json`.

### Chat apps (聊天软件)

Settings › 聊天软件 lets the user drive the agents from a bot of their own in Feishu, DingTalk,
WeCom, QQ or Telegram. Every bot connects out from this computer, so no public address is needed:

| Platform | Mode                                                           | Buttons               | Files in / out |
| -------- | -------------------------------------------------------------- | --------------------- | -------------- |
| Feishu   | custom app, events and card callbacks over the long connection | card JSON 2.0 buttons | yes / yes      |
| DingTalk | internal app's bot in Stream mode (bot message callback only)  | text commands         | yes / yes      |
| WeCom    | AI bot (智能机器人) in API mode over the long connection       | button cards (≤ 6)    | yes / yes      |
| QQ       | QQ open platform bot over the WebSocket gateway, C2C only      | text commands         | yes / no       |
| Telegram | Bot API long polling (getUpdates), through Kite's own proxy    | inline keyboards      | yes / yes      |

All of them speak the platforms' raw protocols; no SDK is added. Feishu's frames are the
`pbbp2.Frame` protobuf of its official SDKs, coded by hand in `feishu-frame.ts`. Every request and
connection goes the way Kite's own requests go (Advanced › Proxy, else the environment's proxy
variables, else directly), through `node-proxy/download.ts`'s tunnel and the `ws` package the
remote host already bundles.

- Where: the agent host loads `src/agent-host/chat-bridge/` with `import()` only once a bridge is
  on with its credentials; with none on, nothing of it runs or loads. Each bridge has its own port
  into the host's `PortHub`, served as a paired device's (`chat-<platform>`), so every request it
  makes takes the phone's validation and refusals, and what it sends or answers is marked as from
  that app. It hears what needs the user from the same `host:attention` main's notifications get.
- Credentials: main keeps them with the bound accounts in `chat-bridge.json`, encrypted by the
  system like the Marketplace's keys (nothing is kept where the system cannot encrypt), read off
  the start's path, and sends them whole to the agent host (`host:chat-bridge`). A window gets
  `ChatBridgeView` alone: which credentials are set, a secret's last 4 characters, the accounts,
  each connection's state and last error (`host:chat-bridge-status`). The values are log secrets in
  the agent host. The backup leaves the file out.
- Who: only bound accounts, and only in a one-to-one chat with the bot, get any answer; everyone
  else, and every group, gets none. Binding: 绑定 makes a 6-digit code in main, good for 10 minutes
  and for one account; the agent host reports it when an unbound account sends it
  (`host:chat-bridge-bind`), main checks it is the code under way and keeps the account. Five wrong
  codes use a binding up. Button presses are checked against the bound accounts too, and carry
  only a random key the bridge maps to the request. New credentials of another bot drop the
  accounts of the one before.
- In the chat: `/list` (sessions that need you first), `/s 3`, plain text to the chosen session
  (`sessions.queue`, `/now` steers with `sessions.sendNow`), `/new 2 1` then the first message
  (`sessions.create`), `/stop`, `/y` `/n` `/2 note` for the request in front, answers to questions
  (one at a time for an ask of several; secret ones are refused), plans with their options,
  `/get 1` for the last turn's artifact as a file, `//` to send a slash command to the agent.
  Pictures and files become attachments as the phone's do (`attachments.add`, 20 MB). A finished
  turn's reply comes whole for a session the chat chose or wrote to in the last day, else as a
  line; replies are cut to each platform's size, code blocks closed and reopened (`split.ts`).
- Pace: each platform's published limits (`pacing.ts`), a 429 or its code waits as told,
  reconnects back off from 1 s to 5 minutes; a timer runs only while a message waits or a
  reconnect is due. Free Feishu and DingTalk organizations have a monthly API quota.
- Files: `src/shared/chat-bridge.ts`, `src/main/chat-bridge.ts` (+ test), `src/agent-host/chat-bridge/`
  (`service.ts`, `controller.ts`, `commands.ts`, `access.ts`, `split.ts`, `pacing.ts`, `net.ts`,
  `lifeline.ts`, `markdown.ts`, `host-client.ts`, one file per platform, tests for the commands,
  the allowlist and binding, splitting, Feishu's frames and WeCom's file decryption), and
  `features/settings/chat-bridge-*.tsx`, `stores/chat-bridge.ts`, `chatBridge` in
  `locales/*/{settings,host}.json`. Hooks: `host-control.ts`, `ipc.ts`, `preload/index.ts`,
  `main/index.ts`, `main/agent-host.ts`, `main/ipc.ts`, `agent-host/host.ts`, `start.ts`,
  `settings-catalog.ts`, `settings-page.tsx`, `web-sections.ts`, `use-search-entries.ts`. The daemon
  has no chat bridges.

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
- `src/agent-host/git/service.ts`: tool calls that end in a burst share a status refresh at most
  every second (`TOOL_REFRESH_MS`), which a turn's end starts at once, instead of running git back
  to back; calls sharing one report in the order they ended and each still finds a pull request in
  its own output.
- `src/agent-host/sessions.ts` (`planProgress`): the latest plan is looked up again only after a
  patch that can change it, not by scanning the whole thread on every update.
- `src/agent-host/dsh/` (`history.ts`, and `listSessions`, `listAllSessions` and `loadSession` in
  `connection.ts`): DeepSeek Harness offers its sessions for import, read from dsh's own logs
  (`$DSH_HOME/sessions/--<folder>--/<id>/session.v4.jsonl.zstd`; format 3 lifted, others left
  out), and an import replays the user's messages, replies, thoughts, tool calls with their
  results, the plan and subagents' sessions before it resumes in dsh.
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

- `huli-sim.yml`, only by hand (`gh workflow run huli-sim.yml --ref <branch> -f ref=<branch>`):
  checks the phone app in an iOS simulator on a `macos-26` runner instead of the owner's Mac.
  `tools/huli/ios/sim/build.sh` builds the simulator app from `ref`; `run.sh` boots a fresh Pro Max
  with the Pinyin keyboard, starts this checkout's daemon with the fake agent in a data folder of
  its own, pairs the app with it alone (`pair.mjs` answers `kettu pair`), and runs the Maestro
  flows under `tools/huli/ios/sim/flows` (or those named in its `flows` input) while recording the
  screen. Two names in `flows` sample the app's processes instead: `measure`, what it costs in
  resting states (`measure.sh`), and `long-reply`, a session with a finished 120 KB reply opened
  afresh (`long-reply.sh`). A flow whose header says `# Ends: both appearances` is shot at its
  end in dark and in light (`<flow>-dark.png`, `<flow>-light.png`), as the system's own screens,
  such as Quick Look, follow the system's appearance rather than the app's theme. The screenshots,
  recordings and logs are the run's `huli-sim` artifact, kept for a day. With `platform` android
  it builds a release for an x86_64 emulator on Linux and measures it (`tools/huli/android/run.sh`),
  or runs the flows of `tools/huli/android/flows` that `flows` names (`huli-emu`).
  It uses no secrets and never runs on a push or pull request.

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

Since 2026-11-19 the owner's iPhone updates through TestFlight (internal testers get every build;
turn on automatic updates in TestFlight). The ad-hoc export below is off unless the repository
variable `HULI_IOS_ADHOC` is `true`; a TestFlight build carries no provisioning profile, so it
never checks the channel itself.

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
