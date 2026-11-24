import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {processContext} from '../plugin/context.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-create-'));
const fakeAgy = path.join(home, 'agy');
const argsFile = path.join(home, 'argv.json');
fs.writeFileSync(fakeAgy, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1000);\n`, {mode: 0o755});
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
let handleHookEvent;
const reports = [];
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  reports.push(body);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(await handleHookEvent(body)));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({localPort: server.address().port, agyBin: fakeAgy, terminal: 'tmux', agyDataDir: home, tabTitleEnabled: false}));
const daemon = await import('../daemon/daemon.mjs');
({handleHookEvent} = daemon);
const {handleCommand, acp} = daemon;
const {ADAPTERS} = await import('../daemon/terminals.mjs');
const calls = [];
acp.start = async () => ({});
acp.call = async (method, params) => {
  calls.push({method, params});
  if (method === 'session/new') return {sessionId: 'native-empty-session', models: {currentModelId: 'test-model'}};
  if (method === 'session/close') return {};
  throw new Error(`unexpected ACP method ${method}`);
};
ADAPTERS.tmux.detect = async () => true;
let launcher;
ADAPTERS.tmux.open = async ({cwd, nonce, agyCmd}) => {
  // Exercise the real launcher, against an idle fake Agy that never emits hooks.
  launcher = spawn('/bin/sh', ['-c', `exec ${agyCmd}`], {cwd, env: {...process.env, AGY_REMOTE_TAB: nonce}, stdio: 'ignore'});
  return 'test-tab';
};

test('empty terminal creation registers without a model invocation and returns the Pi native creation card', async () => {
  const reply = await handleCommand(`n ${home}`);
  assert.equal(reply.card.card_type, 'text_notice');
  assert.equal(reply.card.main_title.title, '✏️ 创建会话');
  assert.equal(reply.card.emphasis_content.title, '新会话');
  assert.deepEqual(reply.card.horizontal_content_list.map((f) => f.keyname), ['目录', '类型', '模型']);
  assert.equal(reply.card.horizontal_content_list[1].value, '终端可见');
  assert.equal(reply.card.horizontal_content_list[2].value, 'test-model');
  assert.deepEqual(calls.map((c) => c.method), ['session/new', 'session/close']);
  assert.ok(reports[0].pid > 0);
  assert.notEqual(reports[0].pid, launcher.pid); // actual Agy child, not its launcher/shell
  for (let n = 0; n < 500 && !fs.existsSync(argsFile); n++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['--conversation', 'native-empty-session']);
  const exit = once(launcher, 'exit');
  launcher.kill('SIGTERM');
  await exit;
  assert.equal(reports.at(-1).hookEventName, 'RemoteExit');
});

test('hook ownership skips the transient shell and node launcher, and resolves outer terminal tty across PTY wrappers', () => {
  const processes = new Map([
    [40, {parent: 30, tty: 'ttys001', command: '/bin/sh'}],
    [30, {parent: 20, tty: 'ttys001', command: '/Users/test/.local/bin/agy'}],
    [20, {parent: 1, tty: 'ttys001', command: 'node'}],
  ]);
  const result = processContext(40, (pid) => processes.get(pid), {});
  assert.equal(result.pid, 30);
  assert.equal(result.loc.tty, '/dev/ttys001');

  // PTY wrapper (e.g. agy-cycle.py): agy sits on inner pty ttys005 while Ghostty/zsh sits on outer ttys000
  const wrapped = new Map([
    [50, {parent: 40, tty: 'ttys005', command: '/bin/sh'}],
    [40, {parent: 30, tty: 'ttys005', command: '/Users/test/.local/bin/agy'}],
    [30, {parent: 20, tty: 'ttys000', command: 'Python'}],
    [20, {parent: 10, tty: 'ttys000', command: '-/bin/zsh'}],
    [10, {parent: 1, tty: '??', command: '/Applications/Ghostty.app/Contents/MacOS/ghostty'}],
  ]);
  const wrappedRes = processContext(50, (pid) => wrapped.get(pid), {TERM_PROGRAM: 'ghostty'});
  assert.equal(wrappedRes.pid, 40);
  assert.equal(wrappedRes.loc.tty, '/dev/ttys000');
});

test.after(async () => {
  if (launcher && launcher.exitCode === null && !launcher.killed) launcher.kill('SIGTERM');
  await new Promise((r) => server.close(r));
  fs.rmSync(home, {recursive: true, force: true});
});
