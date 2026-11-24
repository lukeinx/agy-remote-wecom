import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-fmt-'));
process.env.AGY_REMOTE_HOME = tmpHome;

const {
  CONFIG_FILE,
  parseJsonc,
  hasJsonComments,
  formatConfigJsonc,
  loadConfig,
  saveConfig,
  updateConfigFile,
  ensureDefaultConfigFile,
  ensureConfigFileForEdit,
} = await import('../daemon/config.mjs');
const {openConfigInEditor} = await import('../bin/remote.mjs');

test('parseJsonc handles line comments, block comments, trailing commas, BOM, and URLs in strings', () => {
  const sample = '\uFEFF' + [
    '// leading comment',
    '{',
    '  /* block comment',
    '     across lines */',
    '  "apiUrl": "https://api.deepseek.com/chat/completions", // inline comment',
    '  "note": "keep /* literal */ and // literal and ,}",',
    '  "escaped": "quote \\" // still string",',
    '  "arr": [1, 2, ],',
    '}',
  ].join('\n');

  const parsed = parseJsonc(sample);
  assert.equal(parsed.apiUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(parsed.note, 'keep /* literal */ and // literal and ,}');
  assert.equal(parsed.escaped, 'quote " // still string');
  assert.deepEqual(parsed.arr, [1, 2]);
});

test('hasJsonComments ignores // and /* inside strings', () => {
  const flat = JSON.stringify({
    apiUrl: 'https://api.deepseek.com/chat/completions',
    note: '/* not a comment */',
  }, null, 2);
  assert.equal(hasJsonComments(flat), false);
  assert.equal(hasJsonComments(`// real comment\n${flat}`), true);
  assert.equal(hasJsonComments(`/* real block */\n${flat}`), true);
});

test('formatConfigJsonc matches config.example.json and preserves custom fields without legacy noise', () => {
  const exampleText = fs.readFileSync(path.resolve('config.example.json'), 'utf8');
  assert.equal(formatConfigJsonc(), exampleText);

  const formatted = formatConfigJsonc({
    botId: 'aib_1',
    secret: 'sec_1',
    ownerUserId: 'U_1',
    terminal: 'ghostty',
    defaultDir: '~/projects/demo',
    defaultMode: 'auto',
    remoteConfirm: 'allow',
    aliases: {demo: '~/projects/demo', app: '~/projects/app'},
    dirAliases: {legacy: '/should-drop'},
    tabTitleEnabled: false,
    namingModel: 'legacy-model',
    tabTitle: {
      enabled: true,
      apiUrl: 'https://example.com/v1/chat/completions',
      apiKey: '$MY_KEY',
      model: 'custom-fast',
      thinking: 'low',
    },
    agyBin: '/opt/bin/agy-custom',
    customFlag: true,
  });

  // Contains all 6 numbered sections and blank lines between them
  for (const marker of [
    '1. 企微机器人与主人绑定',
    '2. 会话与终端默认行为',
    '3. 远程权限确认',
    '4. 目录别名',
    '5. 会话自动命名与终端 Tab 标题',
    '6. 高级设置',
  ]) {
    assert.ok(formatted.includes(marker), `missing section marker: ${marker}`);
  }
  assert.ok(formatted.includes('\n\n  // ==================== 2.'));
  assert.doesNotMatch(formatted, /"dirAliases"|"tabTitleEnabled"|"namingModel"/);

  const parsed = parseJsonc(formatted);
  assert.equal(parsed.botId, 'aib_1');
  assert.equal(parsed.terminal, 'ghostty');
  assert.equal(parsed.agyBin, '/opt/bin/agy-custom');
  assert.equal(parsed.tabTitle.thinking, 'low');
  assert.equal(parsed.tabTitle.apiKey, '$MY_KEY');
  assert.equal(parsed.customFlag, true);
  assert.deepEqual(parsed.aliases, {demo: '~/projects/demo', app: '~/projects/app'});
});

test('ensureConfigFileForEdit upgrades flat legacy JSON once, preserves user comments, and skips broken syntax', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-edit-'));
  try {
    const file = path.join(dir, 'config.json');

    // 1. Legacy flat JSON containing https:// URL should be upgraded with all values preserved
    fs.writeFileSync(file, JSON.stringify({
      botId: 'aib_legacy',
      secret: 'sec_legacy',
      agyBin: '/custom/bin/agy',
      tabTitle: {enabled: true, apiUrl: 'https://api.deepseek.com/chat/completions', apiKey: '$DEEPSEEK_API_KEY', model: 'deepseek-v4.1-flash', thinking: 'off'},
      aliases: {demo: '~/projects/demo'},
    }, null, 2) + '\n', {mode: 0o600});

    const first = ensureConfigFileForEdit(file);
    assert.equal(first.migrated, true);
    const upgradedText = fs.readFileSync(file, 'utf8');
    assert.equal(hasJsonComments(upgradedText), true);
    assert.match(upgradedText, /1\. 企微机器人与主人绑定/);
    const parsed = parseJsonc(upgradedText);
    assert.equal(parsed.botId, 'aib_legacy');
    assert.equal(parsed.agyBin, '/custom/bin/agy');
    assert.deepEqual(parsed.aliases, {demo: '~/projects/demo'});

    // 2. Existing commented file with user custom comment is NOT overwritten
    const withUserNote = `// 我的个人备注\n${upgradedText}`;
    fs.writeFileSync(file, withUserNote, {mode: 0o600});
    const second = ensureConfigFileForEdit(file);
    assert.equal(second.migrated, false);
    assert.equal(fs.readFileSync(file, 'utf8'), withUserNote);

    // 3. Broken flat JSON is left untouched so user can repair it in editor
    const broken = '{"botId": "aib_1", broken}';
    fs.writeFileSync(file, broken, {mode: 0o600});
    const third = ensureConfigFileForEdit(file);
    assert.equal(third.migrated, false);
    assert.ok(third.parseError);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('saveConfig and updateConfigFile keep commented layout and loadConfig validates terminal', () => {
  ensureDefaultConfigFile(CONFIG_FILE);
  assert.equal(hasJsonComments(fs.readFileSync(CONFIG_FILE, 'utf8')), true);

  saveConfig({...loadConfig(), botId: 'aib_ok', secret: 'sec_ok', terminal: 'ghostty'});
  assert.equal(hasJsonComments(fs.readFileSync(CONFIG_FILE, 'utf8')), true);
  assert.equal(loadConfig().terminal, 'ghostty');

  updateConfigFile({aliases: {demo: '~/projects/demo'}});
  const rawAfter = fs.readFileSync(CONFIG_FILE, 'utf8');
  assert.equal(hasJsonComments(rawAfter), true);
  assert.deepEqual(loadConfig().aliases, {demo: '~/projects/demo'});

  // Invalid terminal throws clear validation error
  fs.writeFileSync(CONFIG_FILE, formatConfigJsonc({...loadConfig(), terminal: 'ghosty'}), {mode: 0o600});
  assert.throws(() => loadConfig(), /terminal 无效/);

  // Restore valid config for subsequent tests
  fs.writeFileSync(CONFIG_FILE, formatConfigJsonc({botId: 'aib_ok', secret: 'sec_ok', terminal: 'auto'}), {mode: 0o600});
});

test('openConfigInEditor upgrades flat config and validates after synchronous editor exits', () => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({botId: 'aib_1', secret: 'sec_1', terminal: 'auto'}, null, 2));
  const okMsg = openConfigInEditor({
    file: CONFIG_FILE,
    editor: 'fake-editor --wait',
    spawnSyncFn: (bin, args) => {
      assert.equal(bin, 'fake-editor');
      assert.deepEqual(args, ['--wait', CONFIG_FILE]);
      // File was migrated before editor launched
      assert.equal(hasJsonComments(fs.readFileSync(CONFIG_FILE, 'utf8')), true);
      return {status: 0};
    },
  });
  assert.match(okMsg, /已自动整理为分段带注释格式/);
  assert.match(okMsg, /校验通过/);

  const prevExitCode = process.exitCode;
  const badMsg = openConfigInEditor({
    file: CONFIG_FILE,
    editor: 'fake-editor',
    spawnSyncFn: () => {
      fs.writeFileSync(CONFIG_FILE, formatConfigJsonc({botId: 'aib_1', secret: 'sec_1', defaultMode: 'invalid-mode'}));
      return {status: 0};
    },
  });
  assert.match(badMsg, /校验失败/);
  assert.match(badMsg, /defaultMode/);
  process.exitCode = prevExitCode;
});

test('plugin/hook.mjs parses commented JSONC config without showing unconfigured onboarding', () => {
  const hookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-jsonc-'));
  try {
    fs.writeFileSync(
      path.join(hookHome, 'config.json'),
      formatConfigJsonc({botId: 'aib_configured', secret: 'sec_configured'}),
      {mode: 0o600},
    );
    const out = JSON.parse(
      execFileSync(process.execPath, [path.resolve('plugin/hook.mjs')], {
        input: JSON.stringify({hookEventName: 'SessionStart', conversationId: 'conv-jsonc-1'}),
        env: {...process.env, AGY_REMOTE_HOME: hookHome, AGY_REMOTE_TAB: '', AGY_REMOTE_ACP: ''},
        encoding: 'utf8',
      }),
    );
    assert.equal(out.injectSteps, undefined, 'configured JSONC config must not trigger unconfigured onboarding');
  } finally {
    fs.rmSync(hookHome, {recursive: true, force: true});
  }
});

test.after(() => fs.rmSync(tmpHome, {recursive: true, force: true}));
