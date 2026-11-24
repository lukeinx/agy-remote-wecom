import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-onboarding-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';

const {WeComTransport, BIND_CARD} = await import('../daemon/wecom.mjs');
const {handleCommand, handleCardCallback, acp} = await import('../daemon/daemon.mjs');
const {
  tryInstallPlugin,
  formatPluginStatus,
  formatWeComStatus,
  waitForWeComReady,
  watchBindingInTerminal,
  performStart,
  formatStartOutput,
} = await import('../bin/remote.mjs');

test('BIND_CARD includes create-session shortcut alongside active sessions and help', () => {
  const titles = BIND_CARD.jump_list.map((x) => x.title);
  assert.deepEqual(titles, ['创建会话', '活跃会话', '查看帮助']);
  assert.equal(BIND_CARD.jump_list[0].question, '创建会话');
});

test('first message with zero active sessions holds message/attachments and creates background session on pick', async () => {
  const prompts = [];
  acp.start = async () => ({});
  acp.call = async (method, params) => {
    if (method === 'session/list') {
      return {
        sessions: [{
          sessionId: 'hist-recent-1',
          cwd: home,
          title: '旧历史会话',
          updatedAt: new Date().toISOString(),
        }],
      };
    }
    if (method === 'session/new') {
      return {sessionId: 'acp-created-1', configOptions: []};
    }
    if (method === 'session/prompt') {
      prompts.push(params);
      return {stopReason: 'end_turn'};
    }
    throw new Error(`unexpected ACP call: ${method}`);
  };

  const ack = {media: false};
  const media = [{local: '/tmp/shot.png', name: 'shot.png', kind: 'image'}];
  const reply = await handleCommand('帮我检查冷启动体验', media, ack);

  assert.equal(ack.media, true);
  assert.equal(reply.card?.card_type, 'vote_interaction');
  assert.match(reply.card.title, /暂无活跃会话/);
  assert.equal(reply.card.options.length, 3);
  assert.match(reply.card.options[0].text, /新建终端会话/);
  assert.match(reply.card.options[1].text, /新建后台会话/);
  assert.match(reply.card.options[2].text, /旧历史会话.*历史/);

  const pickBg = {taskId: reply.card.task_id, optionId: reply.card.options[1].id};
  const created = await handleCardCallback(pickBg);
  assert.equal(created.card?.main_title?.title, '✏️ 创建会话');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'acp-created-1');
  assert.match(JSON.stringify(prompts[0].prompt), /帮我检查冷启动体验/);

  // Re-submitting the same card is rejected with an actionable hint
  assert.match(await handleCardCallback(pickBg), /已经提交过/);
});

test('WeComTransport captures fatal auth/kick errors without letting disconnected overwrite them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wecom-err-'));
  const logs = [];
  const fakeClient = Object.assign(new EventEmitter(), {
    connect() {},
    disconnect() { this.emit('disconnected', 'manual'); },
  });
  const transport = new WeComTransport({
    config: {botId: 'bot-1', secret: 'sec-1', ownerUserId: ''},
    dir,
    onMessage: async () => '',
    onCard: async () => '',
    log: (line) => logs.push(line),
    client: fakeClient,
  });

  const authErr = Object.assign(new Error('Max auth failure attempts exceeded (3)'), {
    name: 'WSAuthFailureError',
    code: 'WS_AUTH_FAILURE_EXHAUSTED',
  });
  fakeClient.emit('error', authErr);
  fakeClient.emit('disconnected', 'closed');
  fakeClient.emit('reconnecting', 1);

  const st1 = transport.status();
  assert.equal(st1.connected, false);
  assert.match(st1.fatalError, /认证失败/);
  assert.equal(st1.reason, st1.fatalError);
  assert.ok(logs.some((l) => l.includes('WS_AUTH_FAILURE_EXHAUSTED')));

  // Successful authentication clears fatalError and lastError
  fakeClient.emit('authenticated');
  const st2 = transport.status();
  assert.equal(st2.connected, true);
  assert.equal(st2.fatalError, '');
  assert.equal(st2.lastError, '');

  // Kicked with kickRetryDelays exhausted sets fatalError even after client.disconnect emits disconnected
  const exhausted = [];
  const transportNoRetry = new WeComTransport({
    config: {botId: 'bot-1', secret: 'sec-1', ownerUserId: ''},
    dir,
    onMessage: async () => '',
    onCard: async () => '',
    log: (line) => logs.push(line),
    client: fakeClient,
    kickRetryDelays: [],
    onKickExhausted: (msg) => exhausted.push(msg),
  });
  fakeClient.emit('event.disconnected_event', {});
  const st3 = transportNoRetry.status();
  assert.equal(st3.connected, false);
  assert.match(st3.fatalError, /被其他连接占用/);
  assert.equal(st3.reason, st3.fatalError);
  assert.equal(exhausted.length, 1);

  transport.stop();
  transportNoRetry.stop();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('WeComTransport recovers from transient disconnected_event and escalates only after retries exhaust', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wecom-kick-'));
  const logs = [];
  const exhausted = [];
  let connects = 0;
  let disconnects = 0;
  const fakeClient = Object.assign(new EventEmitter(), {
    connect() { connects += 1; },
    disconnect() { disconnects += 1; this.emit('disconnected', 'manual'); },
  });
  const transport = new WeComTransport({
    config: {botId: 'bot-1', secret: 'sec-1', ownerUserId: ''},
    dir,
    onMessage: async () => '',
    onCard: async () => '',
    log: (line) => logs.push(line),
    client: fakeClient,
    kickRetryDelays: [20, 30],
    kickStableMs: 50,
    onKickExhausted: (msg) => exhausted.push(msg),
  });

  // 1st kick: schedules retry, preserves retry reason even after disconnected event
  fakeClient.emit('event.disconnected_event', {});
  const st1 = transport.status();
  assert.equal(st1.connected, false);
  assert.equal(st1.fatalError, '');
  assert.match(st1.reason, /重试（1\/2）/);
  assert.equal(exhausted.length, 0);
  assert.equal(disconnects, 1);

  // After 1st retry delay, connect() is called; authenticating and staying stable resets attempt count
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(connects, 1);
  fakeClient.emit('authenticated');
  assert.equal(transport.status().connected, true);
  assert.ok(logs.some((l) => l.includes('第 1 次自愈重试')));
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(transport.kickAttempts, 0);

  // Repeated kicks without staying stable exhaust all retries and trigger onKickExhausted
  fakeClient.emit('event.disconnected_event', {}); // attempt 1/2
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(connects, 2);
  fakeClient.emit('authenticated');
  fakeClient.emit('event.disconnected_event', {}); // attempt 2/2
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(connects, 3);
  fakeClient.emit('authenticated');
  fakeClient.emit('event.disconnected_event', {}); // exhausted

  const stEnd = transport.status();
  assert.equal(stEnd.connected, false);
  assert.match(stEnd.fatalError, /被其他连接占用/);
  assert.equal(stEnd.reason, stEnd.fatalError);
  assert.equal(exhausted.length, 1);

  // No further reconnect after exhaustion
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connects, 3);

  transport.stop();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('tryInstallPlugin and formatPluginStatus surface failures honestly instead of faking success', () => {
  const fail = tryInstallPlugin('missing-agy', () => {
    throw new Error('安装 agy hook 插件失败：spawn missing-agy ENOENT');
  });
  assert.equal(fail.ok, false);
  assert.match(formatPluginStatus(fail), /未自动安装/);
  assert.match(formatPluginStatus(fail), /install-plugin/);

  const ok = tryInstallPlugin('agy', () => 'installed');
  assert.equal(ok.ok, true);
  assert.equal(formatPluginStatus(ok), '✔ Hook 插件已安装');
});

test('waitForWeComReady exits early on connected or fatalError', async () => {
  let calls = 0;
  const ready = await waitForWeComReady({
    initialState: {wecom: {connected: false, reason: '未连接'}},
    healthFn: async () => {
      calls += 1;
      return calls >= 2
        ? {wecom: {connected: false, fatalError: '企微认证失败'}}
        : {wecom: {connected: false, reason: '重连中'}};
    },
    timeoutMs: 5000,
    intervalMs: 1,
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(ready.wecom.fatalError, '企微认证失败');
  assert.match(formatWeComStatus(ready.wecom), /^🔴 企微认证失败/);
});

test('watchBindingInTerminal aborts immediately on fatalError or daemon exit and prints transitions on success', async () => {
  const bindFile = path.join(home, 'bind-test.json');
  fs.writeFileSync(bindFile, JSON.stringify({code: '123456', expiresAt: Date.now() + 60_000}));

  // 1. Fatal error aborts immediately
  const errLines = [];
  const errRes = await watchBindingInTerminal({
    isTTY: true,
    bindFile,
    healthFn: async () => ({wecom: {connected: false, bound: false, fatalError: '企微认证失败'}}),
    write: (s) => errLines.push(s),
    logLine: (s) => errLines.push(s),
    sleep: async () => {},
  });
  assert.equal(errRes.status, 'error');
  assert.match(errLines.join('\n'), /企微认证失败/);

  // 2. Missing daemon aborts after 3 missed health checks
  let missCount = 0;
  const stopLines = [];
  const stopRes = await watchBindingInTerminal({
    isTTY: true,
    bindFile,
    healthFn: async () => { missCount += 1; return null; },
    write: (s) => stopLines.push(s),
    logLine: (s) => stopLines.push(s),
    sleep: async () => {},
  });
  assert.equal(stopRes.status, 'stopped');
  assert.equal(missCount, 3);
  assert.match(stopLines.join('\n'), /后台服务已停止/);

  // 3. Connecting -> connected -> bound emits transition and restart-existing-terminal tip
  const states = [
    {wecom: {connected: true, bound: false}},
    {wecom: {connected: true, bound: true}},
  ];
  let idx = 0;
  const okLines = [];
  const okRes = await watchBindingInTerminal({
    isTTY: true,
    bindFile,
    initiallyConnected: false,
    healthFn: async () => states[Math.min(idx++, states.length - 1)],
    loadConfigFn: () => ({ownerUserId: 'U_TEST'}),
    write: (s) => okLines.push(s),
    logLine: (s) => okLines.push(s),
    sleep: async () => {},
  });
  assert.equal(okRes.status, 'bound');
  assert.equal(okRes.owner, 'U_TEST');
  const okText = okLines.join('\n');
  assert.match(okText, /企微已连接/);
  assert.match(okText, /绑定成功/);
  assert.match(okText, /此前已打开的 agy 终端需重启或新开/);
});

test('performStart generates bind code for unbound config and formatStartOutput prints readable guidance', async () => {
  let createdCode = '';
  const res = await performStart({
    loadConfigFn: () => ({botId: 'aib-1', secret: 'sec-1', ownerUserId: '', agyBin: 'agy'}),
    healthFn: async () => null,
    readBindCodeFn: () => '',
    createBindCodeFn: () => { createdCode = '654321'; return createdCode; },
    installPluginFn: () => ({ok: false, output: '', error: 'agy not found'}),
    startServiceFn: async () => ({version: '0.1.0', wecom: {connected: true, bound: false}}),
    waitReadyFn: async ({initialState}) => initialState,
  });

  assert.equal(createdCode, '654321');
  assert.equal(res.code, '654321');
  const out = formatStartOutput({...res, action: '启动'});
  assert.match(out, /Agy Remote 服务已启动/);
  assert.match(out, /🟢 企微已连接/);
  assert.match(out, /Hook 插件未自动安装/);
  assert.match(out, /654321/);
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
