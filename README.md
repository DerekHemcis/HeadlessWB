# HeadlessWB

**English** | [简体中文](README.zh-CN.md)

A headless, stealth build of the **WorkBuddy 5.11.3** Windows desktop client.

Runs silently in the background with no window, no tray icon, no notifications and no sound,
so the machine can be driven remotely from the official WorkBuddy mobile app. The only time
anything becomes visible is a single browser tab during sign-in.

> **Download:** [Releases → v5.11.3](https://github.com/DerekHemcis/HeadlessWB/releases/tag/v5.11.3)
>
> **Install:** download `HeadlessWB-Setup.exe` (~392 MB) and **double-click it**. Done.

---

## Install

1. Download **`HeadlessWB-Setup.exe`** from the [latest release](https://github.com/DerekHemcis/HeadlessWB/releases/latest).
2. **Double-click it.**
3. You will see:
   - a 7-Zip extraction progress bar (1–3 min, expands to ~1.3 GB)
   - a console window showing five install steps
   - `Installation complete` — press any key to close
4. The app is now running silently in the background.

| | |
|---|---|
| Install location | `%USERPROFILE%\HeadlessWB` |
| Autostart | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `HeadlessWB.exe --headless` |
| Admin required | No |
| Services / drivers | None |

**First run** opens your default browser at the WorkBuddy sign-in page — scan the QR code.
**Re-installing on an already signed-in machine** starts silently without re-authentication
(the session lives in `%USERPROFILE%\.workbuddy` and is never touched by the installer).

### Verify the download

```
File    HeadlessWB-Setup.exe
Size    411,770,064 bytes
SHA256  C051890969851862AF297C57FDA97C6E3F29C5C4BE456B1668B746F3C66AF3FF
```

```powershell
(Get-FileHash .\HeadlessWB-Setup.exe -Algorithm SHA256).Hash
```

---

## Features

| Property | How it is achieved |
|---|---|
| **No window** | `BrowserWindow.prototype.show` suppressed; the sign-in window renders transparent, off-screen and with `skipTaskbar`, then is hidden |
| **No tray icon** | `electron.Tray` replaced with a no-op object that tolerates unknown methods |
| **No notifications** | `electron.Notification` stubbed out **and** renderer notification permission denied at the session layer |
| **No sound** | global `--mute-audio` plus per-window `setAudioMuted(true)` |
| **No dialogs** | `dialog.showMessageBox*` suppressed |
| **Not in "Open with"** | `reg.exe` writes for office file associations are filtered out |
| **No auto-update** | `/v2/update` requests short-circuited (including forced upgrades) |
| **No startup-repair popup** | `RepairApp.exe` (the helper that pops "WorkBuddy 启动修复") is removed from the build |
| **On-demand GUI** | `wb-ctl.ps1 show` restores and displays the window |
| **Autostart** | single HKCU Run key, pure `--headless` |

---

## Commands

```powershell
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$D = "$env:USERPROFILE\HeadlessWB"

& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" status   # status (JSON)
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" show     # show GUI temporarily
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" login    # re-open browser sign-in
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" stop     # stop
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" start    # start silently
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\verify.ps1"          # self-check (JSON)
```

Logs — always read with `-Encoding UTF8`, otherwise Chinese text is garbled on GBK consoles:

```powershell
Get-Content "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Encoding UTF8 -Tail 50
```

---

## Runtime modes

| Mode | Behaviour |
|---|---|
| default / `--headless` | No window, tray, notification or taskbar flash. Runs in background, remotely controllable. |
| `--login` | Same, plus opens the system browser at the sign-in page. Skips entirely if already signed in. |
| `--show` | Actually shows the main window (debug). Closing it keeps the process alive. |
| `--status` | Writes structured status to `status.json`, then exits. |

`--status` writes a file because Electron is a GUI-subsystem binary on Windows — `console.log`
output is not visible from a terminal.

---

## Build from source

Requires **Node 18+** and network access. Builds on macOS/Linux; the artifact targets Windows.

```bash
node build.mjs                  # download official installer → patch → repack → build installer
node build.mjs --force-download # always fetch the newest official release
node verify-build.mjs           # 6-step verification
```

Outputs:

```
dist/HeadlessWB/            portable app directory
dist/HeadlessWB.zip         portable archive (split into release/parts/)
dist/HeadlessWB-Setup.exe   single-file installer (7z SFX, split into release/setup-parts/)
```

### What the build does

1. Downloads the official `WorkBuddy-win32-x64-user` installer and verifies its SHA-256.
2. Extracts the NSIS payload → `app-64.7z` → application directory.
3. Injects `headless-patch.js` into `app.asar` and repacks it, **preserving every file's
   `unpacked` flag and duplicate-offset semantics**.
4. **Verifies all 12,232 archive entries**: every payload's SHA-256 must equal the hash
   recorded in the asar header. A single mismatch aborts the build.
5. Disables the `EnableEmbeddedAsarIntegrityValidation` Electron fuse — repacking necessarily
   changes the archive hash, and Electron 37 enforces that check on Windows too.
6. Renames `WorkBuddy.exe` → `HeadlessWB.exe`, bundles the VC++ runtime DLLs, removes
   `RepairApp.exe`, updates `install-manifest.json`.
7. **Asserts `dist/` and source files are byte-identical** (SHA-256) and writes `BUILD-INFO.json`.
8. Packs everything into a 7-Zip self-extracting installer.

---

## How it works

The patch loads as the first line of `main/index.js` and:

- takes the **real** `electron` module before any application code does;
- installs a `Module.prototype.require` shim so later `require('electron')` calls receive a
  proxy with `Tray` / `Notification` / `BrowserWindow` replaced;
- **also** rewrites the real objects' `net.fetch`, `dialog.showMessageBox*` and
  `shell.openExternal` methods, because the minified app uses `await import('electron')` in
  22 places, which bypasses the `require` shim;
- filters `child_process` so office file-association `reg.exe` writes and `RepairApp` spawns
  never happen.

For sign-in, the patch polls for the login card (`.login-view__button`) to mount, then clicks
it via class selector, `closest()`-resolved element, synthetic pointer events and finally a
direct React fiber `props.onClick` call. If the machine is already signed in, a preflight check
aborts the whole flow before anything is clicked.

---

## Known limitations

1. **Unsigned binary.** Windows SmartScreen may warn on first run — click *More info → Run anyway*.
   Removing this requires a code-signing certificate.
2. **Windows 10/11 only.** Win7/8 lack the UCRT the bundled native modules need.
3. **Do not move or rename the install directory** — the autostart key points at an absolute path.
4. **Install path must stay short** (≤255 chars). The longest relative path inside the artifact
   is 209 characters, and Windows still enforces a 260-character limit by default.
5. **Cannot coexist with the original WorkBuddy client** — both use the same userData directory
   and therefore the same Electron single-instance lock.
6. The sign-in automation depends on WorkBuddy's DOM structure. If an upstream release changes it,
   the patch falls back to opening the sign-in page directly and logs what it found.

---

## Uninstall

```powershell
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\HeadlessWB\uninstall.ps1"
Remove-Item "$env:USERPROFILE\HeadlessWB" -Recurse -Force
```

Your session in `%USERPROFILE%\.workbuddy` is intentionally preserved — deleting it means
re-scanning the QR code.

---

## Repository layout

```
HeadlessWB/
├── build.mjs                     build pipeline + installer packaging
├── verify-build.mjs              6-step verification
├── patch/headless-patch.js       runtime patch (the core of this project)
├── setup.ps1                     installer entry point (called by the SFX)
├── install.ps1 / uninstall.ps1
├── tools/{deploy,verify,wb-ctl}.ps1
├── assets/7z.sfx                 7-Zip SFX module (LGPL, from the official package)
├── docs/
│   ├── install-guide.md
│   ├── acceptance-checklist.md
│   ├── razor-test-procedure.md
│   └── specs/…-design.md         design document + every issue found on real hardware
└── release/                      split archives for GitHub (90 MB parts)
```

---

## Disclaimer

This project modifies a third-party desktop application for the purpose of running it headlessly
**on hardware you own and control**, so that it can be driven remotely from your own mobile app.

It bundles no WorkBuddy code of its own — the build downloads the official installer from Tencent's
CDN at build time. All WorkBuddy trademarks and copyrights belong to Tencent. You are responsible
for complying with WorkBuddy's terms of service in your jurisdiction.

Do not use this to access, monitor or control a machine you do not own or have explicit
permission to control.
