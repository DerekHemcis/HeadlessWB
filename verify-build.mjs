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

step('1/3 补丁语法检查');
run(process.execPath, ['--check', path.join(__dirname, 'patch', 'headless-patch.js')]);

step('2/3 冒烟测试（mock electron）');
run(process.execPath, [path.join(__dirname, 'test', 'run-tests.mjs')]);

step('3/3 产物 asar 校验');
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

console.log(failed ? '\n验证未全部通过 ❌' : '\n全部验证通过 ✅');
process.exit(failed ? 1 : 0);
