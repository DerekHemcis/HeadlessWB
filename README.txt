HeadlessWB —— WorkBuddy 无头版部署说明
==========================================

安装（用户级，无需管理员）：
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

首次安装会自动打开浏览器登录页，扫码登录后即静默后台运行。
手机 WorkBuddy App 登录同一账号即可远程操控本机。

常用命令（在本目录）：
  .\tools\wb-ctl.ps1 status   # 状态
  .\tools\wb-ctl.ps1 show     # 临时显示 GUI
  .\tools\wb-ctl.ps1 login    # 重新登录
  .\tools\wb-ctl.ps1 stop     # 停止
  .\tools\wb-ctl.ps1 start    # 静默启动

日志：%USERPROFILE%\.workbuddy\logs\headlesswb\patch.log
卸载：powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1

语言 / Language:
  English : README.md
  简体中文 : README.zh-CN.md
  安装说明 : docs/install-guide.md
