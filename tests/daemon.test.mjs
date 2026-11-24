import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {EventEmitter} from 'node:events';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-home-'));
process.env.AGY_REMOTE_HOME = tmpHome;
process.env.AGY_REMOTE_NO_LISTEN = '1';

const {parseCmd, plainText, handleCommand, handleHookEvent, setSessionTitle, triggerAutoNaming} = await import('../daemon/daemon.mjs');
const {WeComTransport} = await import('../daemon/wecom.mjs');
const {loadConfig, saveConfig, createBindCode, ensureDefaultConfigFile, isToolAutoAllowedByAgy, BIND_FILE} = await import('../daemon/config.mjs');
const {saveAliases, loadAliases} = await import('../daemon/aliases.mjs');
const {formatTabTitle, cleanGeneratedTitle, readNamingPref, writeNamingPref, loadTitles, requestChineseTitle, resolveApiModelId} = await import('../daemon/naming.mjs');

test('parseCmd parses Chinese and English short commands', () => {
  assert.deepEqual(parseCmd('ls'), {cmd: 'ls', rest: ''});
  assert.deepEqual(parseCmd('活跃会话'), {cmd: 'ls', rest: ''});
  assert.deepEqual(parseCmd('历史会话 远程'), {cmd: 'h', rest: '远程'});
  assert.deepEqual(parseCmd('创建会话 demo 帮我查一下'), {cmd: 'n', rest: 'demo 帮我查一下'});
  assert.deepEqual(parseCmd('创建后台会话 ~/projects/demo 跑单测'), {cmd: 'nb', rest: '~/projects/demo 跑单测'});
  assert.deepEqual(parseCmd('模型 argon'), {cmd: 'model', rest: 'argon'});
  assert.deepEqual(parseCmd('思考强度 高'), {cmd: 'think', rest: '高'});
  assert.deepEqual(parseCmd('模式 auto'), {cmd: 'mode', rest: 'auto'});
  assert.deepEqual(parseCmd('选择会话 3'), {cmd: 'select_num', rest: '3'});
  assert.equal(parseCmd('帮我重构这段代码'), null);
  assert.equal(parseCmd('模型这个怎么样'), null);
});

test('config, bind code, and aliases persistence', () => {
  const cfg = loadConfig();
  assert.equal(cfg.localPort, 18779);
  saveConfig({...cfg, botId: 'bot_123', secret: 'sec_456'});
  const reloaded = loadConfig();
  assert.equal(reloaded.botId, 'bot_123');

  const code = createBindCode(tmpHome);
  assert.match(code, /^\d{6}$/);
  const savedBind = JSON.parse(fs.readFileSync(path.join(tmpHome, BIND_FILE), 'utf8'));
  assert.equal(savedBind.code, code);

  saveAliases({demo: '~/projects/demo', Home: '~'});
  const aliases = loadAliases();
  assert.equal(aliases.demo, '~/projects/demo');
});

test('plainText formats three-section markdown message', () => {
  const msg = plainText({head: '🏁 任务完成', subject: '测试会话', body: '正文内容', foot: '目录：~ · 运行：`3s`'});
  assert.match(msg, /^### 🏁 任务完成 · 测试会话/);
  assert.match(msg, /正文内容/);
  assert.match(msg, /`目录：~` · 运行：`3s`/);
});

test('handleHookEvent returns decision:ask for desktop-initiated PreToolUse when not watching all', async () => {
  await handleHookEvent({
    conversationId: 'conv-desktop-1',
    hookEventName: 'SessionStart',
    cwd: '/tmp',
    pid: process.pid,
  });
  await handleHookEvent({
    conversationId: 'conv-desktop-1',
    hookEventName: 'PreInvocation',
    cwd: '/tmp',
    pid: process.pid,
  });
  const res = await handleHookEvent({
    conversationId: 'conv-desktop-1',
    hookEventName: 'PreToolUse',
    cwd: '/tmp',
    pid: process.pid,
    toolCall: {name: 'run_command', args: {CommandLine: 'ls'}},
  });
  assert.deepEqual(res, {decision: 'ask'});
});

test('auto-naming, manual rename, and tab status icons align with pi-remote', async () => {
  assert.equal(cleanGeneratedTitle('“企微遥控迁移评估。”\n多余行'), '企微遥控迁移评估');
  assert.equal(formatTabTitle('企微遥控迁移', 'idle'), '企微遥控迁移');
  assert.equal(formatTabTitle('企微遥控迁移', 'running', 0), '⠋ 企微遥控迁移');
  assert.equal(formatTabTitle('企微遥控迁移', 'running', 1), '⠙ 企微遥控迁移');
  assert.equal(formatTabTitle('企微遥控迁移', 'done'), '· 企微遥控迁移');
  assert.equal(formatTabTitle('企微遥控迁移', 'error'), '× 企微遥控迁移');

  assert.deepEqual(parseCmd('命名 状态栏同步'), {cmd: 'name', rest: '状态栏同步'});
  assert.deepEqual(parseCmd('改名 auto'), {cmd: 'name', rest: 'auto'});
  assert.deepEqual(parseCmd('name off'), {cmd: 'name', rest: 'off'});

  writeNamingPref({enabled: false, model: '', source: 'off'});
  assert.equal(readNamingPref().enabled, false);
  writeNamingPref({source: 'default'});
  assert.equal(readNamingPref().enabled, true);
  assert.equal(readNamingPref().model, 'deepseek-v4.1-flash');
  assert.equal(resolveApiModelId('deepseek-v4.1-flash', 'https://api.deepseek.com/chat/completions'), 'deepseek-flash');

  // Verify stateless HTTP naming payload (thinking: disabled by default, reasoning_effort: low when low)
  let capturedBody = null;
  const titleOff = await requestChineseTitle('把配置改为单一配置表并用 deepseek 命名', {
    apiUrl: 'https://api.deepseek.com/chat/completions',
    apiKey: 'sk-test-key',
    model: 'deepseek-v4.1-flash',
    thinking: 'off',
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({choices: [{message: {content: '“配置表与Tab命名”'}}]}),
      };
    },
  });
  assert.equal(titleOff, '配置表与Tab命名');
  assert.equal(capturedBody.model, 'deepseek-flash');
  assert.equal(capturedBody.max_tokens, 1024);
  assert.equal(capturedBody.reasoning_effort, undefined);

  const fakeTarget = {sessionId: 'sess-name-1', kind: 'acp', cwd: '/tmp', loc: {}};
  await triggerAutoNaming(fakeTarget, '帮我把 pi remote 移植到 agy', {
    generator: async () => '移植 Pi Remote 到 Agy',
  });
  assert.equal(fakeTarget.customName, '移植 Pi Remote 到 Agy');
  assert.equal(loadTitles()['sess-name-1'].title, '移植 Pi Remote 到 Agy');

  setSessionTitle(fakeTarget, '手动命名测试', 'manual');
  assert.equal(fakeTarget.customName, '手动命名测试');
  assert.equal(loadTitles()['sess-name-1'].source, 'manual');
});

test('PreInvocation hook intercepts /remote and SessionStart shows one-time onboarding hint when unconfigured', () => {
  const hookPath = path.resolve('plugin/hook.mjs');
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-onboard-'));
  ensureDefaultConfigFile(path.join(freshHome, 'config.json'));

  // 1. First SessionStart when unconfigured injects onboarding card
  const firstStart = JSON.parse(
    execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({hookEventName: 'SessionStart', conversationId: 'conv-onboard-1'}),
      env: {...process.env, AGY_REMOTE_HOME: freshHome, AGY_REMOTE_TAB: '', AGY_REMOTE_ACP: ''},
      encoding: 'utf8',
    }),
  );
  assert.match(firstStart.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown || '', /尚未配置机器人/);

  // 2. Second SessionStart does not repeat the onboarding card
  const secondStart = JSON.parse(
    execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({hookEventName: 'SessionStart', conversationId: 'conv-onboard-2'}),
      env: {...process.env, AGY_REMOTE_HOME: freshHome, AGY_REMOTE_TAB: '', AGY_REMOTE_ACP: ''},
      encoding: 'utf8',
    }),
  );
  assert.equal(secondStart.injectSteps, undefined);
  fs.rmSync(freshHome, {recursive: true, force: true});

  for (const input of [
    '/remote',
    '<USER_REQUEST>\n/remote alias\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>',
    '<USER_REQUEST>\n/agy-remote-wecom:remote setup\n</USER_REQUEST>',
  ]) {
    const out = JSON.parse(
      execFileSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          hookEventName: 'PreInvocation',
          conversationId: 'conv-slash-1',
          lastUserInput: input,
        }),
        env: {...process.env, AGY_REMOTE_HOME: tmpHome, AGY_REMOTE_ACP: ''},
        encoding: 'utf8',
      }),
    );
    assert.equal(out.terminationBehavior, 'terminate');
    assert.equal(out.injectSteps?.[0]?.systemMessage?.systemMessage, '');
    assert.ok(out.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown?.length > 10);
  }

  // 非首轮调用（invocationNum >= 1）不再重复执行 /remote
  const nonFirst = JSON.parse(
    execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        hookEventName: 'PreInvocation',
        invocationNum: 1,
        conversationId: 'conv-slash-1',
        lastUserInput: '/remote',
      }),
      env: {...process.env, AGY_REMOTE_HOME: tmpHome, AGY_REMOTE_ACP: ''},
      encoding: 'utf8',
    }),
  );
  assert.equal(nonFirst.terminationBehavior, undefined);
});

test('agy settings.json toolPermission:always-proceed and permissions.allow auto-approve without WeCom cards', async () => {
  const agyDir = path.join(tmpHome, 'agy-data');
  fs.mkdirSync(agyDir, {recursive: true});

  // 1. permissions.allow matches simple allowed commands
  fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
    toolPermission: 'request-review',
    permissions: {allow: ['command(ls)', 'command(grep)']},
  }));
  assert.equal(isToolAutoAllowedByAgy(agyDir, {name: 'run_command', args: {CommandLine: 'ls -la'}}), true);
  assert.equal(isToolAutoAllowedByAgy(agyDir, {name: 'run_command', args: {CommandLine: 'rm -rf /tmp/x'}}), false);
  assert.equal(isToolAutoAllowedByAgy(agyDir, {name: 'run_command', args: {CommandLine: 'ls && rm -rf /tmp/x'}}), false);

  // 2. toolPermission: "always-proceed" auto-allows all tools
  fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
    toolPermission: 'always-proceed',
  }));
  assert.equal(isToolAutoAllowedByAgy(agyDir, {name: 'run_command', args: {CommandLine: 'curl -s http://127.0.0.1:18779/health'}}), true);
  assert.equal(isToolAutoAllowedByAgy(agyDir, {name: 'edit_file', args: {Path: '/tmp/a.js'}}), true);

  // 3. remoteAll (关注) does not throw ReferenceError when a session is busy, and does not hijack desktop PreToolUse
  const watchReply = await handleCommand('关注');
  assert.match(watchReply, /已关注/);
  const desktopPreTool = await handleHookEvent({
    conversationId: 'conv-desktop-1',
    hookEventName: 'PreToolUse',
    cwd: '/tmp',
    pid: process.pid,
    toolCall: {name: 'run_command', args: {CommandLine: 'git status'}},
  });
  assert.deepEqual(desktopPreTool, {decision: 'ask'});
});

test('restart waits for slow WeCom sendMessage ACK so new daemon does not replay restarting notice from outbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-restart-outbox-'));
  const sent = [];
  const makeClient = (delayMs = 0) => {
    const client = new EventEmitter();
    client.connect = () => {};
    client.disconnect = () => {};
    client.sendMessage = async (_to, payload) => {
      sent.push(payload.markdown?.content || '');
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    };
    return client;
  };
  const cfg = {botId: 'bot_1', secret: 'sec_1', ownerUserId: 'owner_1', inboxDir: path.join(dir, 'inbox')};
  // Pre-seed welcome.json so initial connect does not emit first-time welcome
  fs.writeFileSync(path.join(dir, 'welcome.json'), JSON.stringify({key: 'bot_1\nowner_1'}));

  const client1 = makeClient(380); // Simulate >300ms WebSocket ACK RTT
  let resolveShutdown;
  const shutdownDone = new Promise((r) => { resolveShutdown = r; });
  const t1 = new WeComTransport({
    config: cfg,
    dir,
    client: client1,
    onMessage: async (text) => {
      if (text === '重启') {
        t1.drain();
        setImmediate(async () => {
          await t1.inbound;
          await t1.flush();
          t1.stop();
          resolveShutdown();
        });
        return plainText({head: '🔄 正在重启 Agy Remote 服务', body: 'launchd 将在数秒内拉起新进程并恢复连接。'});
      }
      return '';
    },
  });
  t1.start();
  client1.emit('authenticated');

  client1.emit('message', {
    body: {
      msgid: 'msg-restart-1',
      aibotid: 'bot_1',
      chattype: 'single',
      from: {userid: 'owner_1'},
      msgtype: 'text',
      text: {content: '重启'},
    },
  });

  await shutdownDone;
  assert.equal(t1.queueFiles().length, 0, 'outbox should be empty before old daemon exits');
  assert.equal(sent.filter((m) => m.includes('正在重启 Agy Remote 服务')).length, 1);

  // Launchd spawns new daemon instance on the same directory
  const client2 = makeClient(0);
  const t2 = new WeComTransport({
    config: cfg,
    dir,
    client: client2,
    onMessage: async () => '',
  });
  t2.start();
  client2.emit('authenticated');
  await t2.flush();
  t2.stop();

  assert.equal(sent.filter((m) => m.includes('正在重启 Agy Remote 服务')).length, 1, 'restarting notice must not be sent twice');
  assert.equal(sent.filter((m) => m.includes('Agy Remote 已重启')).length, 1, 'restarted notice should be sent once');
  fs.rmSync(dir, {recursive: true, force: true});
});
