// agy ACP 客户端：一个 `agy acp` 子进程承载多个会话（NDJSON JSON-RPC over stdio）。
// 事件：
//   'update'      (sessionId, update)                 session/update 通知
//   'permission'  (params, respond(outcome))          session/request_permission 反向请求
//   'exit'        ({code, signal})                    子进程退出（所有会话失效，daemon 负责重载）
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';

export class AcpClient extends EventEmitter {
  constructor({bin = 'agy', args = ['acp'], env = {}, log = () => {}, spawnFn = spawn} = {}) {
    super();
    this.bin = bin; this.args = args; this.env = env; this.log = log; this.spawnFn = spawnFn;
    this.proc = null; this.seq = 0; this.pending = new Map(); this.buf = '';
    this.ready = null; this.info = null;
  }
  /** 启动并 initialize；重复调用返回同一个 Promise。 */
  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const proc = this.spawnFn(this.bin, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {...process.env, ...this.env, AGY_REMOTE_ACP: '1'},
      });
      this.proc = proc;
      this.buf = '';
      let closed = false;
      const close = (error, code = null, signal = null) => {
        if (closed) return;
        closed = true;
        if (this.proc !== proc) return;
        this.proc = null; this.ready = null; this.info = null; this.buf = '';
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(Object.assign(error, {exited: true}));
        }
        this.pending.clear();
        this.emit('exit', {code, signal});
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (d) => { if (this.proc === proc) this.onData(d); });
      proc.stderr.on('data', (d) => this.log(`acp stderr: ${String(d).trim().slice(0, 300)}`));
      proc.stdin.on('error', (e) => { close(e); try { proc.kill(); } catch {} });
      proc.on('exit', (code, signal) => {
        this.log(`acp exit code=${code} sig=${signal}`);
        close(new Error('agy acp 进程已退出'), code, signal);
      });
      proc.on('error', (e) => close(e));
      try {
        const init = await this.call('initialize', {protocolVersion: 1, clientCapabilities: {}}, 60_000);
        this.info = init;
        return init;
      } catch (e) {
        close(e);
        try { proc.kill(); } catch {}
        throw e;
      }
    })();
    const ready = this.ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return this.ready;
  }
  stop() { try { this.proc?.kill(); } catch {} }
  get alive() { return !!this.proc; }
  write(obj) {
    if (!this.proc) throw new Error('agy acp 未运行');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { this.log(`acp 非 JSON 输出：${line.slice(0, 120)}`); continue; }
      this.dispatch(m);
    }
  }
  dispatch(m) {
    if (m.method && m.id != null) return this.onRequest(m);
    if (m.method) {
      if (m.method === 'session/update') this.emit('update', m.params?.sessionId, m.params?.update || {});
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error.message || 'acp error'), {code: m.error.code, data: m.error.data}));
    else p.resolve(m.result);
  }
  onRequest(m) {
    const proc = this.proc;
    const reply = (result) => { if (this.proc !== proc) return; try { this.write({jsonrpc: '2.0', id: m.id, result}); } catch {} };
    const fail = (code, message) => { try { this.write({jsonrpc: '2.0', id: m.id, error: {code, message}}); } catch {} };
    if (m.method === 'session/request_permission') {
      let done = false;
      const respond = (outcome) => { if (done) return; done = true; reply({outcome}); };
      if (!this.listenerCount('permission')) return respond({outcome: 'cancelled'});
      this.emit('permission', m.params || {}, respond);
      return;
    }
    // 未声明 fs / terminal 能力，其他反向请求一律拒绝。
    fail(-32601, `method not supported: ${m.method}`);
  }
  notify(method, params = {}) {
    this.write({jsonrpc: '2.0', method, params});
  }
  /** timeoutMs = 0 表示不限时（session/prompt 一轮可能跑很久）。 */
  call(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const p = {resolve, reject, timer: null};
      if (timeoutMs > 0) p.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, p);
      try { this.write({jsonrpc: '2.0', id, method, params}); }
      catch (e) { this.pending.delete(id); clearTimeout(p.timer); reject(e); }
    });
  }
}

/** 从 configOptions 中取某个选项 */
export const configOf = (opts, id) => (Array.isArray(opts) ? opts.find((o) => o.id === id) : null);
