import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {AcpClient, configOf} from '../daemon/acp.mjs';
import {userText, turns, lastAnswer, artifacts} from '../daemon/transcript.mjs';
import {injectKind} from '../daemon/terminals.mjs';
import {splitMarkdown, disabledSelectionCard, selectedIds, messageParts} from '../daemon/wecom.mjs';

test('transcript parsing extracts user request, turns, and artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tr-'));
  const artDir = path.join(tmp, 'brain');
  fs.mkdirSync(artDir, {recursive: true});
  const reportFile = path.join(artDir, 'report.md');
  fs.writeFileSync(reportFile, '# Report\n');

  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n帮我写个报告\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{name: 'write_file', args: {Path: reportFile, Content: '# Report'}}],
    },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      content: `已完成报告：[report.md](file://${reportFile})`,
    },
  ];

  assert.equal(userText(steps[0].content), '帮我写个报告');
  const allTurns = turns(steps);
  assert.equal(allTurns.length, 1);
  assert.equal(allTurns[0].question, '帮我写个报告');
  assert.match(allTurns[0].answer, /已完成报告/);
  assert.equal(lastAnswer(steps).question, '帮我写个报告');

  const arts = artifacts(steps, {artifactDir: artDir, home: tmp});
  assert.equal(arts.length, 1);
  assert.equal(arts[0].name, 'report.md');
  fs.rmSync(tmp, {recursive: true, force: true});
});

test('AcpClient handles initialize, session/update, and session/request_permission', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fakeProc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill() { this.emit('exit', 0, null); },
  });

  stdin.setEncoding('utf8');
  let inBuf = '';
  stdin.on('data', (chunk) => {
    inBuf += chunk;
    let i;
    while ((i = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, i).trim();
      inBuf = inBuf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        stdout.write(JSON.stringify({jsonrpc: '2.0', id: msg.id, result: {protocolVersion: 1}}) + '\n');
      } else if (msg.method === 'session/new') {
        stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-1',
            configOptions: [{id: 'model', currentValue: 'gemini-4-argon', options: [{value: 'gemini-4-argon', name: 'Argon'}]}],
          },
        }) + '\n');
        // Push an update and a permission request
        stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {sessionId: 'sess-1', update: {sessionUpdate: 'session_info_update', title: '测试标题'}},
        }) + '\n');
        stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'session/request_permission',
          params: {sessionId: 'sess-1', options: [{optionId: 'allow_once', kind: 'allow_once', name: 'Allow once'}]},
        }) + '\n');
      }
    }
  });

  const client = new AcpClient({spawnFn: () => fakeProc});
  const updates = [];
  let permOutcome = null;
  stdin.on('data', (chunk) => {
    for (const l of chunk.split('\n').filter(Boolean)) {
      const m = JSON.parse(l);
      if (m.id === 99 && m.result) permOutcome = m.result.outcome;
    }
  });
  client.on('update', (sid, u) => updates.push({sid, u}));
  client.on('permission', (params, respond) => {
    respond({outcome: 'selected', optionId: params.options[0].optionId});
  });

  await client.start();
  const s = await client.call('session/new', {cwd: '/tmp', mcpServers: []});
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(configOf(s.configOptions, 'model').currentValue, 'gemini-4-argon');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].u.title, '测试标题');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(permOutcome, {outcome: 'selected', optionId: 'allow_once'});
  client.stop();
});

test('terminal injectKind detection', () => {
  assert.equal(injectKind({tmuxPane: '%1'}), 'tmux');
  assert.equal(injectKind({weztermPane: '2'}), 'wezterm');
  assert.equal(injectKind({kittyWindow: '3'}), 'kitty');
  assert.equal(injectKind({tty: '/dev/ttys001', termProgram: 'ghostty'}), 'ghostty');
  assert.equal(injectKind({tty: '/dev/ttys001', termProgram: 'ghostty', cmuxSurface: 's1'}), 'cmux');
  assert.equal(injectKind({tty: '/dev/ttys002', termProgram: 'iTerm.app'}), 'iterm');
  assert.equal(injectKind({tty: '/dev/ttys003', termProgram: 'Apple_Terminal'}), null);
});

test('wecom helpers: splitMarkdown, messageParts, disabledSelectionCard', () => {
  const parts = splitMarkdown('a'.repeat(25000), 20000);
  assert.equal(parts.length, 2);
  const mp = messageParts({
    msgtype: 'mixed',
    mixed: {msg_item: [{msgtype: 'text', text: {content: 'hello'}}, {msgtype: 'image', image: {url: 'https://a/b'}}]},
  });
  assert.equal(mp.text, 'hello');
  assert.equal(mp.media.length, 1);
  const locked = disabledSelectionCard({template_card_event: {task_id: 't1', selected_items: [{option_ids: ['o1']}]}}, null);
  assert.equal(locked.checkbox.disable, true);
  assert.deepEqual(selectedIds({template_card_event: {selected_items: [{option_ids: ['o1']}]}}), ['o1']);
});
