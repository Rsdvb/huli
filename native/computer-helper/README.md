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

| op          | Request                                           | Result                                                                 |
| ----------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `whoami`    | -                                                 | `{ sid, pid, integrity, elevated }` of the helper's own token          |
| `elevation` | `pids`: up to 1024 process ids                    | `{ self, selfElevated, pids: { "<pid>": { integrity, elevated } } }`   |
| `ocr`       | `image`: base64 PNG or JPEG; `language`: optional | `{ languages, width, height, lines: [{ text, x, y, width, height }] }` |

`elevation` opens each process with `PROCESS_QUERY_LIMITED_INFORMATION` and reads its token's
mandatory integrity level (`0x2000` medium, `0x3000` high) and `TokenElevation`; null where the
token is not readable (protected and other users' processes). Kite treats a process whose level is
above its own as one Windows' UIPI keeps it from driving.

`ocr` uses `Windows.Media.Ocr`. Without `language`, it reads with the user's first OCR language
and, when installed, one of the other script family (Chinese, Japanese or Korean against the rest),
and merges the two: each engine misreads the other's small text, so overlapping lines go to the
engine whose text reads as its own script. Boxes are in the image's own pixels, from its top left.

`process` gives a process's image path and start time (a FILETIME), which the broker checks.
`layout` says how the install folder stands for a Kite program: `missing`, `current`, `outdated`
(another protocol, an install without a record, or another Kite program) or `tampered` (files that
are not the recorded ones, or rights that let others than administrators change them). `install`
stages this program, the driver beside it and `install.json` in a temporary folder and runs
Windows' `robocopy.exe` through the administrator prompt (`ShellExecute` with `runas`) to copy them
into the install folder, then checks what landed against the hashes it took while it held the files
open; `uninstall` runs Windows' `cmd.exe` `rd /s /q` the same way. `elevate` starts the installed
broker through `cmd.exe` the same way and answers that launcher's pid. Each answers
`{ cancelled: true }` when the owner says no at the prompt, and each refuses first while a .NET
setting that loads code is set anywhere the prompt's environment comes from (`Guard.cs`).

## The elevated helper (Windows)

Only when the user allows it, for "操作以管理员身份运行的程序". See tools/huli/README.md for the
whole flow.

```text
kite-computer-helper broker --pipe kite-computer-<32 hex> --user <SID> --host <pid> --target <pid>
                            --target-image <path> --target-started <FILETIME>
                            --token-sha256 <64 hex> [--idle <ms>] [--lang zh-CN|en]
kite-computer-helper connect --pipe kite-computer-<32 hex> --launcher <pid>
```

- **The install** puts this program, the `cua-driver.exe` beside it (checked against the SHA-256
  built into this program, `Build.DriverSha256`, which `build.mjs` writes) and `install.json`
  (`protocol`, both files' SHA-256 and Kite's program) into `%ProgramFiles%\Kite Computer Helper`,
  which only administrators can write to. No program from the app's folder runs as administrator
  for it, and an update of the same protocol (`Layout.Protocol`) needs none.
- **broker** (as administrator) starts through `cmd.exe`, which clears the names that make .NET load
  code and sets `SystemRoot` and `windir` from the system; it refuses to go on with any such name
  left or another Windows folder. It runs only from the install folder, only when its record, its
  own hash and the folder's rights check out. It matches the program's image exactly as Windows
  names it and its start time, refuses programs that start other programs or run what is typed
  into them, programs that do not run as administrator and programs with programs of their own
  running, then waits for one client on its pipe (`D:P(A;;GRGW;;;<SID>)S:(ML;;NWNR;;;ME)`, first
  instance, no remote clients): the installed helper's `connect` mode, a child of `--host` whose
  image is the recorded Kite program, as `--user`, whose first line is `{"token": ...}` hashing to
  `--token-sha256`. Three refusals end it. It then asks the owner in its own window, which names the
  program, its window and the process that asks with its command line and parent, puts the program
  in a job that lets it start no process (limit set before it joins), starts the driver (hash
  checked, held open, in a kill-on-close job that lets it start nothing, with Windows' folders from
  the system, its own home and temporary folders under the install folder and a PATH of System32),
  and answers `{"ok": true, "pid"}`. It relays MCP: only `initialize`, `ping`, `tools/list`,
  cancellations and the read and input tools Kite uses, with only Kite's arguments and `params`
  keys, each checked for its type and range, `delivery_mode: "background"` on every action, one
  tool call at a time, scoped to the program's windows, and passes on the message it parsed,
  re-serialized. Before every step but harmless ones (`Risk.cs`) it asks the owner again, with a
  picture of the whole window, the typed text in full and what went through unasked; pastes,
  clicks it cannot place and overlong text are refused. It ends when the client goes, the program
  or the host exits, `--idle` passes with no request pending, the owner refused three steps, the
  driver delivered in the foreground or thirty minutes passed; the job limit on the program is
  lifted then.
- **connect** (without elevation, from that folder) reads the token as its first stdin line,
  checks that the pipe's server is a child of `--launcher` started after it, running this same
  installed program, as administrator, hands the token over, writes the broker's answer as its
  first stdout line and relays both ways.

`build.mjs --test` makes a test build for `src/agent-host/computer/elevated.test.ts`: it takes
`--install-dir`, starts what the prompt would with no prompt, answers its own windows from
`KITE_BROKER_TEST_ANSWER`, logging each question to `KITE_BROKER_TEST_LOG`, reads a private hive
file (`KITE_HELPER_TEST_HIVE`) in place of the user's registry and skips the checks of rights and
integrity a test folder and program cannot pass. Releases never ship it.

It never uses UIAccess. The install copies what the app's folder holds at that moment, so in a
per-user install it is only as safe as that folder then; every later start runs the copy in Program
Files.
