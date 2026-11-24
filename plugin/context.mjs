import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Hooks execute through `sh -c`; that short-lived shell is not the session owner.
export function readProcess(pid) {
  const text = execFileSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], {encoding: 'utf8', timeout: 1000}).trim();
  const [, parent, tty, command] = /^(\d+)\s+(\S+)\s+(.+)$/.exec(text) || [];
  return {parent: Number(parent), tty, command};
}
export function processContext(pid = process.ppid, inspect = readProcess, env = process.env) {
  let owner = 0, tty = '';
  const seen = new Set();
  for (let i = 0; i < 12 && pid > 1 && !seen.has(pid); i++) {
    seen.add(pid);
    let info;
    try { info = inspect(pid); } catch { break; }
    if (info.tty && !['?', '??', '-'].includes(info.tty)) tty = info.tty.startsWith('/dev/') ? info.tty : `/dev/${info.tty}`;
    if (!owner && /^(agy|antigravity)(?:-[\w.-]+)?$/.test(path.basename(info.command || ''))) owner = pid;
    pid = info.parent;
  }
  return {pid: owner, loc: {
    tty, termProgram: env.TERM_PROGRAM || '', tmuxPane: env.TMUX_PANE || '',
    tmuxSocket: (env.TMUX || '').split(',')[0], weztermPane: env.WEZTERM_PANE || '',
    kittyWindow: env.KITTY_WINDOW_ID || '', kittySocket: env.KITTY_LISTEN_ON || '',
    cmuxSurface: env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID || '',
  }};
}
