import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mech-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  agyDataDir: home,
  tabTitleEnabled: false,
  remoteConfirm: 'ask-then-allow',
}));

const {
  acp,
  transport,
  parseCmd,
  handleCommand,
  handleCardCallback,
  handleHookEvent,
  isPriorityCardEvent,
  isPriorityCommandText,
} = await import('../daemon/daemon.mjs');
const {writeNamingPref} = await import('../daemon/naming.mjs');
const {loadConfig} = await import('../daemon/config.mjs');
writeNamingPref({enabled: false, model: '', source: 'off'});

acp.start = async () => ({});
acp.call = async (method) => {
  if (method === 'session/list') return {sessions: []};
  return {};
};

function runHookAsync(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('plugin/hook.mjs')], {env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`hook exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

const sent = [];
transport.send = async (payload) => { sent.push(payload); };
const popSent = () => sent.splice(0, sent.length);

function writeTranscript(sid, items) {
  const file = path.join(home, 'brain', sid, '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return file;
}

test('acp defaults to --process-per-session for multi-session crash isolation', () => {
  assert.deepEqual(acp.args, ['acp', '--process-per-session']);
  assert.equal(loadConfig().acpProcessPerSession, true);

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    agyDataDir: home,
    tabTitleEnabled: false,
    acpProcessPerSession: false,
  }));
  assert.equal(loadConfig().acpProcessPerSession, false);

  // Restore default
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    agyDataDir: home,
    tabTitleEnabled: false,
    remoteConfirm: 'ask-then-allow',
  }));
});

test('hooks.json matches ask_question and plugin/hook.mjs forwards it even under always-proceed', async () => {
  const hooks = JSON.parse(fs.readFileSync(path.resolve('plugin/hooks.json'), 'utf8'));
  const matcher = hooks['agy-remote-wecom'].PreToolUse[0].matcher;
  assert.match(matcher, /\bask_question\b/);

  const hookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ask-hook-'));
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({decision: 'deny', reason: 'from-daemon'}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    fs.mkdirSync(path.join(hookHome, 'agy-data'), {recursive: true});
    fs.writeFileSync(path.join(hookHome, 'agy-data', 'settings.json'), JSON.stringify({toolPermission: 'always-proceed'}));
    fs.writeFileSync(path.join(hookHome, 'config.json'), JSON.stringify({
      botId: 'b', secret: 's', localPort: port, remoteConfirm: 'allow',
    }));
    fs.writeFileSync(path.join(hookHome, '.token'), 'tok-ask');

    const rawOut = await runHookAsync(
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv-ask-1',
        toolCall: {name: 'ask_question', args: {questions: [{question: '选哪个？', options: ['A', 'B']}]}},
      }),
      {...process.env, AGY_REMOTE_HOME: hookHome, AGY_REMOTE_ACP: ''},
    );
    const out = JSON.parse(rawOut);
    assert.equal(received.length, 1);
    assert.equal(received[0].toolCall.name, 'ask_question');
    assert.equal(out.decision, 'deny');
    assert.equal(out.reason, 'from-daemon');
  } finally {
    server.close();
    fs.rmSync(hookHome, {recursive: true, force: true});
  }
});

test('ask_question pushes single/multi-select cards on mobile turns and returns selected answers via deny reason', async () => {
  const sid = 'tui-ask-1';
  const tp = writeTranscript(sid, [{type: 'USER_INPUT', content: '帮我选方案'}]);
  await handleHookEvent({hookEventName: 'SessionStart', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  // Desktop turn should not be intercepted
  await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  const desktopRes = await handleHookEvent({
    hookEventName: 'PreToolUse',
    conversationId: sid,
    cwd: home,
    pid: process.pid,
    toolCall: {name: 'ask_question', args: {questions: [{question: '方案？', options: ['A', 'B']}]}},
  });
  assert.deepEqual(desktopRes, {decision: 'ask'});
  await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});

  // Switch to this session and simulate a mobile-originated turn via Stop continuation
  const lsCard = await handleCommand('ls');
  const targetOpt = lsCard.card.options.find((o) => o.text.includes('新会话') || o.text.includes('帮我选方案')) || lsCard.card.options[0];
  await handleCardCallback({taskId: lsCard.card.task_id, optionId: targetOpt.id});

  // Put session in running state then queue a mobile message so Stop continues with mobile origin
  await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  await handleCommand('继续执行');
  const cont = await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  assert.equal(cont.decision, 'continue');
  popSent();

  // Trigger multi-question ask_question (Q1 single select, Q2 multi select)
  const askPromise = handleHookEvent({
    hookEventName: 'PreToolUse',
    conversationId: sid,
    cwd: home,
    pid: process.pid,
    toolCall: {
      name: 'ask_question',
      args: {
        questions: [
          {question: '部署环境？', options: ['测试环境', '生产环境'], is_multi_select: false},
          {question: '需要哪些检查？', options: ['单测', '类型检查', 'E2E'], is_multi_select: true},
        ],
      },
    },
  });

  const q1Payload = sent.find((m) => m?.card?.card_type === 'vote_interaction');
  assert.ok(q1Payload, 'Q1 card should be sent');
  assert.equal(q1Payload.card.mode, 0);
  assert.equal(isPriorityCardEvent({task_id: q1Payload.card.task_id}), true);
  assert.match(q1Payload.card.title, /问题 1\/2/);
  popSent();

  const q1Reply = await handleCardCallback({
    taskId: q1Payload.card.task_id,
    optionId: q1Payload.card.options[0].id,
  });
  assert.match(q1Reply, /已收到回答/);
  assert.match(q1Reply, /测试环境/);

  const q2Payload = sent.find((m) => m?.card?.card_type === 'vote_interaction');
  assert.ok(q2Payload, 'Q2 card should be sent after Q1');
  assert.equal(q2Payload.card.mode, 1);
  assert.match(q2Payload.card.title, /问题 2\/2/);
  popSent();

  const q2Reply = await handleCardCallback({
    taskId: q2Payload.card.task_id,
    optionIds: [q2Payload.card.options[0].id, q2Payload.card.options[2].id],
  });
  assert.match(q2Reply, /已提交回答/);
  assert.match(q2Reply, /单测、E2E/);

  const hookRes = await askPromise;
  assert.equal(hookRes.decision, 'deny');
  assert.match(hookRes.reason, /部署环境？ -> 测试环境/);
  assert.match(hookRes.reason, /需要哪些检查？ -> 单测, E2E/);

  await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
});

test('steer command injects userMessage in PreInvocation and falls back to Stop continuation', async () => {
  assert.deepEqual(parseCmd('steer 改用方案 B'), {cmd: 'steer', rest: '改用方案 B'});
  assert.deepEqual(parseCmd('插话 先别改配置'), {cmd: 'steer', rest: '先别改配置'});
  assert.deepEqual(parseCmd('纠偏 只跑单测'), {cmd: 'steer', rest: '只跑单测'});
  assert.equal(isPriorityCommandText('插话 改方案'), true);
  assert.match(await handleCommand('插话'), /运行中插话/);

  const sid = 'tui-steer-1';
  const tp = writeTranscript(sid, [{type: 'USER_INPUT', content: '开始重构'}]);
  await handleHookEvent({hookEventName: 'SessionStart', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  // Select tui-steer-1
  const lsCard = await handleCommand('ls');
  const opt = lsCard.card.options.find((o) => o.text.includes('开始重构')) || lsCard.card.options[0];
  await handleCardCallback({taskId: lsCard.card.task_id, optionId: opt.id});

  // Start running
  await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp, invocationNum: 0});
  const steerAck = await handleCommand('插话 保留旧接口兼容');
  assert.match(steerAck, /已加入插话/);
  assert.match(steerAck, /待注入 1 条/);

  // Status shows pending steer count
  const st = await handleCommand('status');
  assert.match(st, /待注入插话 1 条/);

  // Next PreInvocation drains steers into injectSteps
  const injected = await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp, invocationNum: 1});
  assert.deepEqual(injected, {
    injectSteps: [{userMessage: '[来自企微手机运行中插话]: 保留旧接口兼容'}],
  });

  // A subsequent steer that arrives right before Stop falls back to Stop continuation
  await handleCommand('steer 顺便补个测试');
  const stopRes = await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp, fullyIdle: true});
  assert.equal(stopRes.decision, 'continue');
  assert.match(stopRes.reason, /顺便补个测试/);

  await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp, fullyIdle: true});
});

test('Stop with fullyIdle=false reports background-running status and defers queued messages until fully idle', async () => {
  const sid = 'tui-bg-1';
  const tp = writeTranscript(sid, [
    {type: 'USER_INPUT', content: '启动子代理调研'},
    {type: 'PLANNER_RESPONSE', content: '已派出子代理，等待结果。'},
  ]);
  await handleHookEvent({hookEventName: 'SessionStart', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  const lsCard = await handleCommand('ls');
  const opt = lsCard.card.options.find((o) => o.text.includes('启动子代理调研')) || lsCard.card.options[0];
  await handleCardCallback({taskId: lsCard.card.task_id, optionId: opt.id});

  await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  // Queue a follow-up message while running
  const queuedReply = await handleCommand('汇总成表格');
  assert.match(queuedReply, /已排队/);
  popSent();

  // First Stop has fullyIdle: false -> should NOT drain queue, should push bg-running notice
  const midStop = await handleHookEvent({
    hookEventName: 'Stop',
    conversationId: sid,
    cwd: home,
    pid: process.pid,
    transcriptPath: tp,
    fullyIdle: false,
  });
  assert.deepEqual(midStop, {});
  const pushed = sent.find((m) => typeof m === 'string');
  assert.ok(pushed, 'should push interim completion notice');
  assert.match(pushed, /阶段完成（后台运行中）/);
  assert.match(pushed, /后台任务\/子代理仍在运行/);

  // Status reflects background activity
  const bgStatus = await handleCommand('status');
  assert.match(bgStatus, /后台任务运行中/);

  // Final Stop after subagent finishes (fullyIdle: true) -> drains queued message
  popSent();
  await handleHookEvent({hookEventName: 'PreInvocation', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp});
  writeTranscript(sid, [
    {type: 'USER_INPUT', content: '启动子代理调研'},
    {type: 'PLANNER_RESPONSE', content: '调研全部完成。'},
  ]);
  const finalStop = await handleHookEvent({
    hookEventName: 'Stop',
    conversationId: sid,
    cwd: home,
    pid: process.pid,
    transcriptPath: tp,
    fullyIdle: true,
  });
  assert.equal(finalStop.decision, 'continue');
  assert.match(finalStop.reason, /汇总成表格/);
  const finalPushed = sent.find((m) => typeof m === 'string');
  assert.match(finalPushed, /任务完成/);

  await handleHookEvent({hookEventName: 'Stop', conversationId: sid, cwd: home, pid: process.pid, transcriptPath: tp, fullyIdle: true});
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
