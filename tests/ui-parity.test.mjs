import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ui-'));
process.env.AGY_REMOTE_HOME = home;
process.env.AGY_REMOTE_NO_LISTEN = '1';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: home, tabTitleEnabled: false}));
const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/pi-ui.json', import.meta.url), 'utf8'));
const {handleCommand, handleCardCallback, parseCmd, isPriorityCommandText, acp, transport} = await import('../daemon/daemon.mjs');
const {writeNamingPref} = await import('../daemon/naming.mjs');
writeNamingPref({enabled: false, model: '', source: 'off'});
let configs = [
  {id: 'model', currentValue: 'test-model', options: [{value:'test-model',name:'test-model'}, {value:'other-model',name:'Other'}]},
  {id: 'thought_level', currentValue: 'low', options: [{value:'low',name:'low'}, {value:'high',name:'high'}]},
];
acp.start = async () => ({});
acp.call = async (method, params) => {
  if (method === 'session/new') return {sessionId: 'ui-session', configOptions: configs};
  if (method === 'session/list') return {sessions: []};
  if (method === 'session/set_config_option') {
    configs = configs.map((o) => o.id === params.configId ? {...o,currentValue:params.value} : o);
    return {configOptions:configs};
  }
  if (method === 'session/prompt') return {stopReason: 'end_turn'};
  throw new Error(`unexpected ${method}`);
};
const normalize = (obj) => JSON.parse(JSON.stringify(obj, (key,value) => key === 'task_id' ? 'TASK' : key === 'id' && typeof value === 'string' && value.startsWith('pb_') ? 'OPTION' : value));

test('help panel matches simplified Pi layout and discloses advanced commands via more', async () => {
  const help = await handleCommand('help');
  assert.match(help, /^\*\*📖 命令表\*\*/);
  for (const row of [
    '| n | 创建会话 |',
    '| ls | 活跃会话 |',
    '| remote / mute | 关注 / 取关 |',
    '| model | 模型 |',
    '| think | 思考强度 |',
    '| cd | 目录 |',
    '| compact | 压缩 |',
    '| recap | 回顾 |',
    '| status | 状态 |',
    '| usage | 用量 |',
    '| stop | 停止 |',
    '| help / help all | 帮助 / 更多帮助 |',
  ]) {
    assert.ok(help.includes(row), `help missing row: ${row}`);
  }
  for (const hidden of ['| nb |', '| h |', '| steer |', '| mode |', '| name |', '| art |', '| restart |']) {
    assert.ok(!help.includes(hidden), `main help should hide advanced row: ${hidden}`);
  }
  assert.match(help, /> 1\. 电脑终端 `agy-remote` 配置/);
  assert.doesNotMatch(help, /`\/remote`/);
  assert.doesNotMatch(help, /> 4\./);

  for (const q of ['more', '更多命令', '进阶命令', '全部命令', '更多帮助', '帮助 更多', 'help more', 'help all']) {
    assert.deepEqual(parseCmd(q), {cmd: 'help', rest: 'more'});
    assert.equal(isPriorityCommandText(q), true);
  }
  assert.equal(parseCmd('更多'), null);
  assert.equal(parseCmd('more details'), null);
  assert.equal(parseCmd('更多命令有哪些'), null);
  assert.equal(parseCmd('帮助 我看一下报错'), null);
  assert.equal(parseCmd('help me debug this'), null);

  const more = await handleCommand('更多帮助');
  assert.match(more, /^\*\*📖 更多帮助\*\*/);
  for (const row of [
    '| nb | 创建后台会话 |',
    '| h | 历史会话 |',
    '| steer | 插话 |',
    '| mode | 模式 |',
    '| name | 命名 |',
    '| art | 产物 |',
    '| restart | 重启 |',
  ]) {
    assert.ok(more.includes(row), `more help missing row: ${row}`);
  }
});

test('created and selected native state cards match the Pi output fixtures', async () => {
  assert.deepEqual(normalize(await handleCommand('nb ~')), reference.created);
  await handleCommand('name 对齐测试');
  const list = await handleCommand('ls');
  const selected = await handleCardCallback({taskId:list.card.task_id,optionId:list.card.options[0].id});
  assert.deepEqual(normalize(selected), reference.selected);
});

test('thinking picker matches Pi title, current marker, hint, button and fallback', async () => {
  assert.deepEqual(normalize(await handleCommand('think')), reference.think);
  assert.match(await handleCommand('think impossible'), /当前模型不支持：impossible/);
  const done = await handleCommand('think 高');
  assert.equal(done.card.main_title.title, '🧠 切换思考强度');
  assert.equal(done.card.emphasis_content.title, 'high · 高');
  assert.deepEqual(done.card.horizontal_content_list.map((f) => f.keyname), ['会话','模型']);
});

test('model and directory pickers retain icons and Pi field hierarchy', async () => {
  const model = await handleCommand('model');
  assert.equal(model.card.title, '💡 切换模型 · 对齐测试');
  assert.equal(model.card.desc, '可选 2 个 · 发「模型 关键词」筛选');
  assert.equal(model.card.options[0].text, 'test-model · ← 当前');
  assert.match(model.fallback, /卡片发送失败/);
  const dir = await handleCommand('cd');
  assert.equal(dir.card.title, '📁 切换目录');
  assert.equal(dir.card.desc, '未配置别名的目录，可发「目录 ~/路径」');
  assert.equal(dir.card.submit_text, '切换目录');
});

test('artifacts use Pi native multi-select and send small sets without redundant success text', async () => {
  const dir = path.join(home,'brain','ui-session');
  fs.mkdirSync(dir,{recursive:true});
  for (let n=0;n<4;n++) fs.writeFileSync(path.join(dir,`${n}.md`),'x');
  const card = await handleCommand('art');
  assert.equal(card.card.title,'📎 会话产物');
  assert.equal(card.card.desc,'共 4 个 · 可多选');
  assert.match(card.card.options[0].text,/\.md · 1B · 刚刚/);
  assert.equal(card.card.mode,1);
  fs.unlinkSync(path.join(dir,'3.md'));
  const sent=[];
  transport.send=async (file)=>sent.push(file);
  assert.equal(await handleCommand('art'),'');
  assert.equal(sent.length,3);
});

test('compact is unavailable unless ACP advertises it, then returns the native Pi completion card', async () => {
  assert.match(await handleCommand('compact'), /不支持远程压缩/);
  acp.emit('update', 'ui-session', {sessionUpdate:'available_commands_update', availableCommands:[{name:'compact'}]});
  const done = await handleCommand('compact 保留结论');
  assert.equal(done.card.card_type, 'text_notice');
  assert.equal(done.card.main_title.title, '🗜️ 压缩会话');
  assert.equal(done.card.emphasis_content.title, '已压缩');
  assert.deepEqual(done.card.horizontal_content_list.map((f)=>f.keyname), ['会话','重点']);
});

test('ACP status progressively discloses mode switching without showing TUI steer tip', async () => {
  const st = await handleCommand('status');
  assert.match(st, /模式：default（发 `模式` 切换）/);
  assert.doesNotMatch(st, /插话 内容/);
});

test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
