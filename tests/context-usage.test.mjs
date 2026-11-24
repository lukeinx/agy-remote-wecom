import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inferModelContextWindow} from '../daemon/models.mjs';
import {readContextUsage, transcriptCompactFile, transcriptFile} from '../daemon/transcript.mjs';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function runDaemonCase(home, agyDataDir, code) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGY_REMOTE_HOME: home,
      AGY_REMOTE_NO_LISTEN: '1',
      AGY_TEST_DATA_DIR: agyDataDir,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('inferModelContextWindow matches agy ACP model window sizes and leaves unknown models as 0', () => {
  assert.equal(inferModelContextWindow('gemini-4-neon-high'), 1_048_576);
  assert.equal(inferModelContextWindow('Gemini 4 Neon (High)'), 1_048_576);
  assert.equal(inferModelContextWindow('gemini-pro-orchestrator-neon'), 1_048_576);
  assert.equal(inferModelContextWindow('Orchestrator (Argon)'), 1_048_576);
  assert.equal(inferModelContextWindow('claude-opus-5-5-high'), 1_000_000);
  assert.equal(inferModelContextWindow('Claude Sonnet 5.5 (Medium)'), 1_000_000);
  assert.equal(inferModelContextWindow('claude-opus-4-6-thinking'), 1_000_000);
  assert.equal(inferModelContextWindow('claude-3-7-sonnet'), 200_000);
  assert.equal(inferModelContextWindow('gpt-oss-120b-medium'), 131_072);
  assert.equal(inferModelContextWindow('GPT-OSS 120B (Medium)'), 131_072);
  assert.equal(inferModelContextWindow('test-model'), 0);
  assert.equal(inferModelContextWindow('auto'), 0);
  assert.equal(inferModelContextWindow(''), 0);
});

test('readContextUsage sums input + cache_read + output, handles CHECKPOINT and legacy transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctx-usage-'));
  try {
    const sid = 'sess-usage-1';
    const compact = transcriptCompactFile(dir, sid);
    const cache = {};

    writeJsonl(compact, [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 10000, cache_read_tokens: 0, output_tokens: 500},
      {step_index: 2, type: 'GENERIC'},
      {step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 3136, cache_read_tokens: 63400, output_tokens: 658},
    ]);
    const r1 = readContextUsage(dir, sid, {cache});
    assert.equal(r1.found, true);
    assert.equal(r1.usedTokens, 3136 + 63400 + 658);
    assert.equal(r1.model, 'gemini-4-neon-high');
    assert.equal(r1.afterCheckpoint, false);

    // CHECKPOINT invalidates pre-compaction context until next PLANNER_RESPONSE arrives.
    writeJsonl(compact, [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-argon-medium', input_tokens: 5000, cache_read_tokens: 250000, output_tokens: 800},
      {step_index: 2, type: 'CHECKPOINT', input_tokens: 3879, cache_read_tokens: 253576, output_tokens: 2277},
    ]);
    const r2 = readContextUsage(dir, sid, {cache});
    assert.equal(r2.afterCheckpoint, true);
    assert.equal(r2.usedTokens, null);
    assert.equal(r2.model, 'gemini-4-argon-medium');

    // Once a post-checkpoint PLANNER_RESPONSE lands, exact compacted usage is reported.
    writeJsonl(compact, [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>'},
      {step_index: 2, type: 'CHECKPOINT', input_tokens: 3879, cache_read_tokens: 253576, output_tokens: 2277},
      {step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-argon-medium', input_tokens: 13661, cache_read_tokens: 0, output_tokens: 144},
    ]);
    const r3 = readContextUsage(dir, sid, {cache});
    assert.equal(r3.afterCheckpoint, false);
    assert.equal(r3.usedTokens, 13805);

    // Fallback to transcript_full.jsonl and never report 0% when turns lack token fields.
    const sidLegacy = 'sess-legacy-1';
    writeJsonl(transcriptFile(dir, sidLegacy), [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>old</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', content: 'reply without tokens'},
    ]);
    const r4 = readContextUsage(dir, sidLegacy);
    assert.equal(r4.found, true);
    assert.equal(r4.hasTurns, true);
    assert.equal(r4.usedTokens, null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('TUI status, Stop footer, history select race, empty session and daemon restart all report accurate context', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctx-home-'));
  const agyData = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctx-data-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({agyDataDir: agyData, tabTitleEnabled: false}));

  try {
    const tuiSid = 'tui-ctx-1';
    const histSid = 'hist-ctx-1';
    const acpSid = 'acp-ctx-1';

    writeJsonl(transcriptCompactFile(agyData, tuiSid), [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>检查状态</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 10000, cache_read_tokens: 94858, output_tokens: 0, content: '已检查完毕'},
    ]);

    writeJsonl(transcriptCompactFile(agyData, histSid), [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>历史对话</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-opus-5-5-high', input_tokens: 20000, cache_read_tokens: 130000, output_tokens: 0, content: 'done'},
    ]);

    writeJsonl(transcriptCompactFile(agyData, acpSid), [
      {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>后台任务</USER_REQUEST>'},
      {step_index: 1, type: 'PLANNER_RESPONSE', model: 'gpt-oss-120b-medium', input_tokens: 6554, cache_read_tokens: 6554, output_tokens: 0, content: 'ok'},
    ]);

    const res1 = runDaemonCase(home, agyData, `
      import {handleCommand, handleCardCallback, handleHookEvent, acp, transport} from './daemon/daemon.mjs';
      import {writeNamingPref} from './daemon/naming.mjs';
      writeNamingPref({enabled: false, model: '', source: 'off'});
      const pushed = [];
      transport.send = async (msg) => { pushed.push(msg); };
      acp.start = async () => ({});
      acp.call = async (method, params) => {
        if (method === 'session/new') {
          return {
            sessionId: 'empty-acp-1',
            models: {currentModelId: 'gemini-4-neon-high'},
            configOptions: [
              {id: 'model', currentValue: 'gemini-4-neon', options: [{value: 'gemini-4-neon', name: 'Gemini 4 Neon'}, {value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B'}]},
            ],
          };
        }
        if (method === 'session/list') {
          return {sessions: [{sessionId: '${histSid}', cwd: '/tmp', title: '历史会话测试', updatedAt: new Date().toISOString()}]};
        }
        if (method === 'session/load') {
          // Deliberately do NOT emit usage_update synchronously to test the race condition.
          return {
            sessionId: params.sessionId,
            models: {currentModelId: 'claude-opus-5-5-high'},
            configOptions: [
              {id: 'model', currentValue: 'claude-opus-5-5', options: [{value: 'claude-opus-5-5', name: 'Claude Opus 5.5'}]},
            ],
          };
        }
        if (method === 'session/set_config_option') {
          return {
            configOptions: [
              {id: 'model', currentValue: params.value, options: [{value: 'gemini-4-neon', name: 'Gemini 4 Neon'}, {value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B'}]},
            ],
          };
        }
        return {};
      };

      // 1) TUI session via hooks (no ACP) -> status & Stop footer should both show 10.0% / 1.0m
      await handleHookEvent({
        hookEventName: 'SessionStart',
        conversationId: '${tuiSid}',
        cwd: '/tmp',
        modelName: 'gemini-4-neon-high',
        pid: process.pid,
      });
      // Select TUI session as current so Stop pushes completion footer to WeCom.
      const lsCard = await handleCommand('ls');
      await handleCardCallback({taskId: lsCard.card.task_id, optionId: lsCard.card.options[0].id});
      await handleHookEvent({
        hookEventName: 'PreInvocation',
        conversationId: '${tuiSid}',
        cwd: '/tmp',
        modelName: 'gemini-4-neon-high',
        lastUserInput: '检查状态',
        pid: process.pid,
      });
      const tuiStatus = await handleCommand('状态');
      await handleHookEvent({
        hookEventName: 'Stop',
        conversationId: '${tuiSid}',
        cwd: '/tmp',
        modelName: 'gemini-4-neon-high',
        pid: process.pid,
      });

      // 2) History session selected before ACP usage_update arrives -> selected card shows 15.0% / 1.0m
      const histCard = await handleCommand('h');
      const histSelected = await handleCardCallback({taskId: histCard.card.task_id, optionId: histCard.card.options[0].id});
      const histCtxFact = histSelected.card.horizontal_content_list.find((f) => f.keyname === '上下文')?.value;

      // 3) Empty new ACP session with known model shows 0.0% / 1.0m, and switches window on model change
      await handleCommand('nb /tmp');
      const emptyStatus = await handleCommand('状态');
      await handleCommand('model gpt-oss');
      const switchedStatus = await handleCommand('状态');

      console.log(JSON.stringify({tuiStatus, stopPushed: pushed, histCtxFact, emptyStatus, switchedStatus}));
    `);

    assert.match(res1.tuiStatus, /上下文：10\.0% \/ 1\.0m/);
    assert.ok(res1.stopPushed.some((m) => typeof m === 'string' && /上下文：10\.0%/.test(m)));
    assert.equal(res1.histCtxFact, '15.0% / 1.0m');
    assert.match(res1.emptyStatus, /上下文：0\.0% \/ 1\.0m/);
    assert.match(res1.switchedStatus, /上下文：0\.0% \/ 131k/);

    // 4) Simulate daemon restart with persisted ACP session lacking cached usage fields (legacy state.json).
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      currentSessionId: acpSid,
      acpSessions: [{
        sessionId: acpSid,
        cwd: '/tmp',
        name: '重启恢复会话',
        firstInput: '后台任务',
        model: 'gpt-oss-120b-medium',
        lastActivity: Date.now(),
        updatedAt: Date.now(),
      }],
    }));

    const res2 = runDaemonCase(home, agyData, `
      import {handleCommand} from './daemon/daemon.mjs';
      const statusAfterRestart = await handleCommand('状态');
      console.log(JSON.stringify({statusAfterRestart}));
    `);

    assert.match(res2.statusAfterRestart, /上下文：10\.0% \/ 131k/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(agyData, {recursive: true, force: true});
  }
});
