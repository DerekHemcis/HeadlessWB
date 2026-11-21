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

  // ============================================================
  // 哑对象
  // ============================================================
  class DummyTray {
    constructor() { this.__dummy = true; }
    destroy() {} setToolTip() {} setContextMenu() {} setTitle() {} setImage() {}
    setPressedImage() {} setIgnoreDoubleClickEvents() {} popUpContextMenu() {}
    closeContextMenu() {} displayBalloon() {} removeBalloon() {} focus() {}
    on() { return this; } once() { return this; } off() { return this; } removeListener() { return this; }
  }
  class DummyNotification {
    constructor() { this.__dummy = true; }
    static isSupported() { return false; }
    show() {} close() {} on() { return this; } once() { return this; } off() { return this; }
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
      if (/v2\/update\?/.test(s)) { log('blocked update check:', s.slice(0, 120)); return Promise.resolve(make204Response()); }
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
  }

  // ============================================================
  // 代理：后续业务代码 require('electron') 拿到的是它
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
    return origRequire.apply(this, arguments);
  };
  log('electron require shim installed');

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
  // ============================================================
  let loginFlowStarted = false;
  function pickLiveWindow() {
    for (const w of allWindows) {
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) return w;
    }
    return null;
  }
  function loginSucceeded() { return externalUrls.some(u => /client-login|\/login/.test(u)); }

  const LOGIN_CLICK_JS = `(function () {
    try {
      var loginTexts = ['登录', '登 录', '扫码登录', '立即登录', '登录/注册', 'Sign in', 'Log in', 'Login'];
      var advanceTexts = ['同意', '同意并继续', '继续', '下一步', '开始使用', '开始', '知道了', '跳过', 'Get started', 'Agree', 'Continue', 'Next', 'Skip', 'Got it'];
      var els = Array.from(document.querySelectorAll('button,a,[role=button]'));
      var i, j, t;
      // 优先：登录按钮
      for (i = 0; i < els.length; i++) {
        t = ((els[i].innerText || els[i].textContent || '')).replace(/\\s+/g, '');
        if (!t) continue;
        for (j = 0; j < loginTexts.length; j++) {
          if (t.indexOf(loginTexts[j]) >= 0) { els[i].click(); return 'login-clicked:' + t; }
        }
      }
      // 其次：新手引导/协议页的推进按钮（同意/继续/开始/跳过等）
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

  function tryClickLogin() {
    const win = pickLiveWindow();
    if (!win) { log('tryClickLogin: no live window'); return; }
    try {
      win.webContents.executeJavaScript(LOGIN_CLICK_JS, true).then(r => {
        log('login click result:', String(r));
        if (loginSucceeded()) {
          log('browser login opened; destroying hidden window');
          try { win.destroy(); } catch (e) {}
        }
      }).catch(e => log('login click failed', e.message));
    } catch (e) { log('login click threw', e.message); }
  }

  function runLoginFlow() {
    if (loginFlowStarted) return;
    loginFlowStarted = true;
    log('runLoginFlow: start');
    [3000, 8000, 15000, 22000].forEach((ms, idx) => {
      setTimeout(() => {
        if (loginSucceeded()) return;
        log(`login attempt #${idx + 1} at ${ms}ms`);
        tryClickLogin();
      }, ms);
    });
    setTimeout(() => {
      if (!loginSucceeded()) {
        log('login flow fallback: open website login');
        openExternal('https://www.workbuddy.cn/login');
      }
    }, 30000);
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
