import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {
  parseAgyModelsOutput,
  modelMatchesCurrent,
  extractEffortFromModel,
  findModelEntry,
  resolveVariantByDisplayName,
  formatModelLabel,
} from '../daemon/models.mjs';

const SAMPLE_MODELS_OUTPUT = [
  '\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high              Gemini 4 Neon (High)',
  'gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)',
  'gemini-4-neon-medium            Gemini 4 Neon (Medium)',
  'gemini-4-neon-low               Gemini 4 Neon (Low)',
  'gemini-4-argon-medium           Gemini 4 Argon (Medium)',
  'gemini-4-argon-high             Gemini 4 Argon (High)',
  'gemini-4-argon-low              Gemini 4 Argon (Low)',
  'gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh         Gemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium        Gemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low           Gemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon    Orchestrator (Neon)',
  'gemini-pro-orchestrator         Orchestrator (Carbon)',
  'gemini-pro-orchestrator-argon   Orchestrator (Argon)',
  'gemini-3.8-flash-high           Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low            Gemini 3.8 Flash (Low)',
  'claude-opus-5-5-low             Claude Opus 5.5 (Low)',
  'claude-opus-5-5-medium          Claude Opus 5.5 (Medium)',
  'claude-opus-5-5-high            Claude Opus 5.5 (High)',
  'claude-sonnet-5-5-low           Claude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium        Claude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high          Claude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium             GPT-OSS 120B (Medium)',
].join('\n');

test('parseAgyModelsOutput groups multi-effort models identically to ACP configOptions', () => {
  const catalog = parseAgyModelsOutput(SAMPLE_MODELS_OUTPUT);
  assert.equal(catalog.models.length, 10);
  assert.deepEqual(
    catalog.models.map((m) => [m.value, m.name]),
    [
      ['gemini-4-neon', 'Gemini 4 Neon'],
      ['gemini-4-argon', 'Gemini 4 Argon'],
      ['gemini-4-hydrogen', 'Gemini 4 Hydrogen'],
      ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
      ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
      ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
    ],
  );
  assert.deepEqual(findModelEntry(catalog, 'gemini-4-neon-high').efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(findModelEntry(catalog, 'claude-opus-5-5').efforts, ['low', 'medium', 'high']);
  assert.deepEqual(findModelEntry(catalog, 'gpt-oss-120b-medium').efforts, []);
  assert.equal(findModelEntry(catalog, 'gemini-pro-orchestrator-argon').name, 'Orchestrator (Argon)');
  assert.equal(findModelEntry(catalog, 'gemini-pro-orchestrator').name, 'Orchestrator (Carbon)');
  assert.equal(modelMatchesCurrent('gemini-4-neon-high', 'gemini-4-neon'), true);
  assert.equal(modelMatchesCurrent('gemini-4-neon', 'gemini-4-neon'), true);
  assert.equal(modelMatchesCurrent('gemini-pro-orchestrator-neon', 'gemini-4-neon'), false);
  assert.equal(modelMatchesCurrent('gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator'), false);
  assert.equal(modelMatchesCurrent('gemini-pro-orchestrator-argon', 'gemini-pro-orchestrator'), false);
  assert.equal(modelMatchesCurrent('gemini-pro-orchestrator', 'gemini-pro-orchestrator'), true);
  assert.equal(modelMatchesCurrent('Orchestrator (Neon)', 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), true);
  assert.equal(formatModelLabel('gemini-pro-orchestrator'), 'Orchestrator (Carbon)');
  assert.equal(formatModelLabel('gemini-pro-orchestrator-neon'), 'Orchestrator (Neon)');
  assert.equal(formatModelLabel('gemini-pro-orchestrator-argon'), 'Orchestrator (Argon)');
  assert.equal(formatModelLabel('gemini-pro-orchestrator-g1-pro'), 'Orchestrator (Argon)');
  assert.equal(formatModelLabel('gemini-pro-orchestrator-hydrogen'), 'Orchestrator (Hydrogen)');
  assert.equal(formatModelLabel('gemini-4-neon-high'), 'gemini-4-neon-high');
  assert.equal(extractEffortFromModel('gemini-4-neon-xhigh'), 'xhigh');
  assert.equal(extractEffortFromModel('Gemini 4 Argon (Medium)'), 'medium');
  assert.deepEqual(
    resolveVariantByDisplayName(catalog, 'Gemini 4 Argon (Medium)'),
    {modelId: 'gemini-4-argon-medium', baseId: 'gemini-4-argon', name: 'Gemini 4 Argon (Medium)', effort: 'medium'},
  );
});

test('injectable live terminal switches model and effort via native slash commands without touching ACP', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tui-model-'));
  try {
    const binDir = path.join(home, 'bin');
    const commandLog = path.join(home, 'tmux.jsonl');
    const settingsFile = path.join(home, 'settings.json');
    fs.mkdirSync(binDir, {recursive: true});
    fs.writeFileSync(settingsFile, JSON.stringify({model: 'Gemini 4 Neon (High)'}));
    fs.writeFileSync(
      path.join(binDir, 'agy'),
      `#!${process.execPath}\nconsole.log(${JSON.stringify(SAMPLE_MODELS_OUTPUT)});\n`,
      {mode: 0o755},
    );
    fs.writeFileSync(
      path.join(binDir, 'tmux'),
      `#!${process.execPath}\n` +
        `import fs from 'node:fs';\n` +
        `const args = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n');\n` +
        `const litIdx = args.indexOf('-l');\n` +
        `if (litIdx >= 0) {\n` +
        `  const text = args[litIdx + 1] || '';\n` +
        `  const map = {'/model gemini-4-argon': 'Gemini 4 Argon (Medium)', '/model claude-opus-5-5': 'Claude Opus 5.5 (Medium)', '/effort high': 'Claude Opus 5.5 (High)', '/model gemini-pro-orchestrator-neon': 'Orchestrator (Neon)', '/model gemini-pro-orchestrator': 'Orchestrator (Carbon)'};\n` +
        `  if (map[text]) fs.writeFileSync(${JSON.stringify(settingsFile)}, JSON.stringify({model: map[text]}));\n` +
        `}\n`,
      {mode: 0o755},
    );
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({agyDataDir: home, agyBin: path.join(binDir, 'agy'), tabTitleEnabled: false}),
    );
    fs.writeFileSync(path.join(home, 'naming.json'), JSON.stringify({enabled: false, model: '', source: 'off'}));

    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const {handleCommand, handleHookEvent, handleCardCallback, buildLsCard, acp} = await import('./daemon/daemon.mjs');
      acp.start = async () => { throw new Error('must not start ACP for live terminal model switch'); };
      acp.call = async () => { throw new Error('must not call ACP for live terminal model switch'); };

      await handleHookEvent({
        conversationId: 'tui-model-1',
        hookEventName: 'SessionStart',
        cwd: ${JSON.stringify(home)},
        modelName: 'gemini-4-neon-high',
        pid: process.pid,
        loc: {tmuxPane: '%99'},
      });
      buildLsCard([{sessionId: 'tui-model-1', label: () => '终端测试'}]);
      await handleCommand('select 1');
      await handleCommand('name 终端测试');

      const card = await handleCommand('模型');
      assert.equal(card.card.card_type, 'vote_interaction');
      assert.equal(card.card.options.length, 10);
      assert.equal(card.card.options[0].text, 'Gemini 4 Neon · ← 当前');

      const argonOpt = card.card.options.find((o) => o.text.startsWith('Gemini 4 Argon'));
      const switched = await handleCardCallback({taskId: card.card.task_id, optionId: argonOpt.id});
      assert.equal(switched.card.main_title.title, '💡 切换模型');
      assert.equal(switched.card.emphasis_content.title, 'Gemini 4 Argon');
      assert.ok(switched.card.horizontal_content_list.some((f) => f.keyname === '模型' && f.value === 'gemini-4-argon-medium'));

      const direct = await handleCommand('模型 opus');
      assert.equal(direct.card.main_title.title, '💡 切换模型');
      assert.equal(direct.card.emphasis_content.title, 'Claude Opus 5.5');

      const thinkCard = await handleCommand('思考强度');
      assert.equal(thinkCard.card.card_type, 'vote_interaction');
      assert.deepEqual(thinkCard.card.options.map((o) => o.text), ['low · 低', 'medium · 中 · ← 当前', 'high · 高']);

      const thinkDone = await handleCommand('思考强度 高');
      assert.equal(thinkDone.card.main_title.title, '🧠 切换思考强度');
      assert.equal(thinkDone.card.emphasis_content.title, 'high · 高');

      // Switch to Orchestrator (Neon): only Neon is marked current (Carbon must not collide on prefix), display uses readable name and clears stale thoughtLevel
      const orchNeon = await handleCommand('模型 orchestrator-neon');
      assert.equal(orchNeon.card.main_title.title, '💡 切换模型');
      assert.ok(orchNeon.card.horizontal_content_list.some((f) => f.keyname === '模型' && f.value === 'Orchestrator (Neon)'));
      const orchCard = await handleCommand('模型 orchestrator');
      assert.deepEqual(
        orchCard.card.options.filter((o) => o.text.includes('← 当前')).map((o) => o.text),
        ['Orchestrator (Neon) · ← 当前'],
      );
      const carbonOpt = orchCard.card.options.find((o) => o.text.startsWith('Orchestrator (Carbon)'));
      const orchCarbon = await handleCardCallback({taskId: orchCard.card.task_id, optionId: carbonOpt.id});
      assert.ok(orchCarbon.card.horizontal_content_list.some((f) => f.keyname === '模型' && f.value === 'Orchestrator (Carbon)'));
      const orchStatus = await handleCommand('状态');
      assert.match(orchStatus, /模型：Orchestrator \\(Carbon\\)(?!\\s*·)/);

      const modeNotice = await handleCommand('模式');
      assert.match(modeNotice, /Shift\\+Tab/);

      await handleHookEvent({conversationId: 'tui-model-1', hookEventName: 'PreInvocation', cwd: ${JSON.stringify(home)}, pid: process.pid, loc: {tmuxPane: '%99'}});
      const busyReply = await handleCommand('模型');
      assert.match(busyReply, /正在执行任务/);

      const cmds = fs.readFileSync(${JSON.stringify(commandLog)}, 'utf8').trim().split('\\n').map(JSON.parse);
      const injected = cmds.filter((c) => c.includes('-l')).map((c) => c[c.indexOf('-l') + 1]);
      assert.deepEqual(injected, ['/model gemini-4-argon', '/model claude-opus-5-5', '/effort high', '/model gemini-pro-orchestrator-neon', '/model gemini-pro-orchestrator']);
    `;

    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PATH: binDir + path.delimiter + process.env.PATH,
        AGY_REMOTE_HOME: home,
        AGY_REMOTE_NO_LISTEN: '1',
      },
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('background model card and ACP session survive daemon restart, and expired model card hints model command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-restart-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: home, tabTitleEnabled: false}));
    fs.writeFileSync(path.join(home, 'naming.json'), JSON.stringify({enabled: false, model: '', source: 'off'}));

    const env = {...process.env, AGY_REMOTE_HOME: home, AGY_REMOTE_NO_LISTEN: '1'};
    const cwd = path.resolve(import.meta.dirname, '..');

    const step1 = `
      const {handleCommand, acp} = await import('./daemon/daemon.mjs');
      const configs = [
        {id: 'model', currentValue: 'gemini-4-neon', options: [{value: 'gemini-4-neon', name: 'Gemini 4 Neon'}, {value: 'gemini-4-argon', name: 'Gemini 4 Argon'}]},
        {id: 'thought_level', currentValue: 'high', options: [{value: 'low', name: 'Low'}, {value: 'high', name: 'High'}]},
      ];
      acp.start = async () => ({});
      acp.call = async (method) => {
        if (method === 'session/new') return {sessionId: 'bg-survive-1', configOptions: configs};
        throw new Error('unexpected ' + method);
      };
      await handleCommand('nb ' + ${JSON.stringify(home)});
      const card = await handleCommand('模型');
      process.stdout.write(JSON.stringify({taskId: card.card.task_id, optionId: card.card.options[1].id}));
    `;
    const out1 = execFileSync(process.execPath, ['--input-type=module', '-e', step1], {cwd, env, encoding: 'utf8'});
    const picked = JSON.parse(out1);

    const step2 = `
      import assert from 'node:assert/strict';
      const {handleCommand, handleCardCallback, acp} = await import('./daemon/daemon.mjs');
      const calls = [];
      let configs = [
        {id: 'model', currentValue: 'gemini-4-neon', options: [{value: 'gemini-4-neon', name: 'Gemini 4 Neon'}, {value: 'gemini-4-argon', name: 'Gemini 4 Argon'}]},
      ];
      acp.start = async () => ({});
      acp.call = async (method, params) => {
        calls.push({method, params});
        if (method === 'session/load') return {sessionId: params.sessionId, configOptions: configs};
        if (method === 'session/set_config_option') {
          configs = [{...configs[0], currentValue: params.value}];
          return {configOptions: configs};
        }
        throw new Error('unexpected ' + method);
      };

      const status = await handleCommand('状态');
      assert.match(status, /后台会话/);

      const done = await handleCardCallback(${JSON.stringify(picked)});
      assert.equal(done.card.main_title.title, '💡 切换模型');
      assert.equal(done.card.emphasis_content.title, 'Gemini 4 Argon');
      assert.deepEqual(calls.map((c) => c.method), ['session/load', 'session/set_config_option']);
      assert.equal(calls[1].params.value, 'gemini-4-argon');

      const replay = await handleCardCallback(${JSON.stringify(picked)});
      assert.match(replay, /已经提交过/);
      assert.match(replay, /模型/);

      const expired = await handleCardCallback({taskId: 'task_model_123456', optionId: 'pb_missing'});
      assert.match(expired, /卡片已失效/);
      assert.match(expired, /发送 \`模型\` 重新选择/);

      // ACP failure returns actionable message instead of throwing
      acp.call = async (method) => {
        if (method === 'session/set_config_option') throw new Error('quota exceeded');
        return {};
      };
      const failCard = await handleCommand('模型');
      const failed = await handleCardCallback({taskId: failCard.card.task_id, optionId: failCard.card.options[0].id});
      assert.match(failed, /切换模型失败/);
      assert.match(failed, /quota exceeded/);
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', step2], {cwd, env, stdio: 'pipe'});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
