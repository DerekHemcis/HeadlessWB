# HeadlessWB 安装说明

> **双击 `HeadlessWB-Setup.exe` 即可安装**，无需解压、无需命令行。

---

## 一、安装

1. 拿到 `HeadlessWB-Setup.exe`（约 392 MB）
2. **双击运行**
3. 会依次看到：
   - 7-Zip 解压进度条（约 1–3 分钟，解压 1.3 GB）
   - 一个黑色控制台窗口显示安装步骤：
     ```
     [1/5] 安装目录: C:\Users\<你>\HeadlessWB
     [2/5] 停止旧进程...
     [3/5] 复制文件...
           已复制 7213 个文件
     [4/5] 校验产物...
           关键文件齐全
           版本 5.11.3 / commit 4f51499...
     [5/5] 注册开机自启并启动...
     ==========================================
        安装完成
     ==========================================
     ```
   - 按任意键关闭窗口

**安装完成后软件已在后台静默运行**：无窗口、无托盘、无通知。

> 如果首次安装（未登录过），会自动打开浏览器到 WorkBuddy 登录页，扫码即可。

---

## 二、安装做了什么

| 步骤 | 说明 |
|---|---|
| 解压 | 自解压到临时目录（约 1.3 GB） |
| 复制 | 到 `%USERPROFILE%\HeadlessWB`（即 `C:\Users\<你>\HeadlessWB`） |
| 自启 | 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `HeadlessWB.exe --headless` |
| 启动 | 已登录 → `--headless`（纯静默）；未登录 → `--login`（弹浏览器登录页） |
| 清理 | 临时目录自动删除 |

**不写系统服务、不需要管理员权限、不改系统设置。**

---

## 三、安装后常用命令

在 `%USERPROFILE%\HeadlessWB` 目录下：

```powershell
# 用完整路径调用（PowerShell 5.1）
$P = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$D = "$env:USERPROFILE\HeadlessWB"

& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" status   # 查看状态
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" show     # 临时显示界面
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" login    # 重新登录
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" stop     # 停止
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\wb-ctl.ps1" start    # 启动
& $P -NoProfile -ExecutionPolicy Bypass -File "$D\tools\verify.ps1"          # 自检（输出 JSON）
```

---

## 四、卸载

```powershell
& $P -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\HeadlessWB\uninstall.ps1"
Remove-Item "$env:USERPROFILE\HeadlessWB" -Recurse -Force
```

> **注意**：登录态在 `%USERPROFILE%\.workbuddy`，卸载脚本**不会删**它。
> 想彻底清干净再手动删该目录（删了要重新扫码）。

---

## 五、日志与排障

| 内容 | 路径 |
|---|---|
| 补丁日志 | `%USERPROFILE%\.workbuddy\logs\headlesswb\patch.log` |
| 结构化状态 | `%USERPROFILE%\.workbuddy\logs\headlesswb\status.json` |
| 主进程日志 | `%USERPROFILE%\.workbuddy\logs\main.log` |
| 构建信息 | `%USERPROFILE%\HeadlessWB\BUILD-INFO.json` |

**看日志记得加 `-Encoding UTF8`**，否则中文在 GBK 控制台会乱码：

```powershell
Get-Content "$env:USERPROFILE\.workbuddy\logs\headlesswb\patch.log" -Encoding UTF8 -Tail 50
```

---

## 六、常见问题

| 现象 | 处理 |
|---|---|
| 双击没反应 / 秒退 | 杀软拦截。把 `HeadlessWB-Setup.exe` 加入白名单后重试 |
| 提示"安装文件损坏" | 分卷合并后 hash 不对，重新下载 |
| 安装成功但手机看不到设备 | 未登录。跑 `wb-ctl.ps1 login` 扫码 |
| 托盘有图标 / 弹窗 | 不该发生。把 `patch.log` 发我 |
| 想换安装位置 | 默认 `%USERPROFILE%\HeadlessWB`。不要改到更深路径（Windows 260 字符限制） |

---

## 七、校验值（本轮）

| 项 | 值 |
|---|---|
| 文件名 | `HeadlessWB-Setup.exe` |
| 大小 | `411,770,064` 字节（约 392 MB） |
| SHA256 | `C051890969851862AF297C57FDA97C6E3F29C5C4BE456B1668B746F3C66AF3FF` |
| 仓库 commit | `4f51499477c9446bcbd36050a3a302a50b8132ef` |
| appVersion | 5.11.3 |

校验：

```powershell
(Get-Item .\HeadlessWB-Setup.exe).Length
(Get-FileHash .\HeadlessWB-Setup.exe -Algorithm SHA256).Hash
```

---

## 八、如果你只有分卷（没有完整 exe）

仓库 `release/setup-parts/` 下有 5 个分卷（每个 ≤90MB，避开 GitHub 100MB 限制）。

```powershell
$C = '86e4cdf'
$R = "https://raw.githubusercontent.com/DerekHemcis/HeadlessWB/$C"
$D = 'C:\Users\xuesh\hw-setup'
New-Item -ItemType Directory -Path $D -Force | Out-Null

foreach ($s in @('aa','ab','ac','ad','ae')) {
  curl.exe -L --retry 10 --retry-all-errors -C - -o "$D\HeadlessWB-Setup.exe.part-$s" "$R/release/setup-parts/HeadlessWB-Setup.exe.part-$s"
}
curl.exe -L -o "$D\join-setup-parts.ps1" "$R/release/join-setup-parts.ps1"

# 合并（脚本内自带大小 + SHA256 校验）
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File "$D\join-setup-parts.ps1"
```

合并后得到 `$D\HeadlessWB-Setup.exe`，双击安装。
