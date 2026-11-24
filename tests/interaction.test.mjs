import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import http from 'node:http';
import {promisify} from 'node:util';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-interaction-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
const {handleCommand, handleHookEvent, handleCardCallback, buildLsCard, buildHistCard, acp, parseCmd} = await import('../daemon/daemon.mjs');
const {parseJsonc} = await import('../daemon/config.mjs');
acp.call = async (method) => {
  if (method === 'session/list') return {sessions: []};
  throw new Error(`unexpected ACP call: ${method}`);
};
const pick = (card, index = 0) => ({taskId: card.task_id, optionId: card.options[index].id});

// Busy terminal targets accept a queued message without invoking a terminal or model.
async function register(id) {
  await handleHookEvent({conversationId: id, hookEventName: 'SessionStart', cwd: home, pid: process.pid});
  await handleHookEvent({conversationId: id, hookEventName: 'PreInvocation', cwd: home, pid: process.pid});
}

test('unselected message and attachments are held, selected once, with actionable replay feedback', async () => {
  await register('first-session');
  await register('second-session');
  const ack = {media: false};
  const reply = await handleCommand('继续检查', [{path: '/tmp/example.txt', name: 'example.txt'}], ack);
  assert.match(reply.card.title, /发给哪个会话/);
  assert.equal(ack.media, true);
  const callback = pick(reply.card);
  const delivered = await handleCardCallback(callback);
  assert.match(typeof delivered === 'string' ? delivered : delivered.fallback, /已排队/);
  assert.match(await handleCardCallback(callback), /已经提交过/);
});

test('card callbacks reject foreign task ids without consuming valid cards', async () => {
  const status = await handleCommand('状态');
  assert.equal(status.card.submit_text, '查看状态');
  const callback = pick(status.card);
  assert.match(await handleCardCallback({...callback, taskId: 'foreign'}), /失效/);
  assert.match(await handleCardCallback(callback), /运行中/);
});

test('numeric selection uses the displayed list order, not a fresh live/history merge', async () => {
  const row = (sessionId) => ({sessionId, label: () => sessionId});
  buildLsCard([row('first-session'), row('second-session')]);
  buildHistCard([row('second-session')]);
  const selected = await handleCommand('选择会话 1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).currentSessionId, 'second-session');
  assert.equal(selected.card.main_title.title, '📥 选择会话');
  assert.match(await handleCommand('选择会话 2'), /序号超出范围/);
  assert.deepEqual(parseCmd('select 1 继续检查'), {cmd: 'select_num', rest: '1', message: '继续检查'});
});

test('non-delivery commands keep attachments pending and Pi aliases work', async () => {
  const ack = {media: false};
  const reply = await handleCommand('帮助', [{path: '/tmp/example.txt'}], ack);
  assert.match(reply, /命令表/);
  assert.equal(ack.media, false);
  for (const alias of ['查询活跃会话', '切换会话']) assert.deepEqual(parseCmd(alias), {cmd: 'ls', rest: ''});
});

test('slash aliases use session cwd, preserve spaces and reject nonexistent directories', () => {
  const cwd = path.join(home, 'project with spaces');
  fs.mkdirSync(cwd);
  const run = (args) => execFileSync(process.execPath, ['bin/remote.mjs', '__slash'], {
    encoding: 'utf8', env: {...process.env, AGY_SLASH_ARGS: args, AGY_SESSION_CWD: cwd}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  run('alias here');
  run('alias dot .');
  run(`alias spaced "${cwd}"`);
  const table = parseJsonc(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).aliases;
  assert.equal(table.here, cwd);
  assert.equal(table.dot, cwd);
  assert.equal(table.spaced, cwd);
  assert.match(run('alias list'), /spaced/);
  assert.throws(() => run('alias missing ./absent'), /目录不存在/);
  assert.throws(() => run('alias rm missing'), /没有别名/);
});

test('slash name preserves operation feedback and restart refuses busy sessions before installation', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/health'
      ? {service: 'agy-remote-wecom', targets: [{label: '正在执行的任务', busy: true}]}
      : {reply: '无法自动命名，请发送 `命名 新名称`。'}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({localPort: server.address().port, botId: 'test', secret: 'test'}));
  const run = (args) => promisify(execFile)(process.execPath, ['bin/remote.mjs', '__slash'], {
    env: {...process.env, AGY_SLASH_ARGS: args},
  });
  try {
    const {stdout} = await run('name auto');
    assert.match(stdout, /无法自动命名/);
    assert.match(stdout, /`agy-remote name 新名称`/);
    await assert.rejects(run('restart'), /有任务正在运行/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
