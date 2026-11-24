import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-terminal-'));
const commandLog = path.join(home, 'commands.jsonl');
const failFlag = path.join(home, 'fail');
fs.mkdirSync(path.join(home, 'bin'));
fs.writeFileSync(path.join(home, 'bin', 'tmux'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(fs.existsSync(${JSON.stringify(failFlag)}) ? 1 : 0);\n`, {mode: 0o755});
process.env.PATH = path.join(home, 'bin') + path.delimiter + process.env.PATH;
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: home, tabTitleEnabled: false}));
const {handleCommand, handleHookEvent, buildLsCard, acp, transport} = await import('../daemon/daemon.mjs');
const {writeNamingPref} = await import('../daemon/naming.mjs');
writeNamingPref({enabled: false, model: '', source: 'off'});
const sent = [];
transport.send = async (msg) => {sent.push(msg);};
acp.start = async () => {throw new Error('must not start ACP for terminal delivery');};
acp.call = async () => {throw new Error('must not call ACP for terminal delivery');};
const events = (id, event) => handleHookEvent({conversationId: id, hookEventName: event, cwd: home, pid: process.pid, loc: {tmuxPane: '%test-only'}});
const commands = () => fs.existsSync(commandLog) ? fs.readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('fake terminal did not receive expected command');
}
async function select(id) {
  await events(id, 'SessionStart');
  buildLsCard([{sessionId: id, label: () => id}]);
  await handleCommand('select 1');
  await handleCommand(`name ${id}`);
}

test('messages arriving before terminal acknowledgment queue instead of injecting concurrently', async () => {
  await select('terminal-delivery');
  const first = handleCommand('first message');
  await waitFor(() => commands().some((c) => c.at(-1) === 'Enter'));
  const queued = await handleCommand('second message');
  assert.match(queued, /已排队/);
  assert.equal(commands().filter((c) => c.includes('-l')).length, 1);
  await events('terminal-delivery', 'PreInvocation');
  await events('terminal-delivery', 'Stop');
  assert.match(await first, /无文本输出/);
  await waitFor(() => commands().filter((c) => c.at(-1) === 'Enter').length === 2);
  await events('terminal-delivery', 'PreInvocation');
  await events('terminal-delivery', 'Stop');
  assert.ok(sent.some((m) => typeof m === 'string' && /任务完成/.test(m)));
});

test('terminal injection failure keeps attachments unaccepted and never starts ACP', async () => {
  await select('terminal-failure');
  fs.writeFileSync(failFlag, '1');
  const ack = {media: false};
  const status = await handleCommand('status');
  const reply = await handleCommand('try this', [{path: '/tmp/test-input.txt'}], ack, {quote: status.split('\n')[0]});
  assert.match(reply, /终端投递失败/);
  assert.equal(ack.media, false);
  fs.unlinkSync(failFlag);
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
