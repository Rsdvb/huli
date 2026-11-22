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
