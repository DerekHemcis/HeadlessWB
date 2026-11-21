'use strict';
/**
 * 单场景测试：加载 headless-patch.js（挂 mock electron），按 --mode 校验补丁行为。
 * 由 run-tests.mjs 以子进程方式调用： node case.mjs --headless | --show | --login | --status
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 隔离日志目录，不污染真实 ~/.workbuddy
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
process.env.USERPROFILE = fakeHome;

const argv = process.argv.slice(2);
const mode = argv[0] || '--headless';

const results = [];
function assert(name, cond) {
  results.push({ name, ok: !!cond });
  if (!cond) { console.error(`FAIL: ${name}`); process.exitCode = 1; }
}

// ---------- mock electron ----------
const mockApp = {
  _quitCalls: 0,
  _badgeCalls: 0,
  _loginCalls: 0,
  listeners: {},
  getVersion() { return '37.10.3-mock'; },
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; },
  emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => { try { f(...a); } catch (e) {} }); },
  whenReady() { return Promise.resolve(); },
  quit() { this._quitCalls++; },
  setBadgeCount() { this._badgeCalls++; },
  setLoginItemSettings() { this._loginCalls++; },
  commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
};

class MockBrowserWindow {
  constructor(opts) {
    this.shown = 0;
    this.destroyed = false;
    this.webContents = {
      isDestroyed: () => false,
      executeJavaScript: (js, b) => Promise.resolve('mock-click'),
      once: () => {},
    };
    MockBrowserWindow.instances.push(this);
  }
  show() { this.shown++; }
  showInactive() {}
  flashFrame() {}
  once(ev, fn) { return this; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  focus() {}
  setTitle() {}
  static getAllWindows() { return MockBrowserWindow.instances; }
  static getFocusedWindow() { return null; }
}
MockBrowserWindow.instances = [];

const mockTray = class MockTray { constructor() { MockTray.count = (MockTray.count || 0) + 1; } };
const mockNotification = class MockNotification { constructor() { MockNotification.count = (MockNotification.count || 0) + 1; } };

const mockDialog = {
  showMessageBox(opts) { mockDialog._realBox++; return Promise.resolve({ response: 1, checkboxChecked: false }); },
  showMessageBoxSync(opts) { mockDialog._realBoxSync++; return 0; },
  _realBox: 0,
  _realBoxSync: 0,
};

const mockShell = { _open: 0, _opened: [], openExternal(u) { this._open++; this._opened.push(String(u)); return Promise.resolve(); } };

const mockNet = {
  _fetchCalls: [],
  fetch(url) { this._fetchCalls.push(String(url)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); },
};

const mockClipboard = {
  _text: '',
  readText() { return this._text; },
  writeText(t) { this._text = t; },
};

const mockSession = {
  _permDenials: 0,
  setPermissionRequestHandler(fn) { this._handler = fn; },
  _request(permission) {
    let granted = true;
    try { this._handler(null, permission, v => { granted = v; }); } catch (e) {}
    if (permission === 'notifications') mockSession._permDenials += granted ? 0 : 1;
    return granted;
  },
};
Object.defineProperty(mockSession, 'defaultSession', { value: mockSession, enumerable: true });

const mockElectron = {
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  Tray: mockTray,
  Notification: mockNotification,
  dialog: mockDialog,
  shell: mockShell,
  net: mockNet,
  session: mockSession,
  clipboard: mockClipboard,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};

// ---------- require 垫片：把 'electron' 换成 mock ----------
const Module = require('module');
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return mockElectron;
  return realRequire.apply(this, arguments);
};

// ---------- 加载补丁 ----------
const patchPath = path.resolve(__dirname, '..', 'patch', 'headless-patch.js');
const origMockFetch = mockNet.fetch;
const origMockBox = mockDialog.showMessageBox;
const origMockOpen = mockShell.openExternal;
require(patchPath);

// ---------- 从补丁后的 require('electron') 拿代理 ----------
const electron = require('electron');

const finish = () => {
  console.log(JSON.stringify({ mode, results }));
  process.exit(process.exitCode || 0);
};

if (mode === '--status') {
  // --status 场景在补丁加载时已 process.exit(0)；走到这里说明退出被拦
  console.log(JSON.stringify({ mode, results: [{ name: 'status-exit', ok: false }] }));
  process.exit(1);
}

// 等待 microtask（whenReady 等）
setTimeout(() => {
  try {
    if (mode === '--headless') {
      assert('Tray replaced', electron.Tray !== mockTray);
      assert('Notification replaced', electron.Notification !== mockNotification);

      // 哑对象必须容忍任何未知方法调用（官方改版加新 API 也不会抛错中断初始化）
      const tray = new electron.Tray({});
      let trayThrew = null;
      try {
        tray.setToolTip('x');
        tray.setContextMenu(null);
        tray.on('click', () => {});
        tray.displayBalloon({});
        tray.destroy();
        tray.someFutureApiWeNeverHeardOf(1, 2, 3);   // Proxy 兜底
      } catch (e) { trayThrew = e.message; }
      assert('tray dummy tolerates unknown methods', trayThrew === null);
      assert('tray.isDestroyed() true', tray.isDestroyed() === true);
      assert('tray.getBounds() object', typeof tray.getBounds() === 'object');

      const nt = new electron.Notification({});
      let ntThrew = null;
      try {
        nt.show(); nt.close(); nt.on('click', () => {});
        nt.anotherUnknownApi();                       // Proxy 兜底
      } catch (e) { ntThrew = e.message; }
      assert('notification dummy tolerates unknown methods', ntThrew === null);
      assert('Notification.isSupported() false', electron.Notification.isSupported() === false);
      assert('BrowserWindow wrapped', electron.BrowserWindow !== MockBrowserWindow);
      assert('app unchanged (real app proxied)', electron.app === mockApp);

      const win = new electron.BrowserWindow({});
      win.show();
      assert('show suppressed in headless', win.shown === 0);

      mockApp.emit('window-all-closed');
      electron.app.quit();
      assert('app.quit suppressed in headless', mockApp._quitCalls === 0);

      electron.app.setBadgeCount(3);
      assert('setBadgeCount suppressed', mockApp._badgeCalls === 0);

      electron.app.setLoginItemSettings({ openAtLogin: true });
      assert('setLoginItemSettings suppressed', mockApp._loginCalls === 0);

      electron.dialog.showMessageBox({});
      assert('dialog.showMessageBox suppressed (async)', mockDialog._realBox === 0);

      // 直接改真实对象：动态 import('electron') 路径也拿不到漏网的真实方法
      assert('real net.fetch patched (covers dynamic import)', mockNet.fetch !== origMockFetch);
      assert('real dialog.showMessageBox patched', mockDialog.showMessageBox !== origMockBox);
      assert('real shell.openExternal patched', mockShell.openExternal !== origMockOpen);

      // child_process 过滤：办公文件关联的 reg 写入必须被拦，协议注册必须放行
      const cp = require('child_process');
      const blocked = cp.spawnSync('reg.exe', ['ADD', 'HKCU\\Software\\Classes\\Applications\\HeadlessWB.exe\\shell\\open\\command', '/ve', '/d', 'x', '/f']);
      assert('office file-assoc reg write blocked', blocked && blocked.status === 0 && !blocked.error);
      const allowed = cp.spawnSync('reg.exe', ['ADD', 'HKCU\\Software\\Classes\\workbuddy', '/ve', '/d', 'x', '/f']);
      // 放行的调用会真的执行 -> macOS 上 reg.exe 不存在 => ENOENT（证明未被拦）
      assert('protocol registration reg not blocked', allowed && allowed.error && allowed.error.code === 'ENOENT');

      // 等待 whenReady 微任务：权限拒绝回调 + 登录/pidfile 回调
      Promise.resolve().then(() => {
        mockSession._request('notifications');
        assert('notification permission denied', mockSession._permDenials === 1);

        // second-instance 转发 --show：之后新建窗口应允许显示
        mockApp.emit('second-instance', {}, ['--show']);
        const win2 = new electron.BrowserWindow({});
        win2.show();
        assert('second-instance --show unlocks window', win2.shown === 1);

        return electron.net.fetch('https://copilot.tencent.com/v2/update?platform=workbuddy-win32-x64-user')
          .then(res => {
            assert('update fetch blocked (204)', res && res.status === 204);
            return electron.net.fetch('https://www.workbuddy.cn/some/other');
          })
          .then(res => {
                  assert('normal fetch passes through', res && res.status === 200);
            // 健康快照/退出可观测性：不应因注册监听而抛错
            assert('quit observability registered', true);
            finish();
          });
      });
      return;
    }

    if (mode === '--show') {
      const win = new electron.BrowserWindow({});
      win.show();
      assert('show allowed in --show mode', win.shown === 1);
      finish();
      return;
    }

    if (mode === '--login') {
      // 登录流程：模拟应用把「登录链接」写进剪贴板，补丁应读出来并自己 openExternal
      assert('login mode loads', true);
      const LOGIN_URL = 'https://www.workbuddy.cn/console/client-login?code=ABCTEST123&target=/';
      mockClipboard._text = LOGIN_URL;
      // HEADLESSWB_LOGIN_FAST=1 时流程被压缩，等待足够轮次
      setTimeout(() => {
        const opened = mockShell._opened || [];
        const hit = opened.some(u => u.indexOf('client-login') >= 0);
        assert('clipboard login url opened by patch', hit);
        // 设备码必须被遮蔽后才写日志
        finish();
      }, 2600);
      return;
    }

    finish();
  } catch (e) {
    console.error('case crashed:', e);
    process.exit(1);
  }
}, 150);
