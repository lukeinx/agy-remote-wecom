import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-opt-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  agyDataDir: home,
  tabTitle: {enabled: true, model: 'deepseek-v4.1-flash', thinking: 'off'},
  aliases: {},
}));

const {
  resolveHookCwd,
  handleHookEvent,
  handleCommand,
  liveConfig,
  isPriorityCardEvent,
  isPriorityCommandText,
} = await import('../daemon/daemon.mjs');
const {WeComTransport} = await import('../daemon/wecom.mjs');
const {parseJsonc} = await import('../daemon/config.mjs');
const {updateTargetTabStatus} = await import('../daemon/naming.mjs');
const {fetchCliUsage, clearCliUsageCache} = await import('../daemon/usage.mjs');

test('1. resolveHookCwd and SessionStart keep specific workspace dir instead of overwriting with "/"', async () => {
  assert.equal(resolveHookCwd({cwd: '', workspacePaths: ['/', '/workspace/demo']}), '/workspace/demo');
  assert.equal(resolveHookCwd({cwd: '/', workspacePaths: ['/', '/workspace/demo']}), '/workspace/demo');
  assert.equal(resolveHookCwd({cwd: '/'}, '/workspace/demo'), '/workspace/demo');
  assert.equal(resolveHookCwd({cwd: '/workspace/app', workspacePaths: ['/', '/workspace/demo']}), '/workspace/app');
  assert.equal(resolveHookCwd({cwd: '/'}), '/');

  await handleHookEvent({
    conversationId: 'cwd-guard-session',
    hookEventName: 'SessionStart',
    cwd: home,
    pid: process.pid,
  });
  await handleHookEvent({
    conversationId: 'cwd-guard-session',
    hookEventName: 'SessionStart',
    cwd: '/',
    workspacePaths: ['/'],
    pid: process.pid,
  });
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  const saved = state.tuiSessions.find((s) => s.sessionId === 'cwd-guard-session');
  assert.equal(saved.cwd, home);
});

test('2. liveConfig hot-reloads config.json changes and naming model updates immediately', async () => {
  const before = await handleCommand('命名 model show');
  assert.match(before, /deepseek-v4\.1-flash/);

  await handleCommand('命名 model custom-fast-model');
  const after = await handleCommand('命名 model show');
  assert.match(after, /custom-fast-model/);
  assert.equal(liveConfig().tabTitle.model, 'custom-fast-model');

  // External config.json edit (e.g. via agy-remote config edit) is picked up on next liveConfig()
  const raw = parseJsonc(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  raw.terminal = 'tmux';
  const tmp = path.join(home, 'config.json.next');
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, path.join(home, 'config.json'));
  assert.equal(liveConfig().terminal, 'tmux');
});

test('3. empty aliases prompt uses agy-remote CLI instead of removed /remote slash command', async () => {
  const raw = parseJsonc(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  raw.aliases = {};
  const tmp = path.join(home, 'config.json.alias');
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, path.join(home, 'config.json'));

  const out = await handleCommand('cd');
  assert.match(out, /agy-remote alias/);
  assert.doesNotMatch(out, /\/remote alias/);
});

test('4. subprocess terminals (Ghostty/iTerm2/tmux) do not spawn per-second spinner timers and deduplicate identical titles', async () => {
  const calls = [];
  const fakeSet = (loc, title, opts) => calls.push({loc, title, opts});
  const ghosttyTarget = {
    kind: 'tui',
    customName: '测试会话',
    loc: {tty: '/dev/ttys009', termProgram: 'ghostty'},
    tabTimer: null,
  };

  updateTargetTabStatus(ghosttyTarget, 'running', {tabTitleEnabled: true, frameMs: 20, setTitleFn: fakeSet});
  assert.equal(ghosttyTarget.tabTimer, null, 'Ghostty must not start a polling AppleScript spinner');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '⠋ 测试会话');

  // Calling running again with the same title does not re-trigger osascript
  updateTargetTabStatus(ghosttyTarget, 'running', {tabTitleEnabled: true, frameMs: 20, setTitleFn: fakeSet});
  assert.equal(calls.length, 1);

  // Transition to done triggers one update
  updateTargetTabStatus(ghosttyTarget, 'done', {tabTitleEnabled: true, frameMs: 20, setTitleFn: fakeSet});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, '· 测试会话');

  // Pure tty terminal without subprocess API can still animate with oscOnly=true
  const oscCalls = [];
  const plainTtyTarget = {
    kind: 'tui',
    customName: '纯终端',
    loc: {tty: '/dev/ttys010', termProgram: 'Apple_Terminal'},
    tabTimer: null,
  };
  updateTargetTabStatus(plainTtyTarget, 'running', {
    tabTitleEnabled: true,
    frameMs: 15,
    setTitleFn: (_loc, title, opts) => oscCalls.push({title, opts}),
  });
  await new Promise((r) => setTimeout(r, 45));
  updateTargetTabStatus(plainTtyTarget, 'idle', {tabTitleEnabled: false});
  assert.ok(oscCalls.length >= 2);
  assert.equal(oscCalls[1].opts?.oscOnly, true);
});

test('5a. fetchCliUsage caches valid results and deduplicates concurrent in-flight calls', async () => {
  clearCliUsageCache();
  let calls = 0;
  const fakeExec = (_bin, _args, _opts, cb) => {
    calls += 1;
    setTimeout(() => {
      cb(null, JSON.stringify({
        status: 'SUCCESS',
        command: {
          data: {
            groups: [{
              name: 'Gemini Models',
              buckets: [{window: '5h', remaining_fraction: 0.88, reset_time: ''}],
            }],
          },
        },
      }), '');
    }, 30);
  };

  const [r1, r2] = await Promise.all([
    fetchCliUsage({bin: 'fake-agy', execFileFn: fakeExec}),
    fetchCliUsage({bin: 'fake-agy', execFileFn: fakeExec}),
  ]);
  assert.equal(calls, 1, 'concurrent requests should share one in-flight CLI call');
  assert.equal(r1.groups[0].name, 'Gemini Models');
  assert.equal(r2.groups[0].name, 'Gemini Models');

  const r3 = await fetchCliUsage({bin: 'fake-agy', execFileFn: fakeExec});
  assert.equal(calls, 1, 'subsequent request within TTL should hit cache');
  assert.equal(r3.cached, true);

  const r4 = await fetchCliUsage({bin: 'fake-agy', useCache: false, execFileFn: fakeExec});
  assert.equal(calls, 2, 'useCache:false should force refresh');
  assert.equal(r4.cached, false);
});

test('5b. priority stop/status messages and permission cards bypass slow inbound queue', async () => {
  assert.equal(isPriorityCardEvent({task_id: 'task_perm_123'}), true);
  assert.equal(isPriorityCardEvent({task_id: 'task_ls_123'}), false);
  assert.equal(isPriorityCommandText('停止'), true);
  assert.equal(isPriorityCommandText('status'), true);
  assert.equal(isPriorityCommandText('用量'), true);
  assert.equal(isPriorityCommandText('创建会话'), false);
  assert.equal(isPriorityCommandText('普通对话消息'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prio-'));
  try {
    fs.writeFileSync(path.join(dir, 'welcome.json'), JSON.stringify({key: 'bot_p\nowner_1'}));
    const client = Object.assign(new EventEmitter(), {
      connect() {},
      disconnect() {},
      updateTemplateCard: async () => {},
      sendMessage: async (_to, payload) => {
        delivered.push(payload.markdown?.content || '');
      },
    });
    const delivered = [];
    let releaseSlow;
    const slowGate = new Promise((r) => { releaseSlow = r; });

    const tr = new WeComTransport({
      config: {botId: 'bot_p', secret: 'sec_p', ownerUserId: 'owner_1', inboxDir: path.join(dir, 'inbox')},
      dir,
      client,
      isPriorityCard: isPriorityCardEvent,
      isPriorityMessage: isPriorityCommandText,
      onMessage: async (text) => {
        if (text === '慢消息') {
          await slowGate;
          return 'SLOW_DONE';
        }
        return `FAST_${text}`;
      },
      onCard: async ({taskId}) => `CARD_${taskId}`,
    });
    tr.start();
    client.emit('authenticated');

    const emitMsg = (msgid, content) => client.emit('message', {
      body: {msgid, aibotid: 'bot_p', chattype: 'single', from: {userid: 'owner_1'}, msgtype: 'text', text: {content}},
    });
    const emitCard = (msgid, taskId) => client.emit('event.template_card_event', {
      body: {
        msgid, aibotid: 'bot_p', chattype: 'single', from: {userid: 'owner_1'},
        event: {template_card_event: {task_id: taskId, selected_items: [{option_ids: ['opt1']}]}},
      },
    });

    emitMsg('m1', '慢消息');
    emitMsg('m2', '停止');
    emitCard('c1', 'task_perm_99');

    // Wait briefly without releasing slowGate: both stop and permission card must finish first.
    await new Promise((r) => setTimeout(r, 80));
    await tr.flush();
    assert.ok(delivered.includes('FAST_停止'), 'stop must bypass slow inbound queue');
    assert.ok(delivered.includes('CARD_task_perm_99'), 'permission card must bypass slow inbound queue');
    assert.ok(!delivered.includes('SLOW_DONE'), 'slow message should still be pending');

    releaseSlow();
    await tr.waitIdle();
    await tr.flush();
    assert.ok(delivered.includes('SLOW_DONE'));
    tr.stop();
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
