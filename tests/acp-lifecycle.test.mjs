import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {AcpClient} from '../daemon/acp.mjs';

function processStub({initialize = true, failInit = false} = {}) {
  const messages = [];
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), messages,
    kill() { this.emit('exit', 0, 'SIGTERM'); },
  });
  proc.stdin.on('data', (data) => {
    for (const line of String(data).trim().split('\n')) {
      const msg = JSON.parse(line);
      messages.push(msg);
      if (msg.method === 'initialize' && initialize) proc.stdout.write(JSON.stringify({id: msg.id,
        ...(failInit ? {error: {message: 'init failed'}} : {result: {protocolVersion: 1}})}) + '\n');
    }
  });
  return proc;
}

test('spawn error rejects immediately and retry creates a fresh process', async () => {
  const broken = processStub({initialize: false});
  const healthy = processStub();
  let n = 0;
  const client = new AcpClient({spawnFn: () => ++n === 1 ? broken : healthy});
  const first = client.start();
  broken.emit('error', new Error('ENOENT'));
  await assert.rejects(first, /ENOENT/);
  assert.equal(client.pending.size, 0);
  assert.equal(client.alive, false);
  assert.equal((await client.start()).protocolVersion, 1);
  broken.emit('exit', 1); // old child event must not disconnect the replacement
  assert.equal(client.proc, healthy);
  client.stop();
});

test('initialize failure terminates child and does not keep a rejected ready promise', async () => {
  const broken = processStub({failInit: true});
  const healthy = processStub();
  let n = 0;
  const client = new AcpClient({spawnFn: () => ++n === 1 ? broken : healthy});
  await assert.rejects(client.start(), /init failed/);
  assert.equal(client.pending.size, 0);
  await client.start();
  assert.equal(client.proc, healthy);
  client.stop();
});

test('process replacement discards partial input and stale permission answers', async () => {
  const first = processStub(), next = processStub();
  let n = 0, respond;
  const client = new AcpClient({spawnFn: () => ++n === 1 ? first : next});
  client.on('permission', (_, reply) => {respond = reply;});
  await client.start();
  first.stdout.write(JSON.stringify({id: 99, method: 'session/request_permission', params: {}}) + '\n');
  first.stdout.write('{"partial":');
  const pending = client.call('session/prompt', {}, 0);
  first.emit('exit', 1);
  await assert.rejects(pending, /已退出/);
  await client.start();
  respond({outcome: 'selected', optionId: 'yes'});
  assert.equal(next.messages.some((m) => m.id === 99), false);
  assert.equal(client.buf, '');
  client.notify('session/cancel', {sessionId: 's'});
  const notification = next.messages.at(-1);
  assert.equal(notification.method, 'session/cancel');
  assert.equal(notification.id, undefined);
  assert.equal(client.pending.size, 0);
  client.stop();
});
