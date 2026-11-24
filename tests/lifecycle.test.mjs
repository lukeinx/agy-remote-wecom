import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lifecycle-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: home, tabTitleEnabled: false}));
fs.writeFileSync(path.join(home, 'naming.json'), JSON.stringify({enabled: false, model: '', source: 'off'}));
const {handleCommand, handleHookEvent, handleCardCallback, buildLsCard, acp, transport} = await import('../daemon/daemon.mjs');
const {writeNamingPref} = await import('../daemon/naming.mjs');
writeNamingPref({enabled: false, model: '', source: 'off'});
const {transcriptFile} = await import('../daemon/transcript.mjs');
const sent = [];
transport.send = async (msg) => {sent.push(msg);};
const calls = [];
let seq = 0, prompt;
acp.start = async () => ({});
acp.call = async (method, params) => {
  calls.push({method, params});
  if (method === 'session/new') return {sessionId: `background-${++seq}`};
  if (method === 'session/close') return {};
  if (method === 'session/list') return {sessions: []};
  if (method === 'session/prompt') return new Promise((resolve, reject) => {prompt = {resolve, reject, sessionId: params.sessionId};});
  throw new Error(`Unexpected method ${method}`);
};
const tick = () => new Promise((r) => setImmediate(r));
function writeSteps(id, steps) {
  const file = transcriptFile(home, id);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return file;
}
async function background() {
  await handleCommand(`nb ${home}`);
  await handleCommand(`name 后台测试${seq}`);
  return `background-${seq}`;
}
async function begin(text = '执行当前任务') {
  prompt = null;
  const status = await handleCommand('status');
  const reply = handleCommand(text, [], {media: false}, {quote: typeof status === 'string' ? status.split('\n')[0] : ''});
  for (let n = 0; !prompt && n < 1000; n++) await tick();
  assert.ok(prompt, 'message must reach session/prompt');
  return {reply};
}
async function terminal(id) {
  await handleHookEvent({conversationId: id, hookEventName: 'SessionStart', cwd: home, pid: process.pid});
  buildLsCard([{sessionId: id, label: () => id}]);
  await handleCommand('select 1');
  await handleCommand(`name ${id}`);
}

test('ACP cancellation is a notification; pending permission is cancelled; completion is interrupted', async () => {
  await background();
  const {reply} = await begin();
  let outcome;
  acp.emit('permission', {sessionId: prompt.sessionId, options: [{optionId: 'yes', kind: 'allow_once', name: '允许'}]}, (value) => {outcome = value;});
  const permissionCard = sent.findLast((m) => m?.card)?.card;
  let notification;
  acp.notify = (method, params) => {notification = {method, params};};
  const stopped = await handleCommand('stop');
  assert.match(stopped, /已请求中断/);
  assert.equal(notification.method, 'session/cancel');
  assert.equal(outcome.outcome, 'cancelled');
  prompt.resolve({stopReason: 'cancelled'});
  assert.match(await reply, /已中断/);
  const stale = await handleCardCallback({taskId: permissionCard.task_id, optionId: permissionCard.options[0].id});
  assert.match(stale, /已结束/);
  assert.equal(outcome.outcome, 'cancelled');
});

test('failed cancel reports failure rather than claiming it was delivered', async () => {
  await background();
  const {reply} = await begin();
  acp.notify = () => {throw new Error('connection lost');};
  assert.match(await handleCommand('stop'), /中断未送达/);
  prompt.resolve({stopReason: 'end_turn'});
  await reply;
});

test('old transcript is never replayed as new output; busy recap shows the preceding turn', async () => {
  const id = await background();
  const old = [{type: 'USER_INPUT', content: '上一轮问题'}, {type: 'PLANNER_RESPONSE', content: '上一轮答案'}];
  writeSteps(id, old);
  const {reply} = await begin();
  writeSteps(id, [...old, {type: 'USER_INPUT', content: '进行中的问题'}, {type: 'PLANNER_RESPONSE', content: '临时进度'}]);
  const recap = await handleCommand('recap');
  assert.match(recap, /上一轮答案/);
  assert.doesNotMatch(recap, /临时进度/);
  writeSteps(id, old); // simulate delayed transcript flush
  prompt.resolve({stopReason: 'end_turn'});
  const done = await reply;
  assert.doesNotMatch(done, /上一轮答案/);
  assert.match(done, /无文本输出/);
});

test('ACP exit settles once and cancels queued work instead of restarting it', async () => {
  await background();
  const {reply} = await begin();
  assert.match(await handleCommand('排队任务'), /已排队/);
  const before = calls.filter((c) => c.method === 'session/prompt').length;
  const start = sent.length;
  acp.emit('exit', {code: 1});
  prompt.reject(Object.assign(new Error('agy acp 进程已退出'), {exited: true}));
  assert.match(await reply, /进程已退出/);
  await tick();
  assert.equal(calls.filter((c) => c.method === 'session/prompt').length, before);
  assert.equal(sent.slice(start).filter((m) => typeof m === 'string' && /排队消息未执行/.test(m)).length, 1);
  assert.equal(sent.slice(start).filter((m) => typeof m === 'string' && /任务失败/.test(m)).length, 0); // synchronous caller receives it once
});

test('live terminal never loads ACP for model changes or silent delivery fallback', async () => {
  await terminal('terminal-safe');
  const before = calls.length;
  for (const command of ['model', 'think', 'mode']) assert.match(await handleCommand(command), /请在当前终端切换/);
  const ack = {media: false};
  assert.match(await handleCommand('检查工程', [{path: '/tmp/example.txt'}], ack, {quote: (await handleCommand('status')).split('\n')[0]}), /消息未投递/);
  assert.equal(ack.media, false);
  assert.equal(calls.length, before);
});

test('terminal Stop error without answer reports failure and does not continue queue', async () => {
  await terminal('terminal-error');
  const file = writeSteps('terminal-error', [{type: 'USER_INPUT', content: '本轮问题'}]);
  await handleHookEvent({conversationId: 'terminal-error', hookEventName: 'PreInvocation', transcriptPath: file, cwd: home, pid: process.pid});
  await handleCommand('后续排队任务', [], {media: false}, {quote: (await handleCommand('status')).split('\n')[0]});
  const start = sent.length;
  const result = await handleHookEvent({conversationId: 'terminal-error', hookEventName: 'Stop', transcriptPath: file, terminationReason: 'ERROR', cwd: home, pid: process.pid});
  assert.deepEqual(result, {});
  assert.ok(sent.slice(start).some((m) => typeof m === 'string' && /任务失败/.test(m)));
  assert.ok(sent.slice(start).some((m) => typeof m === 'string' && /排队消息未执行/.test(m)));
});

test('ambiguous or unresolvable quoted header prompts selection; body substring cannot route', async () => {
  await terminal('quote-a');
  await handleCommand('name 同名');
  await terminal('quote-b');
  await handleCommand('name 同名');
  const status = await handleCommand('status');
  const quote = status.split('\n')[0];
  const before = calls.length;
  const ack = {media: false};
  const route = await handleCommand('继续', [], ack, {quote});
  assert.equal(route.card.submit_text, '发送');
  assert.equal(ack.media, true);
  assert.equal(calls.length, before);
  const missed = await handleCommand('继续', [], {media: false}, {quote: '### 🏁 任务完成 · 不存在的会话'});
  assert.equal(missed.card.submit_text, '发送');
});

test('quoted long rendered title survives rename using persisted routing entries', async () => {
  const id = await background();
  await handleCommand('name 这是一个很长很长用于验证引用截断行为的会话标题');
  const status = await handleCommand('status');
  await handleCommand('name 新名称');
  await background();
  const start = calls.length;
  const reply = handleCommand('通过旧引用继续', [], {media: false}, {quote: status.split('\n')[0]});
  for (let n = 0; n < 1000 && !calls.slice(start).some((c) => c.method === 'session/prompt'); n++) await tick();
  assert.ok(calls.slice(start).some((c) => c.method === 'session/prompt')); 
  assert.equal(prompt.sessionId, id);
  prompt.resolve({stopReason: 'end_turn'});
  await reply;
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.ok(state.quoteRoutes.some((r) => r.sessionId === id && r.label.includes('很长')));
});

test('background-to-terminal handoff blocks concurrent writes, then releases the idle ACP session', async () => {
  const id = await background();
  const {reply} = await begin();
  const blocked = await handleHookEvent({conversationId: id, hookEventName: 'PreInvocation', cwd: home, pid: process.pid});
  assert.equal(blocked.terminationBehavior, 'terminate');
  assert.match(blocked.injectSteps[0].systemMessage.metadata.user_markdown, /仍在后台执行/);
  prompt.resolve({stopReason: 'end_turn'});
  await reply;
  const before = calls.length;
  await handleHookEvent({conversationId: id, hookEventName: 'SessionStart', cwd: home, pid: process.pid});
  assert.ok(calls.slice(before).some((c) => c.method === 'session/close' && c.params.sessionId === id));
  assert.match(await handleCommand('model'), /请在当前终端切换/);
});

test('asynchronous ACP failure pushes one result and never duplicates the exit notification', async () => {
  await background();
  const {reply} = await begin();
  assert.match(await reply, /运行中/); // let the two-second synchronous window expire
  const start = sent.length;
  acp.emit('exit', {code: 1});
  prompt.reject(Object.assign(new Error('agy acp 进程已退出'), {exited: true}));
  await tick();
  assert.equal(sent.slice(start).filter((m) => typeof m === 'string' && /任务失败/.test(m)).length, 1);
});

test('creating or switching sessions clears prior pushed sessions so the first message delivers directly', async () => {
  await terminal('prior-pushed');
  const file = writeSteps('prior-pushed', [{type: 'USER_INPUT', content: '旧问题'}, {type: 'PLANNER_RESPONSE', content: '旧结果'}]);
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'PreInvocation', transcriptPath: file, cwd: home, pid: process.pid});
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'Stop', transcriptPath: file, cwd: home, pid: process.pid});

  const freshId = await background();
  prompt = null;
  const firstReply = handleCommand('发给新会话的首条消息');
  for (let n = 0; !prompt && n < 1000; n++) await tick();
  assert.ok(prompt, 'plain message right after nb must deliver directly without a route card');
  assert.equal(prompt.sessionId, freshId);
  prompt.resolve({stopReason: 'end_turn'});
  await firstReply;

  // Switching via select also clears prior pushes.
  await handleCommand('remote');
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'PreInvocation', transcriptPath: file, cwd: home, pid: process.pid});
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'Stop', transcriptPath: file, cwd: home, pid: process.pid});
  const secondId = await background();
  prompt = null;
  const secondReply = handleCommand('切换后的首条消息');
  for (let n = 0; !prompt && n < 1000; n++) await tick();
  assert.equal(prompt?.sessionId, secondId);
  prompt.resolve({stopReason: 'end_turn'});
  await secondReply;
});

test('a push arriving after creating a session still guards against misrouting with clear card hints', async () => {
  const newId = await background();
  await handleCommand('remote');
  const file = writeSteps('prior-pushed', [{type: 'USER_INPUT', content: '旧问题'}, {type: 'PLANNER_RESPONSE', content: '插播新结果'}]);
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'PreInvocation', transcriptPath: file, cwd: home, pid: process.pid});
  await handleHookEvent({conversationId: 'prior-pushed', hookEventName: 'Stop', transcriptPath: file, cwd: home, pid: process.pid});

  const ack = {media: false};
  const guarded = await handleCommand('检查新需求', [], ack);
  assert.equal(guarded.card?.title, '✉️ 发给哪个会话？');
  assert.match(guarded.card.desc, /prior-pushed.*刚推送过/);
  assert.match(guarded.card.desc, /消息内容：检查新需求/);
  assert.match(guarded.card.options[0].text, /← 当前/);
  assert.match(guarded.card.options[1].text, /prior-pushed.*← 刚推送/);
  assert.equal(ack.media, true);

  prompt = null;
  const delivered = handleCardCallback({taskId: guarded.card.task_id, optionId: guarded.card.options[0].id});
  for (let n = 0; !prompt && n < 1000; n++) await tick();
  assert.equal(prompt?.sessionId, newId);
  prompt.resolve({stopReason: 'end_turn'});
  await delivered;
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
