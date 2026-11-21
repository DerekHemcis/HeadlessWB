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
  // 可重入：登出/过期后再次 --login 必须能重新跑（早期版本用一次性 latch，是个 bug）
  let loginFlowInProgress = false;
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
    } catch (e) {}

    var docs = roots();
    var tried = 0;
    for (var d = 0; d < docs.length; d++) {
      var els = collect(docs[d]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var t = norm(el.innerText || el.textContent || '');
        if (!t || t.length > 24) continue;         // 只要短文本（按钮级）
        if (diag.texts.length < 25 && t.length <= 24 && visible(el)) {
          if (diag.texts.indexOf(t) < 0) diag.texts.push(t);
        }
        for (var j = 0; j < TARGET.length; j++) {
          var hit = (MODE === 'copy') ? (t === TARGET[j]) : (t.indexOf(TARGET[j]) >= 0);
          if (hit) {
            tried++;
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
  function handleClickResult(tag, raw) {
    let obj = null;
    try { obj = JSON.parse(String(raw)); } catch (e) { log(tag, 'raw ->', String(raw).slice(0, 200)); return; }
    const d = obj.diag || {};
    log(tag, '->', obj.r);
    log(`   DOM: url=${d.href} ready=${d.ready} title=${d.title} els=${d.total}`);
    if (Array.isArray(d.texts) && d.texts.length) log('   可见短文本: ' + d.texts.join(' | '));
    if (obj.r && String(obj.r).indexOf('clicked') === 0) {
      // 点到了：稍等再确认浏览器是否被打开
      setTimeout(() => { if (loginSucceeded()) onLoginSuccess(); }, 2500);
    }
  }

  function onLoginSuccess() {
    if (loginDone) return;
    loginDone = true;
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

    // 更密的节奏：SPA 首屏可能要 10~30 秒才渲染出登录按钮
    const loginAttempts = [3000, 8000, 14000, 20000, 28000, 36000, 45000];
    loginAttempts.forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded()) return;
      log(`login try #${i + 1} @${ms}ms: click 登录`);
      runJsInWindow(LOGIN_CLICK_JS).then(r => handleClickResult('  ', r));
    }, at(ms)));

    // 登录页可能先出现「同意/继续」引导，点它推进
    [6000, 16000, 26000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded()) return;
      log(`advance try #${i + 1} @${ms}ms`);
      runJsInWindow(ADVANCE_CLICK_JS).then(r => {
        try { const o = JSON.parse(String(r)); if (o && o.r && o.r.indexOf('clicked') === 0) log('  advance ->', o.r); } catch (e) {}
      });
    }, at(ms)));

    // 复制登录链接 + 剪贴板（兜底拿 URL）
    [18000, 30000, 42000].forEach((ms, i) => setTimeout(() => {
      if (loginSucceeded()) return;
      log(`copy-link try #${i + 1} @${ms}ms`);
      runJsInWindow(COPY_LINK_JS).then(r => {
        handleClickResult('  copy', r);
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
    }, at(50000));
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
