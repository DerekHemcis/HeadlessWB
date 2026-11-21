# HeadlessWB 验收清单（逐条需求 → 证据）

> 用途：真机测试时用它逐项打勾，避免"看起来没问题"就收工。
> 每条都给出「怎么验」和「期望证据」。证据全部来自 `verify.ps1` 输出的 JSON、`patch.log` 或肉眼确认。

---

## A. 常驻后台 · 无窗口

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 进程活着 | `Get-Process HeadlessWB` | 有 ≥1 个进程 | `patch.log` 是否有 `patch loaded` |
| 无可见窗口 | `Get-Process HeadlessWB \| Select MainWindowHandle,MainWindowTitle` | `MainWindowHandle` 全为 0，`MainWindowTitle` 全为空 | `patch.log` 是否有 `suppressed BrowserWindow.show` |
| 补丁计数 | `patch.log` 里 `health[30s]` / `health[120s]` | `windows=N visible=0`（**visible 必须为 0**） | 若 visible>0 说明有窗口绕过了 show 压制 |

## B. 无托盘

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 托盘图标不存在 | 看任务栏右下角（可能要点开"^"展开） | 没有 WorkBuddy / HeadlessWB 图标 | `patch.log` 是否有 `Tray` 相关行；确认 `require shim installed` 出现 |
| 托盘对象被哑化 | `patch.log` | 出现 `electron require shim installed (child_process reg filter on)` | 无此行 → 补丁没生效 |

## C. 无通知

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 系统通知不弹 | 手机发任务后看右下角通知中心 | 无 WorkBuddy 通知 | `patch.log` 是否有 `Notification` 相关压制记录 |
| 通知权限被拒 | `patch.log` | `notification permission denied for renderer` | — |
| 无提示音 | 手机发任务时听声音 | 全程无声 | 补丁已 `--mute-audio` + 每窗口静音 |

## D. 开机自启

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| Run 键存在 | `verify.ps1` 的 `autostartValue` | `"C:\...\HeadlessWB.exe" --headless` | 重跑 `install.ps1` |
| 旧版键已清 | `verify.ps1` 的 `legacyWorkbuddyRunKeysRemoved` | `true` | 手动删 `WorkBuddy` / `WorkBuddy.WorkBuddy` |
| **真·重启验证** | 重启电脑，等 2 分钟，**不碰鼠标键盘** | 进程自动出现；托盘/窗口/通知都无 | `patch.log` 是否有新的 `patch loaded` 行（时间戳是开机后） |

> ⚠️ D 项**必须真的重启一次**才算验证过。只测 `install.ps1` 当场启动不算。

## E. 终端命令唤起 GUI

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| status | `tools\wb-ctl.ps1 status` | 输出 JSON，含 `"running": true` | 看 `~\.workbuddy\logs\headlesswb\status.json` 是否生成 |
| show 能出窗口 | `tools\wb-ctl.ps1 show` | 主窗口出现（这是**唯一**该出现窗口的场景） | `patch.log` 是否有 `second-instance` 行 |
| 关窗后仍存活 | 关掉该窗口，`Get-Process HeadlessWB` | 进程仍在 | `patch.log` 是否有 `window-all-closed: keep alive` |
| stop / start | `wb-ctl.ps1 stop` → `start` | 先无进程，后恢复进程 | — |

## F. 禁自动更新

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 更新请求被拦 | `patch.log` | 出现 `blocked update check:` 且 `health[...] updateBlocked≥1` | 首轮检查在启动后 30 秒触发，稍等再看 |
| 版本不变 | `verify.ps1` 的 `status.version` | 始终 `5.11.3`（对得上 `HEADLESSWB_VERSION.txt`） | 若自动升级了说明拦截失效 |
| 无更新弹窗 | 长时间运行观察 | 从不出现更新提示框 | `dialog.showMessageBox` 已压制，双保险 |

## G. 登录（唯一需要人操作的环节之一）

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 浏览器自动弹登录页 | `install.ps1` 后约 12~40 秒 | 默认浏览器打开 `www.workbuddy.cn/console/client-login?...` | `patch.log` 里 `login step1/2/3/4` 的结果 |
| 扫码后登录成功 | 手机扫码 | 手机 App 出现这台设备 | 见 H |
| 重新登录可用 | 手动登出后再 `wb-ctl.ps1 login` | 浏览器重新弹登录页 | `patch.log` 应有 `runLoginFlow: start` 第二次 |

## H. 手机远控（唯一需要人操作的环节之二）

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 设备在线 | 手机 WorkBuddy App 同账号 | 能看到这台电脑 | 登录是否成功；`~\.workbuddy\memory\` 下是否有 uid 文件 |
| 能执行任务 | 手机发「在桌面新建一个空文件夹」 | 电脑上真的出现文件夹；手机收到结果 | 无窗口/无弹窗干扰 |
| 全程无可见反馈 | 执行时盯屏幕 | 无窗口、无托盘闪烁、无通知、无声 | 见 A/B/C |

## I. 隐蔽性——「默认应用」里不该出现

| 项 | 怎么验 | 期望证据 | 不符时看 |
|---|---|---|---|
| 打开方式无 WorkBuddy | 右键任意 .docx → 打开方式 | 列表里没有 WorkBuddy | `patch.log` 是否有 `blocked execFile reg.exe` |
| 设置里无默认应用项 | 设置 → 应用 → 默认应用 | 没有 WorkBuddy | 同上 |

---

## 判定结论怎么写

- **全部通过**：A~I 全勾，附 `verify.ps1` JSON + `patch.log` 尾部。
- **部分失败**：写清哪一项、贴对应「不符时看」的证据，不要贴整屏。
- **进程不活**：先给 `patch.log` 前 30 行（含 `patch loaded` 与否）+ `verify.ps1` 的 `patchLoaded`。

> 最重要的一句：**D 项（重启自启）和 G/H 项（登录+手机远控）是这套东西的命门**，
> A/B/C/E/F/I 都是辅助。命门不过就是没做完。
