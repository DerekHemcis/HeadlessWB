#!/usr/bin/env node
/**
 * 补丁冒烟测试：以子进程方式跑 headless-patch.js 的 mock-electron 场景。
 *   node test/run-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const caseFile = path.join(__dirname, 'case.cjs');
const modes = ['--headless', '--show', '--login', '--status'];

let failed = false;
for (const mode of modes) {
  const env = { ...process.env };
  if (mode === '--login') env.HEADLESSWB_LOGIN_FAST = '1';
  const r = spawnSync(process.execPath, [caseFile, mode], { encoding: 'utf8', timeout: 15000, env });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '{}';
  let parsed = {};
  try { parsed = JSON.parse(last); } catch (e) {}
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const bad = results.filter(x => !x.ok);
  console.log(`\n=== ${mode} (exit ${r.status}) ===`);
  for (const x of results) console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}`);
  if (r.status !== 0) { console.log('  stderr:', (r.stderr || '').trim().slice(-400)); }
  if (r.status !== 0 || bad.length) failed = true;
}

console.log(failed ? '\n有失败场景' : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
