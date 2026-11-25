#!/usr/bin/env node
// agy 生命周期 hook：
// 1. 向本机 agy-remote-wecom daemon 上报终端会话状态（SessionStart / PreInvocation / Stop）与 PreToolUse 远程权限确认请求。
// 2. 首次打开 agy 且尚未配置 botId/secret 时，在 SessionStart 展示一次性配置引导卡（之后不再打扰）。
// 3. 若用户因肌肉记忆在对话框输入 `/remote`，直接在进程内返回配置文件与 CLI 指引（0 子进程、0 Token）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {processContext} from './context.mjs';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function isRemoteSlash(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return false;
  const reqMatch = rawInput.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const text = (reqMatch ? reqMatch[1] : rawInput)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
    .replace(/<SKILL>[\s\S]*$/i, '')
    .trim();
  if (!text || text.includes('\n')) return false;
  return /^\/(?:agy-remote-wecom:)?remote(?:\s+.*)?$/i.test(text);
}

const raw = await readStdin();
let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch {}

const fallback = payload.hookEventName === 'PreToolUse' ? {decision: 'ask'} : {};

if (process.env.AGY_REMOTE_ACP === '1') {
  process.stdout.write(JSON.stringify(fallback) + '\n');
  process.exit(0);
}

const runDir = process.env.AGY_REMOTE_HOME || path.join(os.homedir(), '.config', 'agy-remote-wecom');
const cfgPath = path.join(runDir, 'config.json');

function parseJsonc(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let noComments = '';
  let inStr = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      noComments += ch;
      if (ch === '\\' && i + 1 < src.length) {
        noComments += next;
        i += 1;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      noComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      if (i < src.length) noComments += src[i];
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n' || src[i] === '\r') noComments += src[i];
        i += 1;
      }
      if (i < src.length) i += 1;
      continue;
    }
    noComments += ch;
  }
  let clean = '';
  inStr = false;
  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    if (inStr) {
      clean += ch;
      if (ch === '\\' && i + 1 < noComments.length) {
        clean += noComments[i + 1];
        i += 1;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      clean += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j += 1;
      if (noComments[j] === '}' || noComments[j] === ']') continue;
    }
    clean += ch;
  }
  return JSON.parse(clean);
}

function readLocalConfig() {
  try { return parseJsonc(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; }
}

function isAutoAllowedByAgy(cfg = {}, toolCall = {}) {
  if (cfg.remoteConfirm === 'allow') return true;
  const agyDataDir = cfg.agyDataDir || (process.env.AGY_REMOTE_HOME ? path.join(runDir, 'agy-data') : path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(agyDataDir, 'settings.json'), 'utf8')); } catch { return false; }
  if (settings.toolPermission === 'always-proceed') return true;
  const allowList = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  if (toolCall?.name === 'run_command' && allowList.length) {
    const cmdLine = String(toolCall.args?.CommandLine || toolCall.rawInput?.CommandLine || '').trim();
    if (cmdLine && !/[;&|`$><\n]/.test(cmdLine)) {
      const bin = cmdLine.split(/\s+/)[0];
      if (bin && allowList.includes(`command(${bin})`)) return true;
    }
  }
  return false;
}

function readDaemonEndpoint(cfg = readLocalConfig()) {
  let token = '';
  try { token = fs.readFileSync(path.join(runDir, '.token'), 'utf8').trim(); } catch { return null; }
  let port = Number(process.env.AGY_REMOTE_PORT) || 18779;
  let confirmTimeoutMs = 600_000;
  if (!process.env.AGY_REMOTE_PORT && Number.isInteger(cfg.localPort)) port = cfg.localPort;
  if (Number.isFinite(cfg.remoteConfirmTimeoutMs)) confirmTimeoutMs = cfg.remoteConfirmTimeoutMs;
  return {token, port, confirmTimeoutMs};
}

// 首次安装后第一次打开 agy 且尚未配置 botId/secret 时，在 SessionStart 给出一行一次性引导
const cfg = readLocalConfig();
if (
  payload.hookEventName === 'PreToolUse' &&
  payload.toolCall?.name !== 'ask_question' &&
  isAutoAllowedByAgy(cfg, payload.toolCall)
) {
  process.stdout.write(JSON.stringify({decision: 'ask'}) + '\n');
  process.exit(0);
}
const isConfigured = Boolean(cfg.botId && cfg.secret);
const onboardFlag = path.join(runDir, '.onboard-shown');
if (
  payload.hookEventName === 'SessionStart' &&
  !isConfigured &&
  !process.env.AGY_REMOTE_TAB &&
  !fs.existsSync(onboardFlag)
) {
  try {
    fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
    fs.writeFileSync(onboardFlag, String(Date.now()), {mode: 0o600});
  } catch {}
  const md = [
    '### 📱 Agy Remote WeCom 已安装（尚未配置机器人）',
    '',
    '- **交互式初始化（推荐）**：在系统终端运行 `agy-remote setup`',
    `- **或直接编辑配置表**：[\`${cfgPath}\`](file://${cfgPath})（或运行 \`agy-remote config edit\`），填入企微机器人 \`botId\` 与 \`secret\` 后执行 \`agy-remote start\``,
  ].join('\n');
  process.stdout.write(JSON.stringify({
    injectSteps: [{
      systemMessage: {
        systemMessage: '',
        metadata: {user_markdown: md},
      },
    }],
  }) + '\n');
  process.exit(0);
}

// 若用户在对话框手敲 `/remote`，0 子进程直接返回配置表路径与 CLI 指引并终止模型调用
const isFirstInvocation = (Number(payload.invocationNum) || 0) === 0;
if (payload.hookEventName === 'PreInvocation' && isFirstInvocation && isRemoteSlash(payload.lastUserInput)) {
  const md = [
    '### 📱 Agy Remote WeCom 配置表',
    '',
    `- **配置文件**：[\`config.json\`](file://${cfgPath})（运行 \`agy-remote config edit\` 打开；修改 \`aliases\`、\`tabTitle\`、\`defaultDir\`、\`defaultMode\`、\`remoteConfirm\` 保存即生效）`,
    '- **终端命令**：`agy-remote status`（状态） · `agy-remote config`（查看配置） · `agy-remote setup`（初始化/绑定） · `agy-remote restart`（重启服务）',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    injectSteps: [{
      systemMessage: {
        systemMessage: '',
        metadata: {user_markdown: md},
      },
    }],
    terminationBehavior: 'terminate',
  }) + '\n');
  process.exit(0);
}

const ep = readDaemonEndpoint(cfg);
if (!ep) {
  process.stdout.write(JSON.stringify(fallback) + '\n');
  process.exit(0);
}

const {pid: sessionPid, loc} = processContext();
const timeoutMs = payload.hookEventName === 'PreToolUse' ? ep.confirmTimeoutMs + 5000 : 3000;

try {
  const res = await fetch(`http://127.0.0.1:${ep.port}/hook`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-agy-token': ep.token},
    body: JSON.stringify({
      ...payload,
      pid: sessionPid,
      nonce: process.env.AGY_REMOTE_TAB || '',
      loc,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) {
    const out = await res.json();
    process.stdout.write(JSON.stringify(out || fallback) + '\n');
    process.exit(0);
  }
} catch {}

process.stdout.write(JSON.stringify(fallback) + '\n');
