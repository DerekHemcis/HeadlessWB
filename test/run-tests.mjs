#!/usr/bin/env node
/**
 * 补丁冒烟测试：以子进程方式跑 headless-patch.js 的 mock-electron 场景。
 *   node test/run-tests.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

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
  // --status 模式：校验 status.json 确实被写出（Windows GUI 子系统看不到 stdout，靠它）
  if (mode === '--status') {
    const homeLine = (r.stdout || '').split('\n').find(l => l.startsWith('FAKEHOME='));
    if (homeLine) {
      const fakeHome = homeLine.slice('FAKEHOME='.length).trim();
      const statusFile = path.join(fakeHome, '.workbuddy', 'logs', 'headlesswb', 'status.json');
      const ok = fs.existsSync(statusFile);
      results.push({ name: 'status.json written for GUI-subsystem exe', ok });
      if (ok) {
        try {
          const j = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          results.push({ name: 'status.json has app+running fields', ok: j.app === 'HeadlessWB' && typeof j.running === 'boolean' });
        } catch (e) { results.push({ name: 'status.json parseable', ok: false }); }
      }
    } else {
      results.push({ name: 'FAKEHOME reported', ok: false });
    }
  }
  const bad = results.filter(x => !x.ok);
  console.log(`\n=== ${mode} (exit ${r.status}) ===`);
  for (const x of results) console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}`);
  if (r.status !== 0) { console.log('  stderr:', (r.stderr || '').trim().slice(-400)); }
  if (r.status !== 0 || bad.length) failed = true;
}

console.log(failed ? '\n有失败场景' : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
