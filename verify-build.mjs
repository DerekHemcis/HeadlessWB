#!/usr/bin/env node
/**
 * 本地一键验证（构建后跑一遍）：
 *   1) 补丁语法检查
 *   2) mock-electron 冒烟测试
 *   3) 产物 asar 有效性 + 注入点检查
 *
 * 用法: node verify-build.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = false;

function step(name) { console.log(`\n=== ${name} ===`); }
function run(cmd, args, cwd = __dirname) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000 });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr ? r.stderr.slice(-1500) : '');
  if (r.status !== 0) failed = true;
  return r;
}

step('1/6 补丁语法检查');
run(process.execPath, ['--check', path.join(__dirname, 'patch', 'headless-patch.js')]);

step('2/6 冒烟测试（mock electron）');
run(process.execPath, [path.join(__dirname, 'test', 'run-tests.mjs')]);

step('3/6 产物 asar 校验');
const asarPath = path.join(__dirname, 'dist', 'HeadlessWB', 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  console.log('未找到 dist/HeadlessWB/resources/app.asar（先跑 node build.mjs）');
  failed = true;
} else {
  const { listPackage, extractFile } = await import(pathToFileURL(path.join(__dirname, 'node_modules', '@electron', 'asar', 'lib', 'asar.js')).href);
  const n = listPackage(asarPath).length;
  const head = extractFile(asarPath, 'main/index.js').toString('utf8').slice(0, 110);
  const ok = n > 10000 && head.includes('headless-patch.js');
  console.log(`asar 条目数: ${n}`);
  console.log(`注入首行: ${JSON.stringify(head)}`);
  console.log(ok ? 'asar 校验通过 ✅' : 'asar 校验失败 ❌');
  if (!ok) failed = true;
}

// ---- 4) 关键 Windows 原生模块必须在解压后的 sidecar 里 ----
step('4/6 Windows 原生模块齐全性');
const sidecar = path.join(__dirname, 'dist', 'HeadlessWB', 'resources', 'app.asar.unpacked');
const critical = [
  'cli/node_modules/koffi/build/koffi/win32_x64/koffi.node',
  'node_modules/koffi/build/koffi/win32_x64/koffi.node',
  'node_modules/node-pty/prebuilds/win32-x64/pty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'resources/im-backend-cmd/im-napi.node',
  'native/turing-sdk/build/Release/turing_sdk.node',
];
let miss = 0;
for (const rel of critical) {
  const abs = path.join(sidecar, rel);
  if (fs.existsSync(abs)) console.log(`  OK   ${rel}`);
  else { console.log(`  缺失 ${rel}`); miss++; failed = true; }
}
console.log(miss === 0 ? 'Windows 原生模块齐全 ✅' : `缺 ${miss} 个原生模块 ❌`);

// ---- 5) 产物 exe 的 fuse 状态（asar 完整性校验必须已关闭）----
step('5/6 产物 exe fuse 校验');
{
  const exePath = path.join(__dirname, 'dist', 'HeadlessWB', 'HeadlessWB.exe');
  if (!fs.existsSync(exePath)) { console.log('未找到 HeadlessWB.exe'); failed = true; }
  else {
    const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
    const buf = fs.readFileSync(exePath);
    const i = buf.indexOf(SENTINEL);
    if (i < 0) { console.log('未找到 fuse 区 ❌'); failed = true; }
    else {
      const count = buf[i + SENTINEL.length + 1];
      const names = ['RunAsNode','EnableCookieEncryption','EnableNodeOptionsEnvironmentVariable',
        'EnableNodeCliInspectArguments','EnableEmbeddedAsarIntegrityValidation',
        'OnlyLoadAppFromAsar','LoadBrowserProcessSpecificV8Snapshot','GrantFileProtocolExtraPrivileges'];
      for (let k = 0; k < count; k++) {
        console.log(`  [${k}] ${names[k] || ('fuse#' + k)} = ${String.fromCharCode(buf[i + SENTINEL.length + 2 + k])}`);
      }
      const integrity = String.fromCharCode(buf[i + SENTINEL.length + 2 + 4]);
      const onlyAsar = String.fromCharCode(buf[i + SENTINEL.length + 2 + 5]);
      const ok1 = integrity === '0';
      const ok2 = onlyAsar === '1';
      console.log(ok1 ? 'asar 完整性校验已关闭 ✅' : 'asar 完整性校验仍开启 ❌（Windows 上会 FATAL）');
      console.log(ok2 ? 'OnlyLoadAppFromAsar 保持开启 ✅' : 'OnlyLoadAppFromAsar 被改动 ❌');
      if (!ok1 || !ok2) failed = true;
    }
  }
}

// ---- 6) dist 与源码一致性（真机教训：曾用旧 dist 打包导致"改对了没验到"）----
step('6/6 dist 与源码一致性');
{
  const { createHash } = await import('node:crypto');
  const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const pairs = [
    ['patch/headless-patch.js', 'dist/HeadlessWB/resources/headless-patch.js'],
    ['install.ps1', 'dist/HeadlessWB/install.ps1'],
    ['uninstall.ps1', 'dist/HeadlessWB/uninstall.ps1'],
    ['tools/wb-ctl.ps1', 'dist/HeadlessWB/tools/wb-ctl.ps1'],
    ['tools/verify.ps1', 'dist/HeadlessWB/tools/verify.ps1'],
    ['tools/deploy.ps1', 'dist/HeadlessWB/tools/deploy.ps1'],
  ];
  let bad = 0;
  for (const [a, b] of pairs) {
    const pa = path.join(__dirname, a), pb = path.join(__dirname, b);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { console.log(`  缺失 ${a} 或 ${b}`); bad++; continue; }
    if (sha(pa) === sha(pb)) console.log(`  OK   ${b}`);
    else { console.log(`  DIFF ${b}`); bad++; }
  }
  if (bad) { console.log(`${bad} 个文件不一致 ❌`); failed = true; }
  else console.log('dist 与源码完全一致 ✅');
}

console.log(failed ? '\n验证未全部通过 ❌' : '\n全部验证通过 ✅');
process.exit(failed ? 1 : 0);
