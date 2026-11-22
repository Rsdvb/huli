# kite-computer-helper

What Kite's computer use needs from the system beyond Cua Driver. `build.mjs` builds it into
`resources/cua-driver/`, beside the driver, and `tools/install/cua-driver.mjs` runs it after the
driver's fetch, so the release run and `pnpm fetch:cua-driver` both make it:

- **Windows** (`windows/*.cs`): C# 5 for the .NET Framework 4.x that Windows 10 and 11 ship, built
  with that framework's own `csc.exe` (no SDK, no NuGet). AnyCPU, windowed (no console).
- **macOS** (`macos/main.swift`): built with `swiftc` from Xcode or the Command Line Tools. It
  serves `ocr` only. A failed macOS build leaves computer use without text recognition instead of
  failing the release, as no Mac checks it before the release run.
- Linux has none.

The agent host starts it only while a computer use session needs it and ends it with the session.

## serve

```text
kite-computer-helper serve
```

Requests on stdin, answers on stdout, one JSON object per line. Each request has an `id` and an
`op`; its answer is `{ "id", "ok": true, "result" }` or `{ "id", "ok": false, "error" }`.
Requests run concurrently and answers may come in any order.

| op          | Request                                                     | Result                                                                 |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `whoami`    | -                                                           | `{ sid, pid, integrity, elevated }` of the helper's own token          |
| `elevation` | `pids`: up to 1024 process ids                              | `{ self, selfElevated, pids: { "<pid>": { integrity, elevated } } }`   |
| `ocr`       | `image`: base64 PNG or JPEG; `language`: optional           | `{ languages, width, height, lines: [{ text, x, y, width, height }] }` |
| `elevate`   | `pipe`, `user`, `client`, `target`, `tokenSha256`, `idleMs` | `{ pid }`, or `{ cancelled: true }` when the user says no              |

`elevation` opens each process with `PROCESS_QUERY_LIMITED_INFORMATION` and reads its token's
mandatory integrity level (`0x2000` medium, `0x3000` high) and `TokenElevation`; null where the
token is not readable (protected and other users' processes). Kite treats a process whose level is
above its own as one Windows' UIPI keeps it from driving.

`ocr` uses `Windows.Media.Ocr`. Without `language`, it reads with the user's first OCR language
and, when installed, one of the other script family (Chinese, Japanese or Korean against the rest),
and merges the two: each engine misreads the other's small text, so overlapping lines go to the
engine whose text reads as its own script. Boxes are in the image's own pixels, from its top left.

`elevate` starts this program as the broker (below) through `ShellExecute` with the `runas` verb,
which shows Windows' administrator prompt on the secure desktop; only the owner can answer it.

## broker

```text
kite-computer-helper broker --pipe kite-computer-<32 hex> --user <SID> --client <pid>
                            --target <pid> --token-sha256 <64 hex> [--idle <ms>]
```

The elevated half of "允许以管理员权限操作指定程序". It serves one connection from Kite's agent host
for one approved program, then exits:

- **Pipe.** `\\.\pipe\<pipe>`, the first and only instance, remote clients refused, with the DACL
  `D:P(A;;GRGW;;;<user>)S:(ML;;NW;;;ME)`: only Kite's account by its SID, passed in because under
  Windows 11 Administrator protection the broker runs as the shadow administrator, a different
  account; a medium mandatory label so Kite, at medium integrity, can write to it and nothing below
  medium can.
- **Who connects.** The client's process id (`GetNamedPipeClientProcessId`) must be `--client`
  and its token's user `--user`; its first line must be `{"token": "<token>"}` whose SHA-256 is
  `--token-sha256`. The token itself never appears on a command line, which other processes of the
  user can read. A refused client hears `{"ok": false, "error"}`; three refusals end the broker. The
  accepted one hears `{"ok": true, "pid"}`.
- **What passes.** It runs `cua-driver.exe mcp --direct` from its own folder as its child, with
  Kite's driver switches and a PATH of system folders only, and relays MCP. Only `initialize`,
  `ping`, `tools/list`, cancellations and these tools pass: `list_windows`, `get_window_state`,
  `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `invoke_menu`, each with only the
  arguments Kite sends, each scoped to `--target` (its `pid`, and its window id owned by `--target`
  by `GetWindowThreadProcessId`), and in the background only. Nothing that launches or kills
  programs, runs scripts or steps, reads or writes the clipboard, writes files
  (`screenshot_out_file`) or changes the driver's settings passes. Refused calls get a tool error.
- **Lifetime.** It ends when Kite disconnects, the target or Kite's host exits, no request came for
  `--idle` (5 s to 30 min, 10 min by default; Kite asks 5), or no client proved itself within 60 s;
  the driver goes with it.

Kite's side is `src/agent-host/computer/elevated.ts`; its risky-step confirmation and the badge
live in the agent host and the window.

It never uses UIAccess. In a per-user install the app's folder is writable by the user, so, as
for every program there, the prompt protects no more than that folder does; a per-machine install
keeps it under Program Files.
