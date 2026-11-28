import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-handoff-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: home, tabTitleEnabled: false}));
fs.writeFileSync(path.join(home, 'naming.json'), JSON.stringify({enabled: false, model: '', source: 'off'}));

const {
  ACP_STATE_FILE,
  acp,
  transport,
  handleCommand,
  handleHookEvent,
  handleAttachEvent,
  writeAcpState,
  setDesktopNotifier,
} = await import('../daemon/daemon.mjs');
const {writeNamingPref} = await import('../daemon/naming.mjs');
writeNamingPref({enabled: false, model: '', source: 'off'});

transport.send = async () => {};
const calls = [];
const notifications = [];
setDesktopNotifier((title, body) => notifications.push({title, body}));

let seq = 0;
let prompt = null;
acp.start = async () => ({});
acp.call = async (method, params) => {
  calls.push({method, params});
  if (method === 'session/new') return {sessionId: `bg-${++seq}`};
  if (method === 'session/close') return {};
  if (method === 'session/list') return {sessions: []};
  if (method === 'session/prompt') {
    return new Promise((resolve, reject) => {
      prompt = {resolve, reject, sessionId: params.sessionId};
    });
  }
  throw new Error(`Unexpected method ${method}`);
};

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
}

function readAcpState() {
  return JSON.parse(fs.readFileSync(ACP_STATE_FILE, 'utf8'));
}

async function createBgSession() {
  await handleCommand(`nb ${home}`);
  await handleCommand(`name 后台${seq}`);
  return `bg-${seq}`;
}

async function startBgTurn(text = '执行后台任务') {
  prompt = null;
  const reply = handleCommand(text);
  await until(() => prompt);
  return {reply};
}

test('idle ACP attach immediately closes ACP, promotes to TUI, and clears acp-state entry', async () => {
  const id = await createBgSession();
  const stateBefore = readAcpState();
  assert.equal(stateBefore.sessions[id]?.status, 'idle');

  const closeStart = calls.length;
  const res = await handleAttachEvent({
    conversationId: id,
    pid: process.pid,
    loc: {tty: '/dev/ttys099'},
    cwd: home,
  });
  assert.deepEqual(res, {ok: true, action: 'handed_off', busy: false});
  assert.ok(calls.slice(closeStart).some((c) => c.method === 'session/close' && c.params.sessionId === id));
  const stateAfter = readAcpState();
  assert.equal(stateAfter.sessions[id], undefined);
  assert.match(await handleCommand('model'), /请在当前终端切换/);
});

test('busy ACP attach waits, auto-hands-off on completion with desktop notify, and clears on refresh', async () => {
  notifications.length = 0;
  const id = await createBgSession();
  const {reply} = await startBgTurn('跑长任务');

  const busyState = readAcpState();
  assert.equal(busyState.sessions[id]?.status, 'busy');
  assert.ok(busyState.sessions[id]?.startedAt > 0);

  acp.emit('update', id, {sessionUpdate: 'tool_call', name: 'run_command'});
  assert.equal(readAcpState().sessions[id]?.tool, 'run_command');

  const closeStart = calls.length;
  const waiting = await handleAttachEvent({
    conversationId: id,
    pid: process.pid,
    loc: {tty: '/dev/ttys098'},
    cwd: home,
    totalTokens: 1200,
  });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.action, 'waiting');
  assert.equal(waiting.busy, true);
  assert.equal(waiting.tool, 'run_command');
  assert.equal(calls.slice(closeStart).some((c) => c.method === 'session/close'), false);
  assert.equal(readAcpState().sessions[id]?.waitingPid, process.pid);

  prompt.resolve({stopReason: 'end_turn'});
  await reply;
  await until(() => readAcpState().sessions[id]?.status === 'done');

  assert.ok(calls.slice(closeStart).some((c) => c.method === 'session/close' && c.params.sessionId === id));
  const doneState = readAcpState();
  assert.equal(doneState.sessions[id]?.status, 'done');
  assert.equal(doneState.sessions[id]?.snapshotTokens, 1200);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /已完成/);
  assert.match(notifications[0].body, /\/resume/);

  const cleared = await handleAttachEvent({
    conversationId: id,
    pid: process.pid,
    totalTokens: 2500,
  });
  assert.deepEqual(cleared, {ok: true, action: 'cleared'});
  assert.equal(readAcpState().sessions[id], undefined);
});

test('queued messages drain in ACP before auto-handoff completes', async () => {
  notifications.length = 0;
  const id = await createBgSession();
  const {reply: firstReply} = await startBgTurn('第一轮');

  await handleAttachEvent({
    conversationId: id,
    pid: process.pid,
    loc: {tty: '/dev/ttys097'},
    cwd: home,
    totalTokens: 500,
  });
  const queuedReply = await handleCommand('排队第二轮');
  assert.match(queuedReply, /已排队/);

  const closeStart = calls.length;
  const firstPrompt = prompt;
  prompt = null;
  firstPrompt.resolve({stopReason: 'end_turn'});
  await firstReply;
  await until(() => prompt);

  assert.equal(calls.slice(closeStart).some((c) => c.method === 'session/close'), false);
  assert.equal(readAcpState().sessions[id]?.status, 'busy');
  assert.equal(notifications.length, 0);

  prompt.resolve({stopReason: 'end_turn'});
  await until(() => readAcpState().sessions[id]?.status === 'done');
  assert.ok(calls.slice(closeStart).some((c) => c.method === 'session/close' && c.params.sessionId === id));
  assert.equal(notifications.length, 1);

  const explicitClear = await handleAttachEvent({conversationId: id, refreshed: true});
  assert.deepEqual(explicitClear, {ok: true, action: 'cleared'});
  assert.equal(readAcpState().sessions[id], undefined);
});

test('PreInvocation on busy ACP shows rich elapsed/tool hint and registers pendingHandoff', async () => {
  notifications.length = 0;
  const id = await createBgSession();
  const {reply} = await startBgTurn('测试提示');
  acp.emit('update', id, {sessionUpdate: 'tool_call', name: 'write_file'});

  const blocked = await handleHookEvent({
    conversationId: id,
    hookEventName: 'PreInvocation',
    cwd: home,
    pid: process.pid,
    loc: {tty: '/dev/ttys096'},
  });
  assert.equal(blocked.terminationBehavior, 'terminate');
  const md = blocked.injectSteps[0].systemMessage.metadata.user_markdown;
  assert.match(md, /仍在后台执行/);
  assert.match(md, /已运行/);
  assert.match(md, /write_file/);
  assert.match(md, /\/resume/);
  assert.equal(readAcpState().sessions[id]?.waitingPid, process.pid);

  prompt.resolve({stopReason: 'end_turn'});
  await reply;
  await until(() => readAcpState().sessions[id]?.status === 'done');
  assert.equal(notifications.length, 1);
  await tick();
});

test('writeAcpState({clear: true}) clears sessions on shutdown', () => {
  writeAcpState({clear: true});
  const state = readAcpState();
  assert.deepEqual(state.sessions, {});
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
