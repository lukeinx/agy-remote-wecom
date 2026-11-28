import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {
  parseAgyUsageOutput,
  formatUsageBody,
  formatGroupModels,
  groupMatchesModel,
  formatResetLabel,
  formatResetDuration,
  formatLocalResetClock,
} from '../daemon/usage.mjs';

const SAMPLE_USAGE_JSON = {
  conversation_id: '',
  status: 'SUCCESS',
  response: [
    'Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-26T00:47:50Z',
    'Gemini Models\tFive Hour Limit Remaining\t91%\t2026-11-19T05:47:50Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-26T01:01:06Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-19T06:01:06Z',
    'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t93%\t2026-11-26T00:33:12Z',
  ].join('\n'),
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.',
              window: 'weekly',
              remaining_fraction: 0.9661974906921387,
              reset_time: '2026-11-26T00:47:50Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              description: 'You have used some of your 5-hour limit, it will fully refresh in 4 hours, 46 minutes.',
              window: '5h',
              remaining_fraction: 0.9066911935806274,
              reset_time: '2026-11-19T05:47:50Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-11-26T01:01:06Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-11-19T06:01:06Z',
            },
          ],
        },
        {
          name: 'Gemini 4 Argon',
          description: 'For paid Pro plans, Argon quota is separate. Higher Argon quota is available on Ultra plans.',
          buckets: [
            {
              id: 'gemini-argon-wtu-weekly',
              name: 'Gemini 4 Argon Weekly Limit',
              description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.',
              window: 'weekly',
              remaining_fraction: 0.9316368103027344,
              reset_time: '2026-11-26T00:33:12Z',
            },
          ],
        },
      ],
    },
  },
};

test('parseAgyUsageOutput parses structured groups, sorts 5h before weekly, and handles ANSI/TSV fallback', () => {
  const parsed = parseAgyUsageOutput(`\u001b[36mFetching...\u001b[0m\n${JSON.stringify(SAMPLE_USAGE_JSON)}`);
  assert.equal(parsed.groups.length, 3);
  assert.equal(parsed.groups[0].name, 'Gemini Models');
  assert.deepEqual(parsed.groups[0].models, ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Orchestrator (Neon)', 'Gemini 3.8 Flash']);
  assert.deepEqual(parsed.groups[0].buckets.map((b) => b.window), ['5h', 'weekly']);
  assert.deepEqual(parsed.groups[1].models, ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B']);
  assert.deepEqual(parsed.groups[2].models, []);

  const fallback = parseAgyUsageOutput(JSON.stringify({
    status: 'SUCCESS',
    response: SAMPLE_USAGE_JSON.response,
  }));
  assert.equal(fallback.groups.length, 3);
  assert.deepEqual(fallback.groups[0].buckets.map((b) => b.window), ['5h', 'weekly']);
  assert.equal(fallback.groups[0].buckets[0].remainingFraction, 0.91);

  assert.throws(
    () => parseAgyUsageOutput(JSON.stringify({status: 'ERROR', error: 'auth expired'})),
    /auth expired/,
  );
  assert.throws(() => parseAgyUsageOutput('not json at all'), /无法解析/);
});

test('formatUsageBody renders grouped markdown tables with compacted models and current tag', () => {
  const now = Date.parse('2026-11-19T01:01:00Z');
  const {groups} = parseAgyUsageOutput(JSON.stringify(SAMPLE_USAGE_JSON));
  const body = formatUsageBody(groups, {now, currentModel: 'gemini-4-neon-medium'});

  const abs5h = formatLocalResetClock(new Date('2026-11-19T05:47:50Z'), new Date(now));
  const absWk = formatLocalResetClock(new Date('2026-11-26T00:47:50Z'), new Date(now));
  const absArgon = formatLocalResetClock(new Date('2026-11-26T00:33:12Z'), new Date(now));

  assert.equal(
    body,
    [
      '**Gemini Models** `当前`',
      '',
      '| 窗口 | 剩余 | 重置 |',
      '|---|---|---|',
      `| 5小时 | **91%** | 4h46m · ${abs5h} |`,
      `| 每周 | **97%** | 6天23h · ${absWk} |`,
      '',
      '> Gemini 4 (Neon / Hydrogen) · Orchestrator (Neon) · Gemini 3.8 Flash',
      '',
      '**Claude and GPT models**',
      '',
      '| 窗口 | 剩余 | 重置 |',
      '|---|---|---|',
      '| 5小时 | **100%** | — |',
      '| 每周 | **100%** | — |',
      '',
      '> Claude Opus 5.5 · Claude Sonnet 5.5 · GPT-OSS 120B',
      '',
      '**Gemini 4 Argon**',
      '',
      '| 窗口 | 剩余 | 重置 |',
      '|---|---|---|',
      `| 每周 | **93%** | 6天23h · ${absArgon} |`,
    ].join('\n'),
  );

  assert.equal(
    formatGroupModels([
      'Gemini 4 Neon',
      'Gemini 4 Carbon',
      'Gemini 4 Argon',
      'Gemini 4 Hydrogen',
      'Orchestrator (Neon)',
      'Orchestrator (Carbon)',
      'Orchestrator (Argon)',
      'Gemini 3.8 Flash',
    ]),
    'Gemini 4 (Neon / Carbon / Argon / Hydrogen) · Orchestrator (Neon / Carbon / Argon) · Gemini 3.8 Flash',
  );
  assert.equal(groupMatchesModel(groups[0], 'Gemini 4 Neon (Medium)'), true);
  assert.equal(groupMatchesModel(groups[0], 'gemini-pro-orchestrator-neon'), true);
  assert.equal(groupMatchesModel(groups[0], 'Orchestrator (Neon)'), true);
  assert.equal(groupMatchesModel(groups[1], 'claude-opus-5.5-high'), true);
  assert.equal(groupMatchesModel(groups[1], 'gemini-pro-orchestrator-neon'), false);
  assert.equal(groupMatchesModel(groups[2], 'gemini-4-argon'), true);
  assert.equal(groupMatchesModel(groups[2], 'gemini-pro-orchestrator-argon'), false);
  assert.equal(groupMatchesModel(groups[1], 'gemini-4-neon'), false);

  const allOrchGroup = {
    ...groups[0],
    models: ['Gemini 4 Neon', 'Orchestrator (Neon)', 'Orchestrator (Carbon)', 'Orchestrator (Argon)'],
  };
  assert.equal(groupMatchesModel(allOrchGroup, 'gemini-pro-orchestrator'), true);
  assert.equal(groupMatchesModel(allOrchGroup, 'gemini-pro-orchestrator-argon'), true);
  assert.equal(groupMatchesModel(allOrchGroup, 'gemini-pro-orchestrator-g1-pro'), true);

  // Even if server description omits Carbon variant, formatUsageBody falls back to Gemini Models group (never 3p or Argon-only)
  const orchCarbonBody = formatUsageBody(groups, {now, currentModel: 'gemini-pro-orchestrator'});
  assert.match(orchCarbonBody, /\*\*Gemini Models\*\* `当前`/);
  assert.doesNotMatch(orchCarbonBody, /\*\*Claude and GPT models\*\* `当前`/);
  assert.doesNotMatch(orchCarbonBody, /\*\*Gemini 4 Argon\*\* `当前`/);

  assert.equal(formatResetDuration(45 * 60_000), '45m');
  assert.equal(formatResetDuration(30_000), '1分钟内');
  assert.equal(formatResetLabel({remainingFraction: 0.5, resetTime: '2026-11-19T01:01:30Z'}, now), '1分钟内');
  assert.equal(formatResetLabel({remainingFraction: 0.5, resetTime: '2026-11-19T01:00:00Z'}, now), '即将重置');
});

test('usage command works across daemon and CLI without active session, ACP, or consuming attachments', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-'));
  try {
    const binDir = path.join(home, 'bin');
    const agyPath = path.join(binDir, 'agy');
    const modeFile = path.join(home, 'mode.txt');
    const envLog = path.join(home, 'env.json');
    fs.mkdirSync(binDir, {recursive: true});
    fs.writeFileSync(modeFile, 'ok');
    fs.writeFileSync(
      agyPath,
      `#!${process.execPath}\n` +
        `import fs from 'node:fs';\n` +
        `fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({args: process.argv.slice(2), acpFlag: process.env.AGY_REMOTE_ACP || ''}));\n` +
        `const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();\n` +
        `if (mode === 'fail') { console.error('network unreachable'); process.exit(1); }\n` +
        `if (mode === 'empty') { console.log(JSON.stringify({status: 'SUCCESS', command: {name: 'usage', data: {groups: []}}})); process.exit(0); }\n` +
        `console.log(${JSON.stringify(JSON.stringify(SAMPLE_USAGE_JSON))});\n`,
      {mode: 0o755},
    );
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({agyDataDir: home, agyBin: agyPath, tabTitleEnabled: false}),
    );

    const cwd = path.resolve(import.meta.dirname, '..');
    const env = {...process.env, AGY_REMOTE_HOME: home, AGY_REMOTE_NO_LISTEN: '1'};

    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const {parseCmd, handleCommand, acp} = await import('./daemon/daemon.mjs');
      acp.start = async () => { throw new Error('usage must not start ACP'); };
      acp.call = async () => { throw new Error('usage must not call ACP'); };

      for (const alias of ['usage', 'USAGE', 'quota', '用量', '查询用量', '查看用量', '额度', '查询额度', '查看额度']) {
        assert.deepEqual(parseCmd(alias), {cmd: 'usage', rest: ''});
      }
      for (const alias of ['usage refresh', 'quota refresh', '用量 刷新', '额度 刷新']) {
        assert.deepEqual(parseCmd(alias), {cmd: 'usage', rest: 'refresh'});
      }
      assert.equal(parseCmd('用量统计怎么做'), null);
      assert.equal(parseCmd('usage of hooks'), null);

      const ack = {media: false};
      const reply = await handleCommand('用量', [{path: '/tmp/a.png'}], ack);
      assert.equal(ack.media, false);
      assert.match(reply, /^### 📊 模型用量\\n\\n---\\n\\n/);
      assert.match(reply, /\\*\\*Gemini Models\\*\\*/);
      assert.match(reply, /\\*\\*Claude and GPT models\\*\\*/);
      assert.match(reply, /\\*\\*Gemini 4 Argon\\*\\*/);
      assert.match(reply, /\\| 5小时 \\| \\*\\*91%\\*\\* \\|/);
      assert.match(reply, /\\| 每周 \\| \\*\\*97%\\*\\* \\|/);
      assert.match(reply, /发送 \`模型\` 切换模型/);

      const meta = JSON.parse(fs.readFileSync(${JSON.stringify(envLog)}, 'utf8'));
      assert.equal(meta.acpFlag, '1');
      assert.equal(meta.args[0], '-p');
      assert.equal(meta.args[1], '/usage');
      assert.equal(meta.args[2], '--output-format');
      assert.equal(meta.args[3], 'json');

      // Within cache TTL, plain usage hits cache; refresh bypasses cache.
      fs.writeFileSync(${JSON.stringify(modeFile)}, 'empty');
      const cachedReply = await handleCommand('usage');
      assert.match(cachedReply, /^### 📊 模型用量/);
      const emptyReply = await handleCommand('usage refresh');
      assert.match(emptyReply, /^### 📊 暂无用量数据/);

      fs.writeFileSync(${JSON.stringify(modeFile)}, 'fail');
      const failReply = await handleCommand('quota');
      assert.match(failReply, /^### ⚠️ 查询用量失败/);
      assert.match(failReply, /network unreachable/);
    `;

    execFileSync(process.execPath, ['--input-type=module', '-e', script], {cwd, env, stdio: 'pipe'});

    fs.writeFileSync(modeFile, 'ok');
    const cliOut = execFileSync(process.execPath, ['bin/remote.mjs', 'usage'], {cwd, env, encoding: 'utf8'});
    assert.match(cliOut, /^### 📊 模型用量/);
    assert.match(cliOut, /\*\*Gemini Models\*\*/);
    const slashOut = execFileSync(process.execPath, ['bin/remote.mjs', '__slash'], {
      cwd,
      env: {...env, AGY_SLASH_ARGS: 'usage'},
      encoding: 'utf8',
    });
    assert.match(slashOut, /^### 📊 模型用量/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
