// 零依赖终端交互组件（select / input / confirm），支持 raw 键盘导航、Secret 掩码、Esc 取消与可注入流测试。
const ESC = '\x1b';
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_LINE = `${CSI}2K\r`;

export const ANSI = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  cyan: `${CSI}36m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  red: `${CSI}31m`,
};

function style(enabled, code, text) {
  return enabled ? `${code}${text}${ANSI.reset}` : String(text);
}

/** 将 UTF-8 原始字节流拆分为逻辑按键事件（支持方向键、Esc、Ctrl+C、Enter、Backspace 与中文/粘贴文本）。 */
export function parseKeyChunk(chunk) {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const keys = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\x03') { keys.push({name: 'ctrl-c'}); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      keys.push({name: 'enter'});
      continue;
    }
    if (ch === '\x7f' || ch === '\b') { keys.push({name: 'backspace'}); continue; }
    if (ch === '\x15') { keys.push({name: 'clear'}); continue; }
    if (ch === ESC) {
      const next = s[i + 1];
      const third = s[i + 2];
      if (next === '[' || next === 'O') {
        if (third === 'A') { keys.push({name: 'up'}); i += 2; continue; }
        if (third === 'B') { keys.push({name: 'down'}); i += 2; continue; }
        if (third === 'C') { keys.push({name: 'right'}); i += 2; continue; }
        if (third === 'D') { keys.push({name: 'left'}); i += 2; continue; }
        // Skip other CSI sequences (e.g. bracketed paste / PageUp / Delete)
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j += 1;
        i = Math.min(j, s.length - 1);
        continue;
      }
      keys.push({name: 'escape'});
      continue;
    }
    if (ch >= ' ') {
      keys.push({name: 'char', char: ch});
    }
  }
  return keys;
}

function createRenderer(output) {
  let renderedLines = 0;
  return {
    draw(lines) {
      let buf = '';
      if (renderedLines > 0) {
        buf += `${CSI}${renderedLines}A`;
        for (let i = 0; i < renderedLines; i += 1) buf += `${CLEAR_LINE}\n`;
        buf += `${CSI}${renderedLines}A`;
      }
      buf += lines.map((l) => `${CLEAR_LINE}${l}`).join('\n') + '\n';
      output.write(buf);
      renderedLines = lines.length;
    },
    clear() {
      if (renderedLines <= 0) return;
      let buf = `${CSI}${renderedLines}A`;
      for (let i = 0; i < renderedLines; i += 1) buf += `${CLEAR_LINE}\n`;
      buf += `${CSI}${renderedLines}A`;
      output.write(buf);
      renderedLines = 0;
    },
  };
}

function withRawMode(stdin, stdout, run) {
  const isRawSupported = typeof stdin.setRawMode === 'function';
  const prevRaw = isRawSupported ? Boolean(stdin.isRaw) : false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (isRawSupported) stdin.setRawMode(prevRaw); } catch {}
    try { stdin.pause(); } catch {}
    try { stdout.write(SHOW_CURSOR); } catch {}
  };
  try {
    if (isRawSupported) stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);
  } catch {}
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      cleanup();
      fn(val);
    };
    const onKey = run({
      resolve: (v) => finish(resolve, v),
      reject: (e) => finish(reject, e),
    });
    const onData = (chunk) => {
      for (const key of parseKeyChunk(chunk)) {
        if (settled) break;
        if (key.name === 'ctrl-c') {
          finish(resolve, CANCELLED);
          return;
        }
        onKey(key);
      }
    };
    stdin.on('data', onData);
  });
}

export const CANCELLED = Symbol('TUI_CANCELLED');

export function createTui({
  stdin = process.stdin,
  stdout = process.stdout,
  color = Boolean(stdout?.isTTY),
} = {}) {
  const c = (code, text) => style(color, code, text);

  /** 单选列表：返回选中项的 value，按 Esc 返回 null，Ctrl+C 返回 CANCELLED。 */
  async function select({title = '', status = '', notice = null, items = [], initialIndex = 0, backLabel = 'Esc 返回'} = {}) {
    if (!items.length) return null;
    let idx = Math.max(0, Math.min(items.length - 1, initialIndex));
    const renderer = createRenderer(stdout);

    const render = () => {
      const lines = [];
      if (title) {
        lines.push(c(ANSI.bold, title) + (status ? `  ${c(ANSI.dim, status)}` : ''));
      }
      if (notice?.text) {
        const toneCode = notice.tone === 'error' ? ANSI.red : notice.tone === 'warn' ? ANSI.yellow : ANSI.green;
        lines.push(c(toneCode, notice.text));
      }
      lines.push('');
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const selected = i === idx;
        const pointer = selected ? c(ANSI.cyan, '❯') : ' ';
        const label = selected ? c(ANSI.cyan + ANSI.bold, item.label) : item.label;
        const currentTag = item.current ? ` ${c(ANSI.green, '← 当前')}` : '';
        const detail = item.detail ? `  ${c(ANSI.dim, item.detail)}` : '';
        lines.push(`${pointer} ${label}${currentTag}${detail}`);
      }
      lines.push('');
      lines.push(c(ANSI.dim, `↑/↓ 移动 · Enter 确认 · ${backLabel}`));
      renderer.draw(lines);
    };

    const result = await withRawMode(stdin, stdout, ({resolve}) => {
      render();
      return (key) => {
        if (key.name === 'up' || (key.name === 'char' && key.char === 'k')) {
          idx = (idx - 1 + items.length) % items.length;
          render();
          return;
        }
        if (key.name === 'down' || (key.name === 'char' && key.char === 'j')) {
          idx = (idx + 1) % items.length;
          render();
          return;
        }
        if (key.name === 'enter') {
          renderer.clear();
          resolve(items[idx].value);
          return;
        }
        if (key.name === 'escape' || (key.name === 'char' && key.char === 'q')) {
          renderer.clear();
          resolve(null);
        }
      };
    });
    if (result === CANCELLED) renderer.clear();
    return result;
  }

  /** 单行文本输入（支持掩码与校验）：返回字符串，Esc 返回 null，Ctrl+C 返回 CANCELLED。 */
  async function input({title = '', placeholder = '', defaultValue = '', mask = false, validate = null} = {}) {
    let value = mask ? '' : String(defaultValue || '');
    let err = '';
    const renderer = createRenderer(stdout);

    const render = () => {
      const shown = value
        ? (mask ? '•'.repeat(Math.min(value.length, 32)) : value)
        : (placeholder ? c(ANSI.dim, placeholder) : '');
      const lines = [
        c(ANSI.bold, title),
        `${c(ANSI.cyan, '›')} ${shown}${c(ANSI.cyan, '▏')}`,
        ...(err ? [c(ANSI.red, `⚠️ ${err}`)] : []),
        c(ANSI.dim, 'Enter 确认 · Esc 取消 · Ctrl+U 清空'),
      ];
      renderer.draw(lines);
    };

    const result = await withRawMode(stdin, stdout, ({resolve}) => {
      render();
      return (key) => {
        if (key.name === 'escape') {
          renderer.clear();
          resolve(null);
          return;
        }
        if (key.name === 'clear') {
          value = '';
          err = '';
          render();
          return;
        }
        if (key.name === 'backspace') {
          const chars = [...value];
          chars.pop();
          value = chars.join('');
          err = '';
          render();
          return;
        }
        if (key.name === 'char') {
          value += key.char;
          err = '';
          render();
          return;
        }
        if (key.name === 'enter') {
          const finalVal = value.trim() || (mask ? String(defaultValue || '').trim() : '');
          if (typeof validate === 'function') {
            const msg = validate(finalVal);
            if (msg) {
              err = msg;
              render();
              return;
            }
          }
          renderer.clear();
          resolve(finalVal);
        }
      };
    });
    if (result === CANCELLED) renderer.clear();
    return result;
  }

  /** 二选一确认：返回 boolean，Esc 返回 false，Ctrl+C 返回 CANCELLED。 */
  async function confirm({title = '', message = '', defaultYes = true} = {}) {
    const items = [
      {value: true, label: '确认'},
      {value: false, label: '取消'},
    ];
    const picked = await select({
      title,
      status: message,
      items,
      initialIndex: defaultYes ? 0 : 1,
      backLabel: 'Esc 取消',
    });
    if (picked === CANCELLED) return CANCELLED;
    return picked === true;
  }

  return {select, input, confirm};
}
