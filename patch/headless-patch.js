'use strict';
/**
 * HeadlessWB runtime patch
 * -------------------------
 * 加载时机：asar 内 main/index.js 的第一行
 *   require(require('path').join(process.resourcesPath, 'headless-patch.js'));
 *
 * 核心思路：本补丁在【任何业务代码 require('electron') 之前】运行，先取到真实的
 * electron 模块，再通过 Module.prototype.require 垫片，把后续所有 require('electron')
 * 换成代理对象，从而把 Tray / Notification / BrowserWindow.show / dialog / net.fetch /
 * shell.openExternal 等关键行为替换掉（直接 defineProperty 覆盖 electron 导出在现代
 * Electron 上会因描述符不可配置而失败，垫片方案才是可靠的）。
 *
 * 功能：
 *   1. --headless(默认) / --show / --login / --status
 *   2. headless：无窗口、无托盘、无通知、无任务栏闪烁、无对话框
 *   3. 保活：窗口全关不退出
 *   4. 禁用自动更新（拦截 net.fetch 对 /v2/update 的请求）
 *   5. 屏蔽原版开机自启写入
 *   6. --login：daemon 起来后在隐藏窗口自动点登录按钮 → 打开浏览器登录页
 *   7. --show：真实显示主窗口；已有实例则 second-instance 转发
 *   8. --status：打印状态后立即退出
 */
(function () {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  const argv = process.argv.slice(1);
  const has = (a) => argv.includes(a);
  const MODE = {
    headless: !has('--show') && !has('--status'),
    show: has('--show'),
    login: has('--login'),
    status: has('--status'),
  };

  // ---- 日志 ----
  const home = process.env.USERPROFILE || os.homedir();
  const LOG_DIR = path.join(home, '.workbuddy', 'logs', 'headlesswb');
  const PID_FILE = path.join(LOG_DIR, 'instance.pid');
  let logStream = null;
  function ensureLog() {
    if (logStream) return;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, 'patch.log'), { flags: 'a' });
      logStream.write(`\n[${new Date().toISOString()}] patch loaded pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
    } catch (e) {}
  }
  function log() {
    try {
      ensureLog();
      if (logStream) logStream.write(`[${new Date().toISOString()}] ${Array.prototype.join.call(arguments, ' ')}\n`);
    } catch (e) {}
  }

  // ---- 真实 electron（垫片装好之前取） ----
  const Module = require('module');
  const origRequire = Module.prototype.require;
  const realElectron = origRequire.call(module, 'electron');

  // --status：注意 Electron 在 Windows 上是 GUI 子系统程序，
  // 终端里看不到 console.log 输出。所以必须同时写 status.json 给 wb-ctl/verify 读。
  if (MODE.status) {
    const STATUS_FILE = path.join(LOG_DIR, 'status.json');
    let pidFromFile = null;
    let running = false;
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        pidFromFile = pid;
        try { process.kill(pid, 0); running = true; } catch (e) { running = false; }
      }
    } catch (e) {}

    let version = 'unknown';
    try { version = realElectron.app.getVersion(); } catch (e) {}

    const info = {
      app: 'HeadlessWB',
      version,
      statusPid: process.pid,
      runningInstance: running ? pidFromFile : null,
      running: running,
      pidFile: PID_FILE,
      patchLog: path.join(LOG_DIR, 'patch.log'),
      mode: 'status',
      at: new Date().toISOString(),
    };
    const json = JSON.stringify(info, null, 2);
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(STATUS_FILE, json, 'utf8');
    } catch (e) {}
    try { console.log(json); } catch (e) {}
    process.exit(0);
  }

  ensureLog();
  log(`mode=${MODE.headless ? 'headless' : 'show'} login=${MODE.login} show=${MODE.show}`);

  const app = realElectron.app;
  let showRequested = MODE.show;
  let loginDone = false;

  // 静音：无头模式下任何声音都是多余的暴露面（提示音、语音播放）
  if (MODE.headless) {
    try {
      app.commandLine.appendSwitch('mute-audio');
      log('audio muted via --mute-audio');
    } catch (e) { log('mute-audio switch failed', e.message); }
  }
  const externalUrls = [];
  let updateBlockedCount = 0;

  // ============================================================
  // 哑对象
  //   Electron 对象上任何未预期的方法调用都会抛 TypeError，足以中断原版初始化流程。
  //   所以哑对象同时用「显式方法 + Proxy 万能兜底」：未知属性一律返回 no-op 函数，
  //   保证无论官方怎么改版都不会因为调用哑对象而崩。
  // ============================================================
  function withNoopFallback(obj) {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined; // 避免被当成 thenable
        return function () {};
      },
    });
  }

  class DummyTray {
    constructor() { return withNoopFallback(this); }
    destroy() {}
    setToolTip() {}
    setContextMenu() {}
    setTitle() {}
    setImage() {}
    setPressedImage() {}
    setIgnoreDoubleClickEvents() {}
    getIgnoreDoubleClickEvents() { return false; }
    popUpContextMenu() {}
    closeContextMenu() {}
    displayBalloon() {}
    removeBalloon() {}
    focus() {}
    setHighlightMode() {}
    getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
    isDestroyed() { return true; }  // 让调用方认为托盘不可用，直接跳过托盘相关工作
    on() { return this; }
    once() { return this; }
    off() { return this; }
    removeListener() { return this; }
    removeAllListeners() { return this; }
  }
  DummyTray.prototype.isDestroyed = function () { return true; };

  class DummyNotification {
    constructor() { return withNoopFallback(this); }
    static isSupported() { return false; }
    show() {}
    close() {}
    isDestroyed() { return true; }
    on() { return this; }
    once() { return this; }
    off() { return this; }
    removeListener() { return this; }
    removeAllListeners() { return this; }
  }

  // ============================================================
  // BrowserWindow：包装构造函数 + 显示压制
  // ============================================================
  const RealBrowserWindow = realElectron.BrowserWindow;
  const allWindows = new Set();
  const realShow = RealBrowserWindow.prototype.show;
  const realShowInactive = RealBrowserWindow.prototype.showInactive;

  function allowShow() {
    if (!MODE.headless) return true;
    if (showRequested) return true;
    // 登录阶段：允许真正 show（否则 Chromium 认为窗口不可见，DOM 可能不完整），
    // 但窗口已被设为透明 + 屏幕外 + 不占任务栏，用户看不到。
    if (MODE.login && !loginDone) return true;
    return false;
  }

  try {
    RealBrowserWindow.prototype.show = function () {
      if (allowShow()) return realShow.apply(this, arguments);
      log('suppressed BrowserWindow.show');
    };
    RealBrowserWindow.prototype.showInactive = function () {
      if (allowShow()) return realShowInactive.apply(this, arguments);
      log('suppressed BrowserWindow.showInactive');
    };
    RealBrowserWindow.prototype.flashFrame = function () {};
    // 任务栏角标/进度（Windows 隐藏窗口本就无任务栏按钮，双保险）
    try { RealBrowserWindow.prototype.setOverlayIcon = function () {}; } catch (e) {}
    try { RealBrowserWindow.prototype.setProgressBar = function () {}; } catch (e) {}
  } catch (e) { log('prototype patch failed', e.message); }

  function HeadlessBrowserWindow(options) {
    // 隐藏窗口默认会被 Chromium 后台节流，DOM 可能迟迟不完整 → 点不到按钮。
    // 强制关闭节流；同时登录阶段把窗口放到屏幕外 + 不进任务栏，保证真实渲染但用户不可见。
    try {
      const o = options && typeof options === 'object' ? { ...options } : {};
      o.webPreferences = { ...(o.webPreferences || {}), backgroundThrottling: false };
      if (MODE.login && MODE.headless) {
        o.skipTaskbar = true;
        o.show = o.show === false ? false : o.show;   // 保留原值
        o.x = -32000;
        o.y = -32000;
      }
      options = o;
    } catch (e) { log('window option patch failed', e.message); }
    const win = new RealBrowserWindow(options);
    allWindows.add(win);
    win.once('closed', () => allWindows.delete(win));
    if (MODE.headless) {
      try { win.webContents.setAudioMuted(true); } catch (e) { log('setAudioMuted failed', e.message); }
      if (MODE.login) {
        // 透明 + 屏幕外显示：渲染完整、用户看不见、也不占任务栏
        try {
          win.setSkipTaskbar(true);
          win.setOpacity(0);
          win.setPosition(-32000, -32000);
        } catch (e) { log('login window hide failed', e.message); }
      }
      // 页面跳转后（登录页/引导页）再压一次，防止重设
      try {
        win.webContents.on('did-finish-load', () => {
          try { win.webContents.setAudioMuted(true); } catch (e) {}
        });
      } catch (e) {}
    }
    return win;
  }
  HeadlessBrowserWindow.prototype = RealBrowserWindow.prototype;
  Object.setPrototypeOf(HeadlessBrowserWindow, RealBrowserWindow);
  for (const k of Object.getOwnPropertyNames(RealBrowserWindow)) {
    if (k === 'prototype' || k === 'length' || k === 'name') continue;
    try { HeadlessBrowserWindow[k] = RealBrowserWindow[k]; } catch (e) {}
  }

  // ============================================================
  // 对话框 / shell / net：直接改真实对象的方法（而非包装对象），
  // 这样 require 代理、动态 import(`electron`)、直接引用三条路径全部覆盖。
  // ============================================================
  const realDialog = realElectron.dialog;
  if (realDialog) {
    try {
      const realBox = realDialog.showMessageBox && realDialog.showMessageBox.bind(realDialog);
      const realBoxSync = realDialog.showMessageBoxSync && realDialog.showMessageBoxSync.bind(realDialog);
      if (realBox) {
        realDialog.showMessageBox = function () {
          if (!allowShow()) { log('suppressed dialog.showMessageBox'); return Promise.resolve({ response: 0, checkboxChecked: false }); }
          return realBox.apply(realDialog, arguments);
        };
      }
      if (realBoxSync) {
        realDialog.showMessageBoxSync = function () {
          if (!allowShow()) { log('suppressed dialog.showMessageBoxSync'); return 0; }
          return realBoxSync.apply(realDialog, arguments);
        };
      }
    } catch (e) { log('dialog patch failed', e.message); }
  }

  const realShell = realElectron.shell;
  function openExternal(url) {
    if (realShell && realShell.openExternal) return realShell.openExternal(url);
  }
  if (realShell && realShell.openExternal) {
    const realOpenExternal = realShell.openExternal.bind(realShell);
    try {
      realShell.openExternal = function (url) {
        externalUrls.push(String(url));
        // 完整记录（不截断）：真机要用这条 URL 复用/排查；仅遮蔽 code
        log('openExternal:', String(url).replace(/([?&]code=)[^&]+/i, '$1***'));
        return realOpenExternal(url);
      };
    } catch (e) { log('shell.openExternal patch failed', e.message); }
  }

  const realNet = realElectron.net;
  function make204Response() {
    return {
      ok: true, status: 204, statusText: 'No Content', url: '',
      headers: { get: () => null }, body: null,
      json: () => Promise.resolve({}), text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }
  if (realNet && typeof realNet.fetch === 'function') {
    const realFetch = realNet.fetch.bind(realNet);
    const blockedFetch = function (url, opts) {
      const s = String(url);
      if (/v2\/update\?/.test(s)) { updateBlockedCount++; log('blocked update check:', s.slice(0, 120)); return Promise.resolve(make204Response()); }
      return realFetch(url, opts);
    };
    try { realNet.fetch = blockedFetch; }
    catch (e) {
      try { Object.defineProperty(realNet, 'fetch', { value: blockedFetch, configurable: true, writable: true }); }
      catch (e2) { log('net.fetch patch failed', e2.message); }
    }
    log('net.fetch patched (update blocked)');
  }

  // ============================================================
  // URL 观测：真机提醒过一种可能——应用可能用 window.open / 新建窗口打开登录页，
  // 而不是 shell.openExternal，那样我们就看不到。这里把相关 URL 全部记下来。
  // ============================================================
  // IPC 观测：renderer 的 openAuth.login 是经 workbuddy:invoke 桥到主进程的。
  // 记下这类调用的入参与失败原因，用来判定"点击到底有没有触发登录逻辑"。
  try {
    const ipc = realElectron.ipcMain;
    if (ipc && typeof ipc.handle === 'function') {
      const realHandle = ipc.handle.bind(ipc);
      ipc.handle = function (channel, listener) {
        if (channel === 'workbuddy:invoke') {
          return realHandle(channel, function (event, ...args) {
            let preview = '';
            try { preview = JSON.stringify(args).slice(0, 220); } catch (e) { preview = '<unserializable>'; }
            if (/openAuth|login|auth/i.test(preview)) log('ipc invoke:', preview);
            const r = listener(event, ...args);
            if (r && typeof r.then === 'function') {
              return r.then(
                (v) => { if (/openAuth|login|auth/i.test(preview)) log('ipc result ok'); return v; },
                (e) => { if (/openAuth|login|auth/i.test(preview)) log('ipc result ERR:', String(e && e.message || e).slice(0, 200)); throw e; }
              );
            }
            return r;
          });
        }
        return realHandle(channel, listener);
      };
      log('ipcMain.handle wrapped (login invoke observability)');
    }
  } catch (e) { log('ipcMain wrap failed', e.message); }

  try {
    app.on('web-contents-created', (ev, wc) => {
      try {
        wc.on('will-navigate', (e, url) => log('navigate:', String(url).slice(0, 160)));
      } catch (e) {}
      try {
        wc.on('did-create-window', (w) => { try { log('window-created:', String(w.webContents.getURL()).slice(0, 160)); } catch (e) {} });
      } catch (e) {}
    });
    app.on('browser-window-created', () => {});
    log('url observers installed');
  } catch (e) { log('url observers failed', e.message); }

  try {
    app.whenReady().then(() => {
      const ses = realElectron.session && realElectron.session.defaultSession;
      if (ses && ses.webRequest && ses.webRequest.onBeforeRequest) {
        ses.webRequest.onBeforeRequest({ urls: ['*://*/**'] }, (details, cb) => {
          const u = String(details.url || '');
          if (/client-login|device\/auth\/code|\/login/i.test(u)) {
            log('request:', u.replace(/([?&]code=)[^&]+/i, '$1***').slice(0, 200));
          }
          cb({});
        });
        log('webRequest login-url observer installed');
      }
    }).catch(() => {});
  } catch (e) { log('webRequest observer failed', e.message); }

  // ============================================================
  // app 行为补丁（真实 app 实例上的方法可写）
  // ============================================================
  try { app.setBadgeCount = function () {}; } catch (e) {}
  try { app.setLoginItemSettings = function () { log('suppressed app.setLoginItemSettings'); }; } catch (e) {}
  // 拒绝渲染进程的 HTML5 通知权限（防止隐藏窗口里冒系统通知）
  if (MODE.headless) {
    app.whenReady().then(() => {
      try {
        const ses = realElectron.session && realElectron.session.defaultSession;
        if (ses && ses.setPermissionRequestHandler) {
          ses.setPermissionRequestHandler((wc, permission, cb) => {
            try { cb(permission !== 'notifications'); } catch (e) {}
          });
          log('notification permission denied for renderer');
        }
      } catch (e) { log('permission handler patch failed', e.message); }
    }).catch(() => {});
  }
  if (MODE.headless) {
    app.on('window-all-closed', () => { log('window-all-closed: keep alive'); });
    const realQuit = app.quit ? app.quit.bind(app) : null;
    if (realQuit) {
      app.quit = function () {
        if (process.env.HEADLESSWB_ALLOW_EXIT === '1') return realQuit();
        log('suppressed app.quit');
      };
    }

    // 退出路径可观测性：任何试图结束进程的动作都记日志，便于真机排障
    app.on('before-quit', () => log('event: before-quit'));
    app.on('will-quit', () => log('event: will-quit'));
    process.on('exit', (code) => log('process exit, code =', code));

    // 健康快照：真机测试时只看 patch.log 就能判断"到底活没活、窗口藏没藏住"
    const snapshot = (tag) => {
      try {
        const wins = (realElectron.BrowserWindow && realElectron.BrowserWindow.getAllWindows)
          ? realElectron.BrowserWindow.getAllWindows() : [];
        const alive = wins.filter(w => w && !w.isDestroyed());
        const visible = alive.filter(w => { try { return w.isVisible(); } catch (e) { return false; } });
        log(`health[${tag}] pid=${process.pid} windows=${alive.length} visible=${visible.length} ` +
            `externalOpen=${externalUrls.length} updateBlocked=${updateBlockedCount} loginOpened=${hasEverOpenedLogin()} showRequested=${showRequested} loginDone=${loginDone}`);
      } catch (e) { log(`health[${tag}] failed:`, e.message); }
    };
    app.whenReady().then(() => {
      setTimeout(() => snapshot('30s'), 30000);
      setTimeout(() => snapshot('120s'), 120000);
    }).catch(() => {});
  }

  // ============================================================
  // 阻断「办公文件关联」注册（隐蔽性）
  //   原版启动时会跑 repairOfficeFileAssociations，用 reg.exe 写：
  //     HKCU\Software\Classes\Applications\<exe>\shell\open\command
  //     HKCU\Software\Classes\<AUMID>.Capabilities
  //     HKCU\Software\RegisteredApplications
  //   结果：Windows「设置 → 默认应用」和右键「打开方式」里会出现 WorkBuddy。
  //   无头版不需要抢占 .docx 等文件类型，直接拦掉这些 reg 调用。
  //   注意只拦这组键，协议注册（setAsDefaultProtocolClient 写 workbuddy://）保持不动，
  //   因为它可能参与浏览器登录回调。
  // ============================================================
  const BLOCKED_REG_PATTERNS = [
    /Software\\+Classes\\+Applications\\+/i,
    /\.Capabilities/i,
    /Software\\+RegisteredApplications/i,
  ];
  function shouldBlockRegCall(args) {
    const joined = (Array.isArray(args) ? args : []).map(String).join(' ');
    if (!/\bADD\b|\bDELETE\b/i.test(joined)) return false;
    return BLOCKED_REG_PATTERNS.some(re => re.test(joined));
  }
  function wrapChildProcess(cp) {
    if (!cp || cp.__headlessWrapped) return cp;
    const isReg = (file) => /(^|[\\/])reg(\.exe)?$/i.test(String(file || ''));
    // 启动修复 helper 会弹「WorkBuddy 启动修复」模态框（清单校验必然失败：我们改了 exe 名 + 重打包 asar）
    const isRepairHelper = (file) => /(^|[\\/])RepairApp(\.exe)?$/i.test(String(file || ''));
    const wrap = (name, argsIndex) => {
      const orig = cp[name];
      if (typeof orig !== 'function') return;
      cp[name] = function (...argv) {
        const file = argv[0];
        const args = argv[argsIndex];
        if (isRepairHelper(file)) {
          log(`blocked ${name} RepairApp helper spawn`);
          if (name === 'execFileSync' || name === 'spawnSync') {
            return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0, output: [] };
          }
          try {
            const { EventEmitter } = require('events');
            const fake = new EventEmitter();
            fake.pid = 0; fake.stdout = null; fake.stderr = null; fake.stdin = null;
            fake.kill = () => {};
            setImmediate(() => { try { fake.emit('exit', 0, null); fake.emit('close', 0, null); } catch (e) {} });
            return fake;
          } catch (e) { return undefined; }
        }
        if (isReg(file) && shouldBlockRegCall(args)) {
          log(`blocked ${name} reg.exe: ${(args || []).join(' ').slice(0, 140)}`);
          if (name === 'execFileSync' || name === 'spawnSync') {
            return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0, output: [] };
          }
          try {
            const { EventEmitter } = require('events');
            const fake = new EventEmitter();
            fake.pid = 0; fake.stdout = null; fake.stderr = null; fake.stdin = null;
            fake.kill = () => {};
            setImmediate(() => { try { fake.emit('exit', 0, null); fake.emit('close', 0, null); } catch (e) {} });
            return fake;
          } catch (e) { return undefined; }
        }
        return orig.apply(cp, argv);
      };
    };
    wrap('execFile', 1);
    wrap('spawn', 1);
    wrap('execFileSync', 1);
    wrap('spawnSync', 1);
    cp.__headlessWrapped = true;
    return cp;
  }

  // ============================================================
  // 代理：后续业务代码 require('electron') / require('child_process') 拿到的是它
  // ============================================================
  const overrides = {
    Tray: DummyTray,
    Notification: DummyNotification,
    BrowserWindow: HeadlessBrowserWindow,
  };
  // dialog / shell / net 已直接改真实对象方法，代理直接透传真实对象即可
  const patchedElectron = new Proxy(realElectron, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      return Reflect.get(target, prop, target);
    },
  });

  Module.prototype.require = function (id) {
    if (id === 'electron') return patchedElectron;
    if (id === 'child_process' || id === 'node:child_process') {
      return wrapChildProcess(origRequire.apply(this, arguments));
    }
    return origRequire.apply(this, arguments);
  };
  log('electron require shim installed (child_process reg filter on)');

  // ============================================================
  // second-instance 转发
  // ============================================================
  app.on('second-instance', (event, commandLine) => {
    const args = Array.isArray(commandLine) ? commandLine : [];
    log('second-instance', JSON.stringify(args));
    if (args.includes('--show')) {
      showRequested = true;
      const live = Array.from(allWindows).filter(w => w && !w.isDestroyed());
      if (live.length) {
        const w = live[0];
        try {
          // 登录阶段窗口被设成透明+屏幕外+不进任务栏，show 前必须还原，否则"显示了但看不见"
          w.setSkipTaskbar(false);
          w.setOpacity(1);
          try { w.center(); } catch (e) {}
          realShow.apply(w);
          try { w.focus(); } catch (e) {}
          log('--show: window restored & shown');
        } catch (e) { log('--show failed:', e.message); }
      }
    }
    if (args.includes('--login')) runLoginFlow();
  });

  // ============================================================
  // --login
  //   三级策略（从可靠到兜底）：
  //     1) 在隐藏窗口里点「登录」按钮 → 应用自身走 shell.openExternal 打开浏览器
  //     2) 若没打开：点「复制登录链接」→ 读剪贴板拿 URL → 我们自己 shell.openExternal
  //        （原版 i18n 里确实有 login.copyLink / login.browserNotOpened 兜底面板）
  //     3) 最后兜底：直接开官网登录页
  // ============================================================
  // 可重入：登出/过期后再次 --login 必须能重新跑（早期版本用一次性 latch，是个 bug）
  let loginFlowInProgress = false;
  const clickedOnce = { v: false };
  let loginBaseline = 0;          // 本轮流程开始时的 externalUrls 长度
  function pickLiveWindow() {
    for (const w of allWindows) {
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) return w;
    }
    return null;
  }
  // 本轮流程内是否已打开过登录 URL（只看基线之后的，避免历史记录误判）
  function loginSucceeded() {
    return externalUrls.slice(loginBaseline).some(u => /client-login|\/login/.test(u));
  }
  // 历史任意时刻是否开过登录页（健康快照用）
  function hasEverOpenedLogin() {
    return externalUrls.some(u => /client-login|\/login/.test(u));
  }

  function runJsInWindow(js) {
    const win = pickLiveWindow();
    if (!win) { log('runJs: no live window'); return Promise.resolve('no-window'); }
    try {
      return win.webContents.executeJavaScript(js, true).catch(e => 'err:' + e.message);
    } catch (e) {
      return Promise.resolve('throw:' + e.message);
    }
  }

  // ============================================================
  // 点击脚本
  //   真机教训：登录按钮很可能是 div.oneid-button 这类非 button/a 元素，
  //   早期只查 button,a,[role=button] 全部落空（真机 login step1 -> none）。
  //   现在：宽选择器 + 叶子节点全文扫描 + iframe/shadowRoot 穿透。
  // ============================================================
  const CLICK_JS_TEMPLATE = (textsJson, mode) => `(function () {
    var MODE = ${JSON.stringify(mode)};
    var TEXTS = ${textsJson};
    var LOGIN = ['登录','登 录','扫码登录','立即登录','登录/注册','Sign in','Log in','Login'];
    var ADV   = ['同意并继续','同意','继续','下一步','开始使用','开始','知道了','跳过','Get Started','Agree','Continue','Next','Skip','Got it'];
    var COPY  = ['复制登录链接','复制链接','重新发起登录','重新登录'];
    var TARGET = MODE === 'copy' ? COPY : (MODE === 'advance' ? ADV : LOGIN);

    function norm(s) { return (s || '').replace(/\s+/g, ''); }

    // 收集所有根（含 iframe / shadowRoot）
    function roots() {
      var out = [document];
      try {
        var ifr = document.querySelectorAll('iframe');
        for (var i = 0; i < ifr.length; i++) {
          try { if (ifr[i].contentDocument) out.push(ifr[i].contentDocument); } catch (e) {}
        }
      } catch (e) {}
      return out;
    }

    function collect(doc) {
      var sel = 'button,a,[role=button],[class*=button],[class*=Button],[class*=oneid],[class*=Oneid],' +
                '[class*=login],[class*=Login],[class*=btn],[class*=Btn],[tabindex],div,span';
      var list = [];
      try { list = Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (e) { list = []; }
      // 追加 shadowRoot 内的元素
      var shadow = [];
      try {
        var all = doc.querySelectorAll('*');
        for (var i = 0; i < all.length && i < 8000; i++) {
          if (all[i].shadowRoot) {
            try { shadow = shadow.concat(Array.prototype.slice.call(all[i].shadowRoot.querySelectorAll('*'))); } catch (e) {}
          }
        }
      } catch (e) {}
      return list.concat(shadow);
    }

    function visible(el) {
      try {
        if (!el.getClientRects || el.getClientRects().length === 0) return false;
        var st = window.getComputedStyle(el);
        if (!st) return true;
        return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      } catch (e) { return true; }
    }

    var diag = { href: '', title: '', ready: '', total: 0, texts: [], hits: [] };
    try {
      diag.href = String(location.href).slice(0, 160);
      diag.title = String(document.title || '').slice(0, 80);
      diag.ready = String(document.readyState);
      diag.total = document.querySelectorAll('*').length;
      var mk = String(location.href).match(/[?&](wbSeedToken|seedToken)=([0-9a-f]+)/i);
      if (mk) diag.seedToken = mk[2].slice(0, 12) + '…';
      diag.loginBtn = (function () {
        try {
          var b = document.querySelector('.login-view__button');
          if (!b) return 'absent';
          return (b.tagName || '') + '.' + String(b.className || '').slice(0, 50) + '|' + norm(b.innerText || b.textContent || '').slice(0, 20);
        } catch (e) { return 'err'; }
      })();
    } catch (e) {}

    // ===== 策略 1：已知类名（从渲染层源码确证）=====
    //   LoginView 结构：<div class="login-view"><div class="login-view__main">
    //     <button class="login-view__button">{t('login.signIn')}</button>
    //     <div class="login-view__waiting-hint"><div class="login-view__waiting-hint-actions">
    //       <button>{t('login.copyLink')}</button> ...
    var knownSel = (MODE === 'copy')
      ? ['.login-view__waiting-hint-actions button', '.login-view__waiting-hint button']
      : ['.login-view__button', '.login-view button', '.login-view__main button'];
    var docs0 = roots();
    diag.hasLoginView = false;
    for (var s0 = 0; s0 < knownSel.length; s0++) {
      for (var d0 = 0; d0 < docs0.length; d0++) {
        var cand = null;
        try { cand = docs0[d0].querySelectorAll(knownSel[s0]); } catch (e) { cand = null; }
        if (cand && cand.length) {
          var el0 = cand[cand.length > 1 && MODE === 'copy' ? cand.length - 1 : 0];
          // copy 模式下若显示「重新发起登录」，取"复制登录链接"那个
          if (MODE === 'copy' && cand.length > 1) {
            for (var z = 0; z < cand.length; z++) {
              if (norm(cand[z].innerText || cand[z].textContent || '').indexOf('复制') >= 0) { el0 = cand[z]; break; }
            }
          }
          try { el0.scrollIntoView && el0.scrollIntoView({ block: 'center' }); } catch (e) {}
          try { el0.click(); } catch (e) {}
          try {
            var rr = el0.getBoundingClientRect();
            if (rr && rr.width > 0) {
              var cx0 = rr.left + rr.width / 2, cy0 = rr.top + rr.height / 2;
              ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function (tp) {
                try {
                  var ev0 = (tp.indexOf('pointer') === 0 && window.PointerEvent)
                    ? new PointerEvent(tp, { bubbles: true, clientX: cx0, clientY: cy0 })
                    : new MouseEvent(tp, { bubbles: true, clientX: cx0, clientY: cy0 });
                  el0.dispatchEvent(ev0);
                } catch (e) {}
              });
            }
          } catch (e) {}
          diag.hits.push('class:' + knownSel[s0]);
          try {
            var rc0 = el0.getBoundingClientRect();
            diag.pt = { x: Math.round(rc0.left + rc0.width / 2), y: Math.round(rc0.top + rc0.height / 2), w: Math.round(rc0.width) };
          } catch (e) {}
          try { diag.loginViewText = String((docs0[d0].querySelector('.login-view') || {}).innerText || '').slice(0, 200); } catch (e) {}
          return JSON.stringify({ r: 'clicked-class:' + knownSel[s0] + ':' + norm(el0.innerText || el0.textContent || ''), diag: diag });
        }
      }
    }
    try { diag.hasLoginView = !!(document.querySelector('.login-view') || document.querySelector('.login-view__button')); } catch (e) {}

    var docs = roots();
    var tried = 0;
    for (var d = 0; d < docs.length; d++) {
      var els = collect(docs[d]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // 真机教训：只按文本 indexOf 会命中「标题+按钮」的祖先容器，点它没反应。
        // 只认叶子节点（无子元素），再向上 closest 找真正可点的元素。
        if (el.children && el.children.length > 0) continue;
        var t = norm(el.innerText || el.textContent || '');
        if (!t || t.length > 24) continue;         // 只要短文本（按钮级）
        if (diag.texts.length < 25 && t.length <= 24 && visible(el)) {
          if (diag.texts.indexOf(t) < 0) diag.texts.push(t);
        }
        for (var j = 0; j < TARGET.length; j++) {
          var hit = (MODE === 'copy') ? (t === TARGET[j]) : (t.indexOf(TARGET[j]) >= 0);
          if (hit) {
            tried++;
            try {
              var clickable = el.closest && el.closest(
                'button,[role=button],[class*=button],[class*=Button],[class*=oneid],[tabindex],a');
              if (clickable) el = clickable;
            } catch (e) {}
            try { el.scrollIntoView && el.scrollIntoView({ block: 'center' }); } catch (e) {}
            try { el.click(); } catch (e) {}
            // 有些组件只认真实指针事件
            try {
              var r = el.getBoundingClientRect();
              if (r && r.width > 0) {
                var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function (type) {
                  try {
                    var ev = (type.indexOf('pointer') === 0 && window.PointerEvent)
                      ? new PointerEvent(type, { bubbles: true, clientX: cx, clientY: cy })
                      : new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy });
                    el.dispatchEvent(ev);
                  } catch (e) {}
                });
              }
            } catch (e) {}
            diag.hits.push(t);
            try {
              var rc1 = el.getBoundingClientRect();
              diag.pt = { x: Math.round(rc1.left + rc1.width / 2), y: Math.round(rc1.top + rc1.height / 2), w: Math.round(rc1.width) };
              diag.tag = (el.tagName || '') + '.' + String(el.className || '').slice(0, 60);
            } catch (e) {}
            return JSON.stringify({ r: 'clicked:' + t, diag: diag });
          }
        }
      }
    }

    // 兜底：登录模式点任意 href 含 login 的链接
    if (MODE === 'login') {
      for (var d2 = 0; d2 < docs.length; d2++) {
        try {
          var ln = docs[d2].querySelectorAll('a[href*=login],a[href*=sso],a[href*=auth]');
          if (ln && ln.length) { try { ln[0].click(); } catch (e) {} return JSON.stringify({ r: 'href:' + ln[0].getAttribute('href'), diag: diag }); }
        } catch (e) {}
      }
    }
    return JSON.stringify({ r: 'none', diag: diag });
  })();`;

  // ============================================================
  // Fiber 直调兜底：从 React fiber 的 props 里直接取 onClick 调用。
  //   绕开 DOM 事件分发与 isTrusted 限制，是"点了没反应"的最强兜底。
  // ============================================================
  const FIBER_CLICK_JS = `(function () {
    function findBtn() {
      var cands = ['.login-view__button', '.login-view button', '.login-view__main button'];
      for (var i = 0; i < cands.length; i++) {
        var el = document.querySelector(cands[i]);
        if (el) return el;
      }
      var all = document.querySelectorAll('button,[role=button],[class*=button]');
      for (var k = 0; k < all.length; k++) {
        var t = (all[k].innerText || '').replace(/\\s+/g, '');
        if (t === '登录' || t.indexOf('登录') === 0) return all[k];
      }
      return null;
    }
    try {
      var el = findBtn();
      if (!el) return JSON.stringify({ r: 'fiber:no-button' });
      var key = Object.keys(el).filter(function (k) {
        return k.indexOf('__reactProps$') === 0 || k.indexOf('__reactEventHandlers$') === 0;
      })[0];
      if (!key) return JSON.stringify({ r: 'fiber:no-props', tag: el.tagName });
      var props = el[key] || {};
      var handler = props.onClick || props.onMouseDown || props.onPointerDown;
      if (typeof handler !== 'function') {
        return JSON.stringify({ r: 'fiber:no-onclick', keys: Object.keys(props).slice(0, 12) });
      }
      handler({
        preventDefault: function () {}, stopPropagation: function () {},
        nativeEvent: {}, target: el, currentTarget: el, button: 0,
        type: 'click', isTrusted: false, persist: function () {}
      });
      return JSON.stringify({ r: 'fiber:onClick-called', tag: el.tagName + '.' + String(el.className || '').slice(0, 40) });
    } catch (e) { return JSON.stringify({ r: 'fiber:err', msg: String(e && e.message) }); }
  })();`;

  const LOGIN_CLICK_JS = CLICK_JS_TEMPLATE('[]', 'login');
  const ADVANCE_CLICK_JS = CLICK_JS_TEMPLATE('[]', 'advance');
  const COPY_LINK_JS = CLICK_JS_TEMPLATE('[]', 'copy');

  const realClipboard = realElectron.clipboard;

  // 从剪贴板取登录 URL 并自己打开
  function openLoginFromClipboard(tag) {
    let txt = '';
    try { txt = realClipboard && realClipboard.readText ? realClipboard.readText() : ''; } catch (e) { log(tag, 'clipboard read failed:', e.message); }
    if (!txt) { log(tag, 'clipboard empty'); return false; }
    const m = String(txt).match(/https?:\/\/[^\s"'<>]+/g);
    if (!m) { log(tag, 'clipboard has no url'); return false; }
    const url = m.find(u => /client-login|\/login|workbuddy|codebuddy/i.test(u)) || m[0];
    // 日志里只保留 host + path，遮蔽设备码
    const safe = url.replace(/([?&]code=)[^&]+/i, '$1***');
    log(tag, 'clipboard login url:', safe.slice(0, 180));
    if (!/^https?:\/\//.test(url)) return false;
    openExternal(url);
    return true;
  }

  // 解析点击结果并记录 DOM 诊断（真机排障靠它）
  function prettyOneLine(v) {
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' | ').replace(/\s*\|\s*\|\s*/g, ' | ').slice(0, 400);
  }

  // 真实输入事件点击（部分 React 组件只认 isTrusted 事件）
  function sendRealClick(win, pt) {
    if (!win || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    try {
      const wc = win.webContents;
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      log(`   sendInputEvent click @(${pt.x},${pt.y}) w=${pt.w}`);
    } catch (e) { log('   sendInputEvent failed:', e.message); }
  }

  function handleClickResult(tag, raw, win) {
    let obj = null;
    try { obj = JSON.parse(String(raw)); } catch (e) { log(tag, 'raw ->', prettyOneLine(raw)); return; }
    const d = obj.diag || {};
    log(tag, '->', prettyOneLine(obj.r));
    log(`   DOM: url=${d.href} ready=${d.ready} els=${d.total} loginView=${d.hasLoginView} btn=${d.loginBtn}${d.seedToken ? ' seed=' + d.seedToken : ''}`);
    if (d.loginViewText) log('   login-view 文本: ' + prettyOneLine(d.loginViewText));
    if (Array.isArray(d.texts) && d.texts.length) log('   可见短文本: ' + prettyOneLine(d.texts.join(' | ')));
    const clicked = obj.r && String(obj.r).indexOf('clicked') === 0;
    if (clicked) {
      // 第一层：JS click 已发；再用真实输入事件补一枪（坐标是命中元素的中心）
      if (d.pt) sendRealClick(win || pickLiveWindow(), d.pt);
      setTimeout(() => { if (loginSucceeded()) onLoginSuccess(); }, 2500);
    }
  }

  function onLoginSuccess() {
    if (loginDone) return;
    loginDone = true;
    clickedOnce.v = true;   // 锁死后续所有点击/复制尝试，避免开第二个标签页
    loginFlowInProgress = false;
    log('login: succeeded, hiding login window');
    for (const w of allWindows) {
      if (w && !w.isDestroyed()) {
        try { w.setOpacity(1); } catch (e) {}
        try { w.hide(); } catch (e) {}
        try { w.setOpacity(0); } catch (e) {}
      }
    }
  }

  function runLoginFlow() {
    if (loginFlowInProgress) { log('runLoginFlow: already in progress, skipped'); return; }
    loginFlowInProgress = true;
    loginDone = false;
    loginBaseline = externalUrls.length;
    log('runLoginFlow: start (baseline=' + loginBaseline + ')');

    // 时间缩放：HEADLESSWB_LOGIN_FAST=1 时压缩到 1/20，仅用于自动化测试
    const SCALE = process.env.HEADLESSWB_LOGIN_FAST === '1' ? 0.05 : 1;
    const at = (ms) => Math.round(ms * SCALE);

    // 真机证据：登录卡片约 14 秒才挂载（els 768→787→912），过早点击必然落空。
    // 改为「探针轮询」：每 2 秒检查一次，一旦出现登录按钮/登录卡片就立刻点，最多等到 60 秒。
    const PROBE_JS = `(function(){
      try {
        var btn = document.querySelector('.login-view__button');
        var view = document.querySelector('.login-view') || document.querySelector('.login-view__button');
        var body = document.body ? document.body.innerText : '';
        var ready = !!(btn || view) || /服务条款|隐私政策|登录/.test(body);
        return JSON.stringify({ ready: ready, url: String(location.href).slice(0,120), els: document.querySelectorAll('*').length });
      } catch (e) { return JSON.stringify({ ready: false, err: String(e && e.message) }); }
    })();`;
    let probeCount = 0;
    const probe = () => {
      if (loginSucceeded() || clickedOnce.v) return;
      probeCount++;
      if (probeCount > 30) return;   // 60s 上限
      runJsInWindow(PROBE_JS).then(raw => {
        let pr = {};
        try { pr = JSON.parse(String(raw)); } catch (e) {}
        if (probeCount <= 3 || probeCount % 5 === 0) log(`probe #${probeCount} ready=${pr.ready} els=${pr.els}`);
        if (pr.ready) {
          clickedOnce.v = true;
          log(`login: 登录卡片已挂载（probe #${probeCount}），开始点击`);
          clickLogin(true);
        } else {
          // 点击后仍无跳转 → 用 fiber 直调 onClick 再试（最强兜底）
    const fiberFallback = () => {
      if (loginSucceeded()) return;
      log('login: DOM click 未触发跳转，尝试 fiber 直调 onClick');
      runJsInWindow(FIBER_CLICK_JS).then(r => {
        log('  fiber ->', prettyOneLine(r));
        setTimeout(() => { if (loginSucceeded()) onLoginSuccess(); }, at(2500));
      });
    };
    [6000, 16000, 26000, 40000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded() || !clickedOnce.v) return;
      log(`fiber fallback #${i + 1}`);
      fiberFallback();
    }, at(ms)));


        }
      });
    };

    const clickLogin = (first) => {
      if (loginSucceeded()) return;
      log('login: click 登录');
      runJsInWindow(LOGIN_CLICK_JS).then(r => {
        handleClickResult('  ', r, pickLiveWindow());
        let ok = false;
        try { ok = String(JSON.parse(String(r)).r).indexOf('clicked') === 0; } catch (e) {}
        if (!ok && first) {
          // 卡片刚挂载但按钮还没就绪，200ms 后再试一次
          setTimeout(() => clickLogin(false), at(800));
        }
      });
    };

    setTimeout(probe, at(2000));

    // 前置判定：已登录就完全跳过（连续两轮都在已登录状态下盲点，还误点了工作台按钮）
    const PREFLIGHT_JS = `(function(){
      try {
        var href = String(location.href);
        var snap = /[?&]accountSnapshot=/.test(href);
        var btn = !!document.querySelector('.login-view__button');
        var body = document.body ? document.body.innerText : '';
        var workbench = /新建任务|发现应用|暂无任务|点击上方按钮开始新任务/.test(body);
        return JSON.stringify({ snap: snap, hasLoginBtn: btn, workbench: workbench, href: href.slice(0, 90) });
      } catch (e) { return JSON.stringify({ err: String(e && e.message) }); }
    })();`;

    let preflightDone = false;
    const preflight = (attempt) => {
      if (loginSucceeded() || preflightDone) return;
      runJsInWindow(PREFLIGHT_JS).then(raw => {
        let r = {};
        try { r = JSON.parse(String(raw)); } catch (e) {}
        log(`preflight #${attempt}: snap=${r.snap} loginBtn=${r.hasLoginBtn} workbench=${r.workbench}`);
        // accountSnapshot 只有已登录才注入；或页面已是工作台且无登录按钮
        const signedIn = r.snap === true || (r.hasLoginBtn === false && r.workbench === true);
        if (signedIn) {
          preflightDone = true;
          loginDone = true;
          loginFlowInProgress = false;
          log('login: skipped, already signed in');
          for (const w of allWindows) {
            if (w && !w.isDestroyed()) { try { w.setOpacity(1); } catch (e) {} try { w.hide(); } catch (e) {} try { w.setOpacity(0); } catch (e) {} }
          }
          return;
        }
        if (attempt < 5) setTimeout(() => preflight(attempt + 1), at(3000));
        else setTimeout(probe, 0);
      });
    };
    setTimeout(() => preflight(1), at(2500));

    // 备用节奏：即使探针没判 ready，也在几个时间点硬点一次
    [12000, 20000, 30000, 42000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded() || clickedOnce.v) return;
      log(`login retry #${i + 1} @${ms}ms`);
      clickLogin(false);
    }, at(ms)));

    // 登录页可能先出现「同意/继续」引导，点它推进。
    // ⚠️ 必须限域：只在登录视图存在时才点，否则会在工作台里误点"开始新任务"（真机已实证会建 prewarm 会话）
    [6000, 16000, 26000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded() || preflightDone) return;
      runJsInWindow(`(function(){try{return JSON.stringify({v:!!(document.querySelector('.login-view__button')||document.querySelector('.login-view'))});}catch(e){return '{}';}})();`)
        .then(raw => {
          let r = {};
          try { r = JSON.parse(String(raw)); } catch (e) {}
          if (!r.v) { log(`advance try #${i + 1}: 非登录视图，跳过`); return; }
          log(`advance try #${i + 1} @${ms}ms`);
          runJsInWindow(ADVANCE_CLICK_JS).then(r => {
            try { const o = JSON.parse(String(r)); if (o && o.r && o.r.indexOf('clicked') === 0) log('  advance ->', o.r); } catch (e) {}
          });
        });
    }, at(ms)));

    // 复制登录链接 + 剪贴板（兜底拿 URL）
    [18000, 30000, 42000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded() || clickedOnce.v) return;
      log(`copy-link try #${i + 1} @${ms}ms`);
      runJsInWindow(COPY_LINK_JS).then(r => {
        handleClickResult('  copy', r, pickLiveWindow());
        setTimeout(() => {
          if (loginSucceeded()) return;
          openLoginFromClipboard('  clipboard:');
        }, at(1200));
      });
    }, at(ms)));

    // 最终兜底：开 client-login 页（不是 /login 首页）
    setTimeout(() => {
      if (loginSucceeded()) { log('login flow: succeeded'); }
      else {
        log('login final fallback: open client-login page');
        openExternal('https://www.workbuddy.cn/console/client-login');
      }
      setTimeout(() => { loginFlowInProgress = false; log('runLoginFlow: released'); }, at(2000));
    }, at(62000));
  }

  if (MODE.login) {
    app.whenReady().then(() => runLoginFlow()).catch(e => log('whenReady failed', e.message));
  }

  // ============================================================
  // pid 文件
  // ============================================================
  if (MODE.headless) {
    app.whenReady().then(() => {
      try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(PID_FILE, String(process.pid)); log('pidfile written', process.pid); } catch (e) {}
    }).catch(() => {});
  }

  log('patch initialized');
})();
