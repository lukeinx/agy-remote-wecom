#!/usr/bin/env node
// Launched only in a newly-created terminal. Register its actual process even before
// Agy starts the first model invocation; an empty TUI need not emit SessionStart yet.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {processContext} from '../plugin/context.mjs';
process.env.AGY_REMOTE_HOME = process.argv[2];
const sessionId = process.argv[3];
if (!sessionId) throw new Error('缺少新建会话 ID');
const {loadConfig, RUN_DIR} = await import('../daemon/config.mjs');
const cfg = loadConfig();
const token = fs.readFileSync(path.join(RUN_DIR, '.token'), 'utf8').trim();
const {loc} = processContext(process.pid);
const child = spawn(cfg.agyBin, ['--conversation', sessionId], {stdio: 'inherit', env: process.env});
const report = async (hookEventName, extra = {}) => {
  const response = await fetch(`http://127.0.0.1:${cfg.localPort}/hook`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-agy-token': token},
    body: JSON.stringify({hookEventName, conversationId: sessionId, cwd: process.cwd(), pid: child.pid || 0,
      nonce: process.env.AGY_REMOTE_TAB || '', loc, ...extra}), signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`注册失败 (${response.status})`);
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch {} });
let registration;
child.once('spawn', () => {
  registration = report('SessionStart').catch((e) => console.error(`Agy Remote：${e.message}`));
});
child.once('error', async (error) => {
  console.error(`无法启动 Agy：${error.message}`);
  await report('RemoteExit', {error: error.message}).catch(() => {});
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  await registration;
  await report('RemoteExit', {error: code ? `Agy 退出（${code}）` : '', signal}).catch(() => {});
  process.exitCode = code || 0;
});
