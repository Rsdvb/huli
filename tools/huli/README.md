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
| `features/session/entries/refusal-end.tsx` and its uses, `locales/*/session.json` (`refusal`), `tools/fake-agent` (`/refusal`)           | a turn the model declined (`stop_reason: "refusal"`) says the API gives no reason, quotes the model's own explanation when a longer reply holds one, and on the latest turn offers Try again (the same message through the queue; the host's retry resends only failed turns) and Edit message                      |
| `styles/affect.css` (the sidebar list's scrollbar)                                                                                       | App Shell hides the sidebar's scrollbar for good; it shows thin while the pointer or the keyboard is in the sidebar and hides at rest, on Windows in a gutter clear of the resize handle; macOS keeps its overlay scrollbar                                                                                         |
| `src/agent-host/{agents,sessions,host,start,validate}.ts`, `src/shared/{agent-host,host-request-limits}.ts`, `agents-section.tsx`        | an agent's page offers Reset environment…, its sign-in, ids and caches removed and its history and settings kept (see Agent reset)                                                                                                                                                                                  |
| `app/window-front.ts`, `turn-dots.tsx`, `styles/globals.css`                                                                             | every loop of the window (the turn dots, any CSS animation that repeats forever) is held paused and stepped every 120 ms from one timer, only while on screen with the window visible and focused; the running labels' light sweeps stand still                                                                     |
| `features/session/markdown/markdown-impl.tsx`                                                                                            | streamed words show as they arrive, without affectUI's per-word fade                                                                                                                                                                                                                                                |
| `features/session/thread.tsx`                                                                                                            | a thread resting at its end for 3 s with more than 72 items rendered keeps only the newest 24 (`TrimAtEnd`)                                                                                                                                                                                                         |
| `turn-status.tsx`, `turn-dots.tsx`, `styles/session.css`                                                                                 | a running turn's status label, dots, row of work and tool labels change at once instead of replaying an entrance at each step                                                                                                                                                                                       |
| `markdown/{in-parts.ts,markdown-impl.tsx,live.ts}`, `thread.tsx`, `find/find-in-session.tsx`, `components/ui/message-scroller.tsx`       | a written reply opens with its last chunks, about a window's height, the rest following a chunk a frame with the chunk in view held in place (a returning thread renders it whole; a find waits for it); a settling thread hides by opacity, since visibility restyled every element                                |
| `markdown/markdown-table.tsx`                                                                                                            | a table measures its overflow only near the view, after layout, through one shared pair of observers                                                                                                                                                                                                                |
| `stores/sessions.ts`, `features/overview/use-overview.ts`, `jump-to-latest.tsx`, `entries/run-group.tsx`                                 | in a burst of tool calls: summaries leave out `working` (the phone's) and keep their object when sent again unchanged, the Overview count is selected as a number, the hidden jump button follows no phase, a folded run keeps its steps' stubs                                                                     |
| `src/main/window.ts`, `styles/tokens.css`                                                                                                | the macOS window is opaque, without vibrancy, which no theme showed (`--desk-tint` was 100%)                                                                                                                                                                                                                        |
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
  implementations in `codex/connection.ts`, `acp/connection.ts` and `dsh/connection.ts`.
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
- Tests: `src/agent-host/agent-reset/*.test.ts`, and the requests in `validate.test.ts`.

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
- Hooks: `Sessions.delete` and `dropPrepared`/`removeLeftovers` in `src/agent-host/sessions.ts`,
  `readInHiddenSession` and `deletesCopy` in `agents.ts`, the service in `host.ts` (flushed at
  shutdown), `AgentStatus.deletesCopy` in `src/shared/agent-host.ts`; the delete confirmations in
  `features/sidebar/session-menu.tsx` and `mobile/src/components/DeleteSessionDialog.tsx` say so
  (`row.deleteRemovesAgentCopy`), keeping `row.deleteKeepsAppCopy` for an agent whose copy stays;
  `FAKE_AGENT_UUID_IDS` in `tools/fake-agent`.

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
  what was refused.
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
  page) until the CLI exits. `auth status` reads the sign-in, `logout` signs out.
- Import: `--list --all --json` lists every unarchived conversation, from every folder and device;
  one with no folder (the app's, another device's) comes under the home folder. Its history comes
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
  offers the same.

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
  afresh (`long-reply.sh`). The screenshots, recordings and logs are the run's `huli-sim`
  artifact, kept for a day.
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
