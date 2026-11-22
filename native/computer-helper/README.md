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

`process` gives a process's image path and start time (a FILETIME), which the broker checks. `layout`
says how the install folder stands for a Kite program (`missing`, `current` or `outdated`). `install`
and `uninstall` run this program's modes of the same names through Windows' administrator prompt
(`ShellExecute` with `runas`) and wait for them; `elevate` starts the installed copy's broker that
way. Each answers `{ cancelled: true }` when the owner says no at the prompt.

## The elevated helper (Windows)

Opt in, for "允许以管理员权限操作指定程序". See tools/huli/README.md for the whole flow.

```text
kite-computer-helper install --client-image <Kite's program>
kite-computer-helper uninstall
kite-computer-helper broker --pipe kite-computer-<32 hex> --user <SID> --host <pid> --target <pid>
                            --target-image <path> --target-started <FILETIME>
                            --token-sha256 <64 hex> [--idle <ms>] [--lang zh-CN|en]
kite-computer-helper connect --pipe kite-computer-<32 hex> --server <pid>
```

- **install** (as administrator, from the app's folder) copies this program and the
  `cua-driver.exe` beside it into `%ProgramFiles%\Kite Computer Helper`, which only administrators
  can write to, after checking the driver against the SHA-256 built into this program
  (`Build.DriverSha256`, which `build.mjs` writes), with both files held open so no one can change
  them meanwhile. It records Kite's program in `client.txt` and makes `home\{Local,Roaming,Temp}`
  for the driver. A link in place of the folder is refused.
- **broker** (as administrator) runs only from that folder. It checks the program's image path and
  start time and refuses programs that start other programs, then waits for one client on its pipe
  (`D:P(A;;GRGW;;;<SID>)S:(ML;;NWNR;;;ME)`, first instance, no remote clients): the installed
  helper's `connect` mode, a child of `--host` whose image is the recorded Kite program, as `--user`,
  whose first line is `{"token": ...}` hashing to `--token-sha256`. Three refusals end it. It then
  asks the owner in its own window, which names the program and who asks, puts the program in a job
  that lets it start no process, starts the driver (hash checked, held open, in a kill-on-close job,
  with its own home and temporary folders and a PATH without PowerShell), and answers
  `{"ok": true, "pid"}`. It relays MCP: only `initialize`, `ping`, `tools/list`, cancellations and
  the read and input tools Kite uses, with only Kite's arguments and `name`, `arguments` and `_meta`
  in `params`, `delivery_mode: "background"` on every action, scoped to the program's windows, and
  passes on the message it parsed, re-serialized. Before every step but harmless ones (`Risk.cs`) it
  asks the owner again, with what the step does, the typed text and a crop of the window. It ends
  when the client goes, the program or the host exits, or `--idle` passes with no request pending;
  the job limit on the program is lifted then.
- **connect** (without elevation, from that folder) reads the token as its first stdin line, checks
  that the pipe's server is `--server`, running this same installed program, as administrator, hands
  the token over, writes the broker's answer as its first stdout line and relays both ways.

`build.mjs --test` makes a test build for `src/agent-host/computer/elevated.test.ts`: it takes
`--install-dir`, starts its modes with no prompt and answers its own windows from
`KITE_BROKER_TEST_ANSWER`, logging each question to `KITE_BROKER_TEST_LOG`. Releases never ship it.

It never uses UIAccess. The first install runs the app's own copy as administrator, so it is only as
safe as the app's folder at that moment; every later start runs the copy in Program Files.
