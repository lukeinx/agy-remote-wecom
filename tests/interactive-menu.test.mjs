import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-menu-'));
const sampleDir = path.join(home, 'projects');
fs.mkdirSync(sampleDir, {recursive: true});
process.env.AGY_REMOTE_HOME = home;

const {parseKeyChunk, createTui, CANCELLED} = await import('../bin/tui.mjs');
const {runInteractiveMenu, buildMenuStatus} = await import('../bin/menu.mjs');
const {loadConfig, saveConfig, CONFIG_FILE, hasJsonComments} = await import('../daemon/config.mjs');
const {loadAliases} = await import('../daemon/aliases.mjs');
const {readNamingPref} = await import('../daemon/naming.mjs');

function makeStreamPair() {
  const stdin = new EventEmitter();
  stdin.isRaw = false;
  stdin.setRawMode = (v) => { stdin.isRaw = Boolean(v); };
  stdin.resume = () => {};
  stdin.pause = () => {};
  let out = '';
  const stdout = {isTTY: false, write(s) { out += String(s); }};
  return {stdin, stdout, output: () => out};
}

function makeScriptedTui(steps) {
  const queue = [...steps];
  const calls = [];
  const next = (kind, opts) => {
    calls.push({kind, title: opts?.title || '', status: opts?.status || '', notice: opts?.notice || null, items: opts?.items?.map((i) => i.value)});
    if (!queue.length) throw new Error(`unexpected ${kind} call: ${opts?.title || ''}`);
    const step = queue.shift();
    if (typeof step === 'function') return step(opts);
    return step;
  };
  return {
    calls,
    tui: {
      select: async (opts) => next('select', opts),
      input: async (opts) => next('input', opts),
      confirm: async (opts) => next('confirm', opts),
    },
  };
}

test('parseKeyChunk parses arrows, enter, backspace, escape, ctrl-c and UTF-8 chars', () => {
  const keys = parseKeyChunk('\x1b[A\x1b[B\r\x7f中文\x1b\x03');
  assert.deepEqual(keys, [
    {name: 'up'},
    {name: 'down'},
    {name: 'enter'},
    {name: 'backspace'},
    {name: 'char', char: '中'},
    {name: 'char', char: '文'},
    {name: 'escape'},
    {name: 'ctrl-c'},
  ]);
});

test('createTui select, masked input, validation and confirm work over raw stdin/stdout', async () => {
  const {stdin, stdout, output} = makeStreamPair();
  const tui = createTui({stdin, stdout, color: false});

  const pSelect = tui.select({
    title: '选择终端',
    items: [{value: 'auto', label: 'auto'}, {value: 'ghostty', label: 'ghostty'}],
  });
  stdin.emit('data', '\x1b[B\r');
  assert.equal(await pSelect, 'ghostty');

  const pInput = tui.input({
    title: '输入 Secret',
    mask: true,
    validate: (v) => (v.length >= 4 ? '' : '至少 4 位'),
  });
  stdin.emit('data', 'ab\r');
  assert.match(output(), /至少 4 位/);
  stdin.emit('data', 'cd\r');
  assert.equal(await pInput, 'abcd');
  assert.ok(!output().includes('abcd'), 'masked secret must never be echoed in plaintext');

  const pCancel = tui.confirm({title: '确认操作'});
  stdin.emit('data', '\x03');
  assert.equal(await pCancel, CANCELLED);
});

test('runInteractiveMenu auto-runs setup when unconfigured and invokes bind watch', async () => {
  const setupCalls = [];
  let watched = false;
  const {tui} = makeScriptedTui([
    // Auto-entered setup flow
    'bot-test-123',
    'secret-test-999',
    'code',
    // Main menu after setup -> exit
    'exit',
  ]);
  let stdoutBuf = '';
  await runInteractiveMenu({
    tui,
    health: async () => ({version: '0.2.0', wecom: {connected: true}, targets: []}),
    formatWeComStatus: () => '🟢 企微已连接',
    formatPluginStatus: () => '✔ Hook 插件已安装',
    performQuickSetup: async (botId, secret, ownerArg, opts) => {
      setupCalls.push({botId, secret, ownerArg, opts});
      saveConfig({...loadConfig(), botId, secret, ownerUserId: ''});
      return {code: '654321', state: {wecom: {connected: true}}, plugin: {ok: true}};
    },
    watchBindingInTerminal: async () => {
      watched = true;
      saveConfig({...loadConfig(), ownerUserId: 'U_OWNER'});
      return {status: 'bound', owner: 'U_OWNER'};
    },
    stdout: {write(s) { stdoutBuf += s; }},
  });

  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].botId, 'bot-test-123');
  assert.equal(setupCalls[0].secret, 'secret-test-999');
  assert.equal(setupCalls[0].opts.forceUnbind, true);
  assert.equal(watched, true);
  assert.match(stdoutBuf, /654321/);
  assert.equal(loadConfig().ownerUserId, 'U_OWNER');
});

test('runInteractiveMenu updates preferences, aliases, naming and preserves JSONC comments', async () => {
  const {tui, calls} = makeScriptedTui([
    // 1. Preferences: terminal -> ghostty, defaultMode -> auto, remoteConfirm -> ask, back
    'prefs',
    'terminal', 'ghostty',
    'defaultMode', 'auto',
    'remoteConfirm', 'ask',
    null,
    // 2. Aliases: add 'work' -> sampleDir, select 'work' -> set defaultDir, back
    'alias',
    '__add__', 'work', sampleDir,
    'work', 'default',
    null,
    // 3. Naming: change model -> custom-flash, thinking -> low, toggle off, back
    'name',
    'model', 'custom-flash',
    'thinking', 'low',
    'toggle',
    null,
    // 4. Restart with busy task -> confirm force
    'restart',
    true,
    // 5. Exit
    'exit',
  ]);

  let restartCalled = null;
  await runInteractiveMenu({
    tui,
    health: async () => ({version: '0.2.0', wecom: {connected: true}, targets: [{label: '编译中', busy: true}]}),
    formatWeComStatus: () => '🟢 企微已连接',
    formatPluginStatus: () => '✔ Hook 插件已安装',
    performStart: async (opts) => {
      restartCalled = opts;
      return {state: {wecom: {connected: true}}};
    },
    cwd: sampleDir,
    stdout: {write() {}},
  });

  const cfg = loadConfig();
  assert.equal(cfg.terminal, 'ghostty');
  assert.equal(cfg.defaultMode, 'auto');
  assert.equal(cfg.remoteConfirm, 'ask');
  assert.equal(loadAliases().work, sampleDir);
  assert.equal(cfg.defaultDir, sampleDir);
  assert.equal(cfg.tabTitle.model, 'custom-flash');
  assert.equal(cfg.tabTitle.thinking, 'low');
  assert.equal(readNamingPref(cfg).enabled, false);
  assert.deepEqual(restartCalled, {restart: true, force: true});
  assert.equal(hasJsonComments(fs.readFileSync(CONFIG_FILE, 'utf8')), true);
  assert.match(buildMenuStatus({version: '0.2.0', wecom: {connected: true}, targets: [1, 2]}, () => '🟢 企微已连接'), /活跃会话 2/);
  assert.ok(calls.some((c) => c.notice?.text?.includes('默认终端已设为 ghostty')));
});

test('runInteractiveMenu with initialAction=setup forces wizard when configured, highlights home-only alias and cwd defaultDir', async () => {
  // Reset aliases back to only default home, and keep defaultDir as '~'
  saveConfig({...loadConfig(), botId: 'bot-existing', secret: 'sec-existing', ownerUserId: 'U_EXIST', defaultDir: '~', aliases: {home: '~'}});
  const setupCalls = [];
  const projectCwd = path.join(home, 'my-new-project');
  fs.mkdirSync(projectCwd, {recursive: true});

  const {tui, calls} = makeScriptedTui([
    // Forced setup flow even though botId/secret exist
    'bot-existing',
    'sec-existing',
    'code',
    // Main menu -> Preferences -> defaultDir -> pick top "当前目录 · ..." -> back -> exit
    'prefs',
    'defaultDir',
    `~${projectCwd.slice(os.homedir().length)}`.startsWith('~~') ? projectCwd : projectCwd,
    null,
    'exit',
  ]);
  // Note: projectCwd is inside os.tmpdir() (not under os.homedir()), so tildeDir(projectCwd) === projectCwd
  assert.equal(calls.length, 0);

  await runInteractiveMenu({
    tui,
    initialAction: 'setup',
    cwd: projectCwd,
    health: async () => ({version: '0.3.0', wecom: {connected: true}, targets: []}),
    formatWeComStatus: () => '🟢 企微已连接',
    formatPluginStatus: () => '✔ Hook 插件已安装',
    performQuickSetup: async (botId, secret, ownerArg, opts) => {
      setupCalls.push({botId, secret, ownerArg, opts});
      return {code: '112233', state: {wecom: {connected: true}}, plugin: {ok: true}};
    },
    watchBindingInTerminal: async () => ({status: 'bound', owner: 'U_EXIST'}),
    stdout: {write() {}},
  });

  assert.equal(setupCalls.length, 1);
  const mainMenuCall = calls.find((c) => c.title === '📱 Agy Remote');
  assert.ok(mainMenuCall, 'should render main menu after forced setup');
  assert.match(mainMenuCall.notice?.text || '', /顺手添加项目目录别名/);
  // Verify defaultDir select had cwd placed first before 'home' alias
  const dirCall = calls.find((c) => c.title === '选择默认新建目录');
  assert.ok(dirCall, 'should prompt defaultDir selection');
  assert.equal(dirCall.items[0], projectCwd);
  assert.equal(loadConfig().defaultDir, projectCwd);
});

test('CLI falls back to status markdown when non-TTY and rejects explicit menu outside TTY', () => {
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/remote.mjs');
  const statusOut = execFileSync(process.execPath, [cli], {
    env: {...process.env, AGY_REMOTE_HOME: home},
    encoding: 'utf8',
  });
  assert.match(statusOut, /Agy Remote WeCom/);

  assert.throws(
    () => execFileSync(process.execPath, [cli, 'menu'], {
      env: {...process.env, AGY_REMOTE_HOME: home},
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    /需要在终端 TTY 中运行/,
  );
});

test.after(() => fs.rmSync(home, {recursive: true, force: true}));
