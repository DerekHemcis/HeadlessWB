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

  // --status 走真实 electron 即可
  if (MODE.status) {
    let running = false;
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); running = true; } catch (e) { running = false; }
      }
    } catch (e) { running = false; }
    console.log(JSON.stringify({
      app: 'HeadlessWB',
      version: realElectron.app.getVersion(),
      pid: process.pid,
      runningInstance: running ? parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) : null,
      mode: 'status',
    }));
    process.exit(0);
  }

  ensureLog();
  log(`mode=${MODE.headless ? 'headless' : 'show'} login=${MODE.login} show=${MODE.show}`);

  const app = realElectron.app;
  let showRequested = MODE.show;
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
    return showRequested;
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
    const win = new RealBrowserWindow(options);
    allWindows.add(win);
    win.once('closed', () => allWindows.delete(win));
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
        log('openExternal:', String(url).slice(0, 160));
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
            `externalOpen=${externalUrls.length} updateBlocked=${updateBlockedCount} loginOpened=${loginSucceeded()}`);
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
    const wrap = (name, argsIndex) => {
      const orig = cp[name];
      if (typeof orig !== 'function') return;
      cp[name] = function (...argv) {
        const file = argv[0];
        const args = argv[argsIndex];
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
      if (live.length) { try { realShow.apply(live[0]); } catch (e) {} }
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
  let loginFlowStarted = false;
  function pickLiveWindow() {
    for (const w of allWindows) {
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) return w;
    }
    return null;
  }
  function loginSucceeded() { return externalUrls.some(u => /client-login|\/login/.test(u)); }

  function runJsInWindow(js) {
    const win = pickLiveWindow();
    if (!win) { log('runJs: no live window'); return Promise.resolve('no-window'); }
    try {
      return win.webContents.executeJavaScript(js, true).catch(e => 'err:' + e.message);
    } catch (e) {
      return Promise.resolve('throw:' + e.message);
    }
  }

  // 点击文案匹配：优先登录，其次引导/协议推进按钮
  const LOGIN_CLICK_JS = `(function () {
    try {
      var loginTexts = ['登录', '登 录', '扫码登录', '立即登录', '登录/注册', 'Sign in', 'Log in', 'Login'];
      var advanceTexts = ['同意并继续', '同意', '继续', '下一步', '开始使用', '开始', '知道了', '跳过', 'Get started', 'Agree', 'Continue', 'Next', 'Skip', 'Got it'];
      var els = Array.from(document.querySelectorAll('button,a,[role=button]'));
      var i, j, t;
      for (i = 0; i < els.length; i++) {
        t = ((els[i].innerText || els[i].textContent || '')).replace(/\\s+/g, '');
        if (!t) continue;
        for (j = 0; j < loginTexts.length; j++) {
          if (t.indexOf(loginTexts[j]) >= 0) { els[i].click(); return 'login-clicked:' + t; }
        }
      }
      for (i = 0; i < els.length; i++) {
        t = ((els[i].innerText || els[i].textContent || '')).replace(/\\s+/g, '');
        if (!t) continue;
        for (j = 0; j < advanceTexts.length; j++) {
          if (t === advanceTexts[j] || t.indexOf(advanceTexts[j]) === 0) { els[i].click(); return 'advance-clicked:' + t; }
        }
      }
      var ln = Array.from(document.querySelectorAll('a[href*="/login"]'));
      if (ln.length) { ln[0].click(); return 'href:' + ln[0].href; }
      return 'none';
    } catch (e) { return 'err:' + e.message; }
  })();`;

  // 点「复制登录链接」/「重新发起登录」
  const COPY_LINK_JS = `(function () {
    try {
      var texts = ['复制登录链接', '复制链接', '重新发起登录', '重新登录'];
      var els = Array.from(document.querySelectorAll('button,a,[role=button],span'));
      for (var i = 0; i < els.length; i++) {
        var t = ((els[i].innerText || els[i].textContent || '')).replace(/\\s+/g, '');
        if (!t) continue;
        for (var j = 0; j < texts.length; j++) {
          if (t === texts[j]) { els[i].click(); return 'copy-clicked:' + t; }
        }
      }
      return 'none';
    } catch (e) { return 'err:' + e.message; }
  })();`;

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

  function runLoginFlow() {
    if (loginFlowStarted) return;
    loginFlowStarted = true;
    log('runLoginFlow: start');

    // 时间缩放：HEADLESSWB_LOGIN_FAST=1 时压缩到 1/20，仅用于自动化测试
    const SCALE = process.env.HEADLESSWB_LOGIN_FAST === '1' ? 0.05 : 1;
    const at = (ms) => Math.round(ms * SCALE);

    // 第 1 步：点登录
    setTimeout(() => {
      if (loginSucceeded()) return;
      log('login step1: click 登录');
      runJsInWindow(LOGIN_CLICK_JS).then(r => log('  ->', String(r)));
    }, at(3000));

    // 第 2 步：8s / 18s 再点登录（页面可能还在加载）
    [8000, 18000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded()) return;
      log(`login step2.${i + 1}: retry click 登录`);
      runJsInWindow(LOGIN_CLICK_JS).then(r => log('  ->', String(r)));
    }, at(ms)));

    // 第 3 步：12s 起，若浏览器还没开，走「复制登录链接」+ 剪贴板
    [12000, 24000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded()) return;
      log(`login step3.${i + 1}: try 复制登录链接 + clipboard`);
      runJsInWindow(COPY_LINK_JS).then(r => {
        log('  copy click ->', String(r));
        setTimeout(() => {
          if (loginSucceeded()) return;
          openLoginFromClipboard('  clipboard:');
        }, at(1200));
      });
    }, at(ms)));

    // 第 4 步：36s 仍未成功 → 直接开官网登录页
    setTimeout(() => {
      if (loginSucceeded()) { log('login flow: succeeded'); return; }
      log('login step4: fallback open website login');
      openExternal('https://www.workbuddy.cn/login');
    }, at(36000));
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
