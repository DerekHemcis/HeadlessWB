#!/usr/bin/env node
/**
 * HeadlessWB build pipeline
 * -------------------------
 * 从官方 WorkBuddy Windows 安装包产出无头隐蔽版 HeadlessWB/ 目录（绿色版）。
 *
 * 用法：
 *   node build.mjs [--installer <path>] [--7z <path>] [--skip-download]
 *
 * 依赖（自动安装到本目录 node_modules/）：
 *   @electron/asar  用于解包/重打包 app.asar
 *   7z-bin          提供跨平台 7z 二进制（解 NSIS 安装包）
 *
 * 产物：dist/HeadlessWB/
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes(name);

const INSTALLER_ARG = opt('--installer', null);
const SEVENZ_ARG = opt('--7z', null);
const SKIP_DOWNLOAD = flag('--skip-download');
const FORCE_DOWNLOAD = flag('--force-download');

const PLATFORM_ID = 'workbuddy-win32-x64-user';
const UPDATE_API = `https://copilot.tencent.com/v2/update?platform=${PLATFORM_ID}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'headlesswb-'));
const CACHE = path.join(ROOT, '.cache');
const DIST = path.join(ROOT, 'dist', 'HeadlessWB');

function log(msg) { console.log(`[build] ${msg}`); }
function fail(msg) { console.error(`[build] ERROR: ${msg}`); process.exit(1); }

// 深度优先找一个文件（不分大小写），找不到返回 null
function findFirst(dir, name) {
  const target = name.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isFile() && e.name.toLowerCase() === target) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

function run(cmd, argsList, opts = {}) {
  const r = spawnSync(cmd, argsList, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    fail(`${cmd} ${argsList.join(' ')} failed (exit ${r.status})\n${r.stderr?.slice(-2000)}\n${r.stdout?.slice(-500)}`);
  }
  return r;
}

// ------------------------------------------------------------
// 1) 依赖
// ------------------------------------------------------------
async function ensureDeps() {
  const asarJs = path.join(ROOT, 'node_modules', '@electron', 'asar', 'lib', 'asar.js');
  const sevenzBin = path.join(ROOT, 'node_modules', '7z-bin');
  if (fs.existsSync(asarJs) && fs.existsSync(sevenzBin)) return;
  log('installing build dependencies (@electron/asar, 7z-bin)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '--no-save', '--no-audit', '--no-fund', '@electron/asar', '7z-bin'], { cwd: ROOT });
}

function resolve7z() {
  if (SEVENZ_ARG && fs.existsSync(SEVENZ_ARG)) return SEVENZ_ARG;
  // 系统 PATH 里的 7z
  for (const name of ['7z', '7zz', '7za']) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'pipe', encoding: 'utf8' });
    const p = r.stdout?.split(/\r?\n/)[0]?.trim();
    if (p && fs.existsSync(p)) return p;
  }
  // 7z-bin 包内二进制
  const base = path.join(ROOT, 'node_modules', '7z-bin', 'bin');
  const candidates = {
    darwin: [path.join(base, 'mac', process.arch === 'arm64' ? 'arm64' : 'x64', '7zz')],
    win32: [path.join(base, 'win', process.arch === 'x64' ? 'x64' : 'ia32', '7z.exe')],
    linux: [path.join(base, 'linux', process.arch, '7zz')],
  };
  for (const c of candidates[process.platform] || []) {
    if (fs.existsSync(c)) return c;
  }
  fail('未找到 7z 二进制。请用 --7z <path> 指定，或确认 node_modules/7z-bin 已安装。');
}

// ------------------------------------------------------------
// Electron fuse 处理
//   WorkBuddy 的 exe 开启了 EnableEmbeddedAsarIntegrityValidation，
//   Windows 上同样会校验 app.asar header 的哈希。我们重打包 asar 后哈希必然变化，
//   启动时 Chromium 会在 Node 之前 FATAL：Integrity check failed for asar archive。
//   解决：把该 fuse 位改成 '0'（disabled）。fuse 区格式固定：
//     sentinel(32B) | schemaVer(1) | count(1) | fuse[0..count-1]
//   每字节 '0'=禁用 '1'=启用 'r'=移除。Electron v1 schema 顺序里索引 4 就是它。
// ------------------------------------------------------------
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_IDX_ASAR_INTEGRITY = 4;
const FUSE_NAME_ASAR_INTEGRITY = 'EnableEmbeddedAsarIntegrityValidation';

function readFuseOffset(exePath) {
  const buf = fs.readFileSync(exePath);
  const i = buf.indexOf(FUSE_SENTINEL);
  if (i < 0) throw new Error('未找到 Electron fuse 区（sentinel 缺失）');
  const schemaVer = buf[i + FUSE_SENTINEL.length];
  const count = buf[i + FUSE_SENTINEL.length + 1];
  if (schemaVer !== 1) throw new Error(`不支持的 fuse schema 版本: ${schemaVer}`);
  if (count <= FUSE_IDX_ASAR_INTEGRITY) throw new Error(`fuse 数量不足: ${count}`);
  const off = i + FUSE_SENTINEL.length + 2 + FUSE_IDX_ASAR_INTEGRITY;
  return { offset: off, count, current: buf[off], buf };
}

function disableAsarIntegrityFuse(exePath) {
  const { offset, current, count } = readFuseOffset(exePath);
  log(`fuse 区: count=${count}, ${FUSE_NAME_ASAR_INTEGRITY} 当前='${String.fromCharCode(current)}'`);
  if (current === 0x30) { log('fuse 已是 disabled，跳过'); return; }
  if (current !== 0x31 && current !== 0x72) {
    throw new Error(`fuse 值异常（0x${current.toString(16)}），拒绝盲改`);
  }
  const buf = fs.readFileSync(exePath);
  buf[offset] = 0x30;
  fs.writeFileSync(exePath, buf);
  // 回读校验
  const after = readFuseOffset(exePath);
  if (after.current !== 0x30) throw new Error('fuse 写回校验失败');
  log(`${FUSE_NAME_ASAR_INTEGRITY} 已改为 disabled ✅`);
}

// ------------------------------------------------------------
// PowerShell 脚本必须带 UTF-8 BOM
//   Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页解码 .ps1，
//   zh-CN（代码页 936/GBK）机器上会把中文注释/字符串解成乱码并直接语法报错。
// ------------------------------------------------------------
function ensureUtf8Bom(filePath) {
  const raw = fs.readFileSync(filePath);
  const hasBom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  if (hasBom) return false;
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), raw]));
  return true;
}

// ------------------------------------------------------------
// 2) 安装包
// ------------------------------------------------------------
async function resolveInstaller() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (INSTALLER_ARG) {
    if (!fs.existsSync(INSTALLER_ARG)) fail(`--installer 路径不存在: ${INSTALLER_ARG}`);
    return path.resolve(INSTALLER_ARG);
  }
  // 先查缓存（--force-download 时忽略缓存，拉最新版）
  const cached = !FORCE_DOWNLOAD
    ? fs.readdirSync(CACHE).filter(f => f.endsWith('.exe'))
    : [];
  if (cached.length) return path.join(CACHE, cached[0]);

  if (SKIP_DOWNLOAD) fail('缓存无安装包且指定了 --skip-download');
  log(`下载官方安装包: ${UPDATE_API}`);
  const res = await fetch(UPDATE_API);
  if (!res.ok) fail(`更新接口 HTTP ${res.status}`);
  const info = await res.json();
  if (!info || !info.url) fail('更新接口未返回下载地址');
  log(`版本 ${info.version} sha256=${info.sha256hash}`);
  const dest = path.join(CACHE, `WorkBuddy-Setup-${info.version}.exe`);
  const buf = Buffer.from(await res.arrayBuffer ? await res.arrayBuffer() : await res.buffer?.());
  // 上面拿的是 update 元数据，安装包本体要单独下载
  log(`下载安装包: ${info.url}`);
  const dl = await fetch(info.url);
  if (!dl.ok) fail(`下载失败 HTTP ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (info.sha256hash) {
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual.toLowerCase() !== String(info.sha256hash).toLowerCase()) {
      fail(`sha256 校验失败: 期望 ${info.sha256hash} 实际 ${actual}`);
    }
    log('sha256 校验通过');
  }
  fs.writeFileSync(dest, bytes);
  log(`安装包已保存: ${dest} (${(bytes.length / 1048576).toFixed(1)} MB)`);
  return dest;
}

// ------------------------------------------------------------
// 3) 解包
// ------------------------------------------------------------
function extractInstaller(installer) {
  const sevenz = resolve7z();
  const out = path.join(TMP, 'installer');
  fs.mkdirSync(out, { recursive: true });
  log('解压 NSIS 安装包…');
  run(sevenz, ['x', '-y', `-o${out}`, installer]);
  const pluginDir = path.join(out, '$PLUGINSDIR');
  const payload = path.join(pluginDir, 'app-64.7z');
  if (!fs.existsSync(payload)) fail(`未找到 $PLUGINSDIR/app-64.7z（解压产物：${fs.readdirSync(out).join(', ')}）`);
  const appDir = path.join(TMP, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  log('解压 app-64.7z…');
  run(sevenz, ['x', '-y', `-o${appDir}`, payload]);
  const exe = path.join(appDir, 'WorkBuddy.exe');
  if (!fs.existsSync(exe)) fail(`未找到 WorkBuddy.exe`);
  return appDir;
}

// ------------------------------------------------------------
// 4) asar 打补丁（单文件注入 + 重打包，保留 unpacked 语义）
// ------------------------------------------------------------
async function patchAsar(appDir) {
  const resourcesDir = path.join(appDir, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  if (!fs.existsSync(asarPath)) fail('未找到 resources/app.asar');

  const asarLib = path.join(ROOT, 'node_modules', '@electron', 'asar');
  const { listPackage, extractFile } = await import(pathToFileURL(path.join(asarLib, 'lib', 'asar.js')).href);
  const { readFilesystemSync } = await import(pathToFileURL(path.join(asarLib, 'lib', 'disk.js')).href);
  const { Filesystem } = await import(pathToFileURL(path.join(asarLib, 'lib', 'filesystem.js')).href);
  const { writeFilesystem } = await import(pathToFileURL(path.join(asarLib, 'lib', 'disk.js')).href);
  const { determineFileType } = await import(pathToFileURL(path.join(asarLib, 'lib', 'crawlfs.js')).href);

  log('读取 asar 文件表…');
  const fsys = readFilesystemSync(asarPath);
  const entries = [];
  const walk = (base, meta) => {
    if (!meta || !meta.files) return;
    for (const [name, child] of Object.entries(meta.files)) {
      const rel = path.posix.join(base, name);
      if (child.files) { walk(rel, child); continue; }
      entries.push({ rel, link: child.link || null, unpacked: !!child.unpacked });
    }
  };
  walk('/', fsys.header);

  log(`共 ${entries.length} 个文件，解出到暂存目录…`);
  const staging = path.join(TMP, 'asar-src');
  fs.mkdirSync(staging, { recursive: true });

  const sidecarPaths = new Set();
  let skipped = 0;
  for (const e of entries) {
    const relNoLead = e.rel.replace(/^\//, '');
    const abs = path.join(staging, relNoLead);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (e.link) {
      // 符号链接：原样记录，暂存为文本标记，重打包时重建
      try { fs.writeFileSync(abs, e.link, 'utf8'); } catch (err) { skipped++; }
      sidecarPaths.add(e.rel);
      continue;
    }
    if (e.unpacked) {
      const srcSide = path.join(unpackedDir, relNoLead);
      if (fs.existsSync(srcSide)) {
        fs.copyFileSync(srcSide, abs);
        sidecarPaths.add(e.rel);
      } else {
        skipped++; // 跨平台预编译产物未随包分发，跳过（Windows 运行永不需要）
      }
      continue;
    }
    const buf = extractFile(asarPath, relNoLead);
    fs.writeFileSync(abs, buf);
  }
  if (skipped) log(`跳过 ${skipped} 个未随包分发的 unpacked 文件（跨平台原生模块，Windows 不需要）`);

  // 注入补丁 require 行
  const entry = path.join(staging, 'main', 'index.js');
  if (!fs.existsSync(entry)) fail('未找到 asar 内 main/index.js');
  const requireLine = `require(require('path').join(process.resourcesPath,'headless-patch.js'));\n`;
  let entrySrc = fs.readFileSync(entry, 'utf8');
  if (!entrySrc.includes('headless-patch.js')) {
    entrySrc = requireLine + entrySrc;
    fs.writeFileSync(entry, entrySrc);
    log('已在 main/index.js 首行注入 headless-patch.js');
  }

  // 重打包（低层 API，精确保留每个文件的 unpacked 标记）
  log('重打包 app.asar（保留 unpacked 语义）…');
  const filesystem = new Filesystem(staging);
  const files = [];
  const links = [];
  let dirCount = 0;

  // 目录要按从浅到深插入
  const relFiles = entries.map(e => e.rel.replace(/^\//, '')).filter(rel => fs.existsSync(path.join(staging, rel)));
  const dirSet = new Set();
  for (const rel of relFiles) {
    let d = path.dirname(rel);
    while (d !== '.' && d !== '') { dirSet.add(d); d = path.dirname(d); }
  }
  for (const dirRel of [...dirSet].sort((a, b) => a.length - b.length)) {
    filesystem.insertDirectory(path.join(staging, dirRel), false);
    dirCount++;
  }

  for (const e of entries) {
    const relNoLead = e.rel.replace(/^\//, '');
    const abs = path.join(staging, relNoLead);
    if (!fs.existsSync(abs)) continue; // 跳过的 sidecar 文件不写入新包
    const wasUnpacked = sidecarPaths.has(e.rel);
    if (e.link) {
      const target = fs.readFileSync(abs, 'utf8');
      filesystem.insertLink(abs, wasUnpacked, path.dirname(abs), target, staging);
      links.push({ filename: abs, unpack: wasUnpacked, link: target, mode: 0o777 });
    } else {
      const ft = await determineFileType(abs);
      if (ft.type !== 'file') { fail(`非预期文件类型 ${abs}: ${ft.type}`); }
      await filesystem.insertFile(abs, () => fs.createReadStream(abs), wasUnpacked, ft);
      files.push({ filename: abs, unpack: wasUnpacked });
    }
  }

  const newAsar = path.join(TMP, 'app.asar.new');
  const metadata = Object.create(null);
  for (const f of files) {
    metadata[f.filename] = { type: 'file', stat: { size: fs.statSync(f.filename).size, mode: 0o666, type: 'file' } };
  }
  await writeFilesystem(newAsar, filesystem, { files, links }, metadata);

  // 替换
  fs.renameSync(asarPath, path.join(TMP, 'app.asar.bak'));
  fs.renameSync(newAsar, asarPath);
  log(`app.asar 重打包完成 (${(fs.statSync(asarPath).size / 1048576).toFixed(1)} MB)`);
  return { entry };
}

// ------------------------------------------------------------
// 5) 组装产物
// ------------------------------------------------------------
function assemble(appDir) {
  const resourcesDir = path.join(appDir, 'resources');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 复制整个应用目录
  log('复制应用目录…');
  fs.cpSync(appDir, DIST, { recursive: true, dereference: false, force: true, errorOnExist: false, filter: () => true });

  // 注入运行时补丁
  const patchSrc = path.join(ROOT, 'patch', 'headless-patch.js');
  if (!fs.existsSync(patchSrc)) fail('缺少 patch/headless-patch.js');
  fs.copyFileSync(patchSrc, path.join(DIST, 'resources', 'headless-patch.js'));
  log('已复制 headless-patch.js 到 resources/');

  // exe 改名（进程名随之变化）
  const exe = path.join(DIST, 'WorkBuddy.exe');
  const newExe = path.join(DIST, 'HeadlessWB.exe');
  fs.copyFileSync(exe, newExe);
  fs.rmSync(exe);
  log('已重命名 HeadlessWB.exe');

  // 关掉 asar 完整性校验（否则重打包后的 asar 在 Windows 上启动即 FATAL）
  disableAsarIntegrityFuse(newExe);

  // 干净新机自包含：把 VC++ 运行库 DLL 复制到应用根目录。
  // Electron 原生模块（node-pty/koffi/wwapi/qimei 等）依赖 vcruntime140*/msvcp140，
  // 全新 Windows 没装 VC++ 运行库会加载失败。应用内已自带这些 DLL（在 sandbox 子目录），
  // 复制到 exe 同级后，Windows 加载器会优先从应用根目录解析依赖。
  const vcDllNames = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  for (const dll of vcDllNames) {
    const found = findFirst(path.join(DIST, 'resources', 'app.asar.unpacked'), dll);
    if (found) {
      fs.copyFileSync(found, path.join(DIST, dll));
      log(`已复制 ${dll} 到应用根目录`);
    } else {
      log(`警告：未找到 ${dll}（应用内不携带，干净新机可能缺 VC++ 运行库）`);
    }
  }

  // 脚本
  for (const f of ['install.ps1', 'uninstall.ps1', 'tools/wb-ctl.ps1', 'tools/verify.ps1', 'tools/deploy.ps1', 'README.txt']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
      const dst = path.join(DIST, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (/\.[pP][sS]1$/.test(f) && ensureUtf8Bom(dst)) log(`已为 ${f} 补 UTF-8 BOM`);
    }
  }
  // 版本标记
  let appVersion = 'unknown';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'resources', 'install-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    appVersion = manifest.appVersion || manifest.version || 'unknown';
  } catch (e) {}
  fs.writeFileSync(path.join(DIST, 'HEADLESSWB_VERSION.txt'), `appVersion=${appVersion}\nbuiltAt=${new Date().toISOString()}\n`);
  log(`产物已生成: ${DIST}`);
}

// ------------------------------------------------------------
async function main() {
  await ensureDeps();
  const installer = await resolveInstaller();
  const appDir = extractInstaller(installer);
  await patchAsar(appDir);
  assemble(appDir);
  log('构建完成 ✅');
  log(`部署说明：把 dist/HeadlessWB 整个目录拷到 Windows 机器，运行 install.ps1 即可。`);
}

main().catch(e => { console.error(e); process.exit(1); });
