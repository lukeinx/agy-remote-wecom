// agy-remote-wecom 后台守护进程：
// - 企微智能机器人长连接（WeComTransport）
// - 后台会话：单进程 `agy acp` 承载多个 ACP 会话（session/new | load | list | prompt | cancel | set_config_option）
// - 终端会话：由 agy plugin hooks（SessionStart / PreInvocation / PreToolUse / Stop）上报到 /hook，
//   手机通过终端注入 API 或 Stop hook 续写投递；PreToolUse 权限确认推送企微卡片
// - 交互体感对齐 pi-remote-wecom：2s 同步等待窗口（2s 内完成直接回结果，超时才回「⏳ 运行中」）、
//   切换模型/思考/模式/目录/选择会话/创建会话均使用原生 text_notice 状态卡
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {RUN_DIR, CONFIG_FILE, loadConfig, saveOwner, ensureToken, updateConfigFile, readAgySettings, isToolAutoAllowedByAgy, VERSION, diskVersion} from './config.mjs';
import {loadAliases, expandDir, tildeDir} from './aliases.mjs';
import {WeComTransport, notifyDesktop} from './wecom.mjs';
import {AcpClient, configOf} from './acp.mjs';
import {resolveTerminal, screenLocked, injectKind, injectText, injectEscape, setTabTitle, isAutomationPermissionError} from './terminals.mjs';
import {
  fetchCliModels,
  modelMatchesCurrent,
  extractEffortFromModel,
  stripEffortSuffix,
  inferModelContextWindow,
  findModelEntry,
  resolveVariantByDisplayName,
  formatModelLabel,
} from './models.mjs';
import {fetchCliUsage, formatUsageBody, formatUsageClock} from './usage.mjs';
import {processContext} from '../plugin/context.mjs';
import {brainDir, transcriptFile, readSteps, turns, lastAnswer, artifacts, readContextUsage} from './transcript.mjs';
import {
  loadTitles,
  saveTitleEntry,
  syncSummaryDbTitle,
  readNamingPref,
  writeNamingPref,
  namingStatusLabel,
  requestChineseTitle,
  updateTargetTabStatus,
} from './naming.mjs';

const CFG = loadConfig();
const TOKEN = ensureToken();
const LOG_FILE = path.join(RUN_DIR, 'daemon.log');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const PICKS_FILE = path.join(RUN_DIR, 'picks.json');
export const ACP_STATE_FILE = path.join(RUN_DIR, 'acp-state.json');
const HANDOFF_NOTICE_TTL_MS = 15 * 60_000;

let desktopNotifier = (title, body) => {
  if (process.env.AGY_REMOTE_NO_LISTEN !== '1') notifyDesktop(title, body);
};
export function setDesktopNotifier(fn) {
  desktopNotifier = typeof fn === 'function' ? fn : () => {};
}
const HIST_LIST = 15;
const VOTE_OPT_MAX = 20;
const CARD_TTL_MS = 30 * 60000;
const SYNC_WINDOW_MS = 2000;
const EMPH_MAX = 10;
const EMPH_NAME_MAX = 16;
const EMPH_DESC_MAX = 15;
const CARD_BODY_MAX = 108;

let _cfgCache = {key: '', cfg: CFG};
export function liveConfig() {
  try {
    let key = 'missing';
    try {
      const st = fs.statSync(CONFIG_FILE);
      key = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {}
    if (_cfgCache.key === key && _cfgCache.cfg) return _cfgCache.cfg;
    const next = loadConfig();
    _cfgCache = {key, cfg: next};
    return next;
  } catch {
    return _cfgCache.cfg || CFG;
  }
}

function effectiveDefaultMode(cfg = liveConfig()) {
  if (cfg.defaultMode && cfg.defaultMode !== 'default') return cfg.defaultMode;
  if (readAgySettings(cfg.agyDataDir).toolPermission === 'always-proceed') return 'auto';
  return cfg.defaultMode || 'default';
}

function shouldAutoAllowPermission(toolCall = {}, t = null) {
  const cfg = liveConfig();
  if (cfg.remoteConfirm === 'allow') return true;
  if (t?.sessionAutoAllow) return true;
  if (isToolAutoAllowedByAgy(cfg.agyDataDir, toolCall)) return true;
  const mode = t?.mode || '';
  if ((mode === 'auto' || mode === 'accept-edits') && ['write_file', 'edit_file'].includes(toolCall?.name)) {
    return true;
  }
  return false;
}

const THINK_CN = {low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高'};
const MODE_CN = {
  default: '默认（读写需确认）',
  'accept-edits': '自动允许改文件',
  auto: '自动允许编辑与安全命令',
  plan: '先规划后执行',
};

const ts = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19);
export function log(line) {
  try { fs.appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`, {mode: 0o600}); } catch {}
}

const stripCtrl = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
const CTRL_KEEP_NL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const stripCtrlKeepNl = (s) => String(s ?? '').replace(CTRL_KEEP_NL_RE, ' ').replace(/[^\S\n]{2,}/g, ' ');
function clipWidth(s, maxW) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    const w = (c) => (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(c) ? 2 : 1);
    let used = 0, out = "";
    for (const c of Array.from(t)) {
        const cw = w(c);
        if (used + cw > maxW - 1 && used + cw + (Array.from(t).length - Array.from(out).length - 1 > 0 ? 1 : 0) > maxW) return out + "…";
        out += c; used += cw;
    }
    return out;
}
function clip(s, n) {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    const cps = Array.from(t);
    return cps.length <= n ? t : cps.slice(0, Math.max(1, n - 1)).join("") + "…";
}
function stripAstral(s) {
  return [...String(s ?? '')].map((ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch) ? '□' : ch).join('');
}
function sanitizeCard(v) {
  if (typeof v === 'string') return stripCtrl(stripAstral(v));
  if (Array.isArray(v)) return v.map((x) => sanitizeCard(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[stripCtrl(stripAstral(k))] = sanitizeCard(val);
    return o;
  }
  return v;
}

const human = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}小时${m % 60}分`;
  return `${m}分${s % 60}秒`;
};
const ago = (mtimeMs) => {
  const d = Date.now() - Number(mtimeMs || 0);
  if (d < 120000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)}分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}小时前`;
  if (d < 172800000) return '昨天';
  return `${Math.floor(d / 86400000)}天前`;
};
const fmtSize = (n) => n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`;
const dirLabel = (cwd) => {
  const branch = gitBranch(cwd);
  return ['', 'main', 'master', 'detached'].includes(branch) ? tildeDir(cwd) : `${tildeDir(cwd)} (${branch})`;
};
function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000}).trim();
  } catch { return ''; }
}
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ─────────────────────────── 三段式消息与卡片工具（对齐 pi-remote） ───────────────────────────
const RULE = '---';
export function plainText({head, subject = '', body = '', foot = '', extra = ''}) {
  const parts = [`### ${subject ? `${head} · ${clipWidth(subject, 32)}` : head}`];
  if (body) parts.push('', RULE, '', body);
  if (extra) parts.push('', extra);
  if (foot) parts.push('', RULE, '', footLine(foot));
  return parts.join('\n');
}
function footLine(foot) {
  return String(foot).split(' · ').map((seg) => (seg.includes('`') ? seg : '`' + seg + '`')).join(' · ');
}

let taskSeq = 0;
const taskId = (tag) => `task_${String(tag).replace(/[^0-9A-Za-z]/g, '')}_${Date.now()}${++taskSeq}`;
const cardPicks = new Map();
const usedTasks = new Map();

function loadPicks() {
  try {
    const data = JSON.parse(fs.readFileSync(PICKS_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Array.isArray(data?.picks) ? data.picks : []) {
      if (!k || !v || v.act === 'ui' || now - Number(v.at || 0) > CARD_TTL_MS) continue;
      cardPicks.set(k, v);
    }
    for (const [k, v] of Array.isArray(data?.used) ? data.used : []) {
      if (!k || !v || now - Number(v.at || 0) > CARD_TTL_MS) continue;
      usedTasks.set(k, v);
    }
  } catch {}
}
function savePicks() {
  const now = Date.now();
  const picks = [];
  for (const [k, v] of cardPicks) {
    if (!v || v.act === 'ui' || now - Number(v.at || 0) > CARD_TTL_MS) continue;
    picks.push([k, v]);
  }
  const used = [];
  for (const [k, v] of usedTasks) {
    if (!v || now - Number(v.at || 0) > CARD_TTL_MS) continue;
    used.push([k, v]);
  }
  try {
    const tmp = `${PICKS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({picks: picks.slice(-600), used: used.slice(-300)}), {mode: 0o600});
    fs.renameSync(tmp, PICKS_FILE);
  } catch {}
}
loadPicks();

function registerPick(info) {
  if (cardPicks.size > 600) {
    for (const k of [...cardPicks.keys()].slice(0, 300)) {
      if (!(cardPicks.get(k)?.act === 'ui' && uiPending.has(cardPicks.get(k).reqId))) cardPicks.delete(k);
    }
  }
  const key = `pb_${crypto.randomUUID()}`;
  cardPicks.set(key, {...info, at: Date.now()});
  return key;
}
function consumeTask(tid) {
  const now = Date.now();
  for (const [k, v] of usedTasks) if (now - v.at > CARD_TTL_MS) usedTasks.delete(k);
  if (!tid) return null;
  const hit = usedTasks.get(tid);
  if (hit) return hit;
  usedTasks.set(tid, {at: now, reply: ''});
  savePicks();
  return null;
}
function cardBlock(card, lead = '', fallback = '') {
  const clean = sanitizeCard(card);
  let persisted = false;
  for (const option of card.options || []) {
    const pick = cardPicks.get(option.id);
    if (pick) {
      pick.taskId = card.task_id;
      if (pick.act !== 'ui') persisted = true;
    }
  }
  if (persisted) savePicks();
  const text = typeof fallback === 'function' ? fallback() : String(fallback || lead);
  return {card: clean, fallback: text};
}

/** 对齐 pi-remote 的 text_notice 状态卡片 */
function stateCard({tag, icon, title, desc, emph, emphMax = EMPH_MAX, body = '', facts = [], lead = '', fallback}) {
  const hc = facts
    .filter(Boolean)
    .slice(0, 6)
    .map((f) => ({keyname: clip(f.keyname, 5), value: clip(f.value, 26)}));
  const card = {
    card_type: 'text_notice',
    main_title: {title: clip(icon ? `${icon} ${title}` : title, 26), desc: clip(desc, 30)},
    card_action: {type: 1, url: 'https://work.weixin.qq.com'},
    task_id: taskId(tag),
  };
  if (emph) {
    card.emphasis_content = {title: clip(emph.title, emphMax)};
    if (emph.desc) card.emphasis_content.desc = clip(emph.desc, EMPH_DESC_MAX);
  }
  if (body) card.sub_title_text = clip(body, CARD_BODY_MAX);
  if (hc.length) card.horizontal_content_list = hc;
  return cardBlock(card, lead, fallback);
}

// ─────────────────────────── 持久状态（当前会话、默认目录、静音） ───────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = {...loadState(), ...patch};
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

let currentSessionId = loadState().currentSessionId || '';
let muted = Boolean(loadState().muted);
let remoteWatchAll = false;
let pushedIds = [];

function defaultDir() {
  const d = loadState().defaultDir;
  if (d && fs.existsSync(expandDir(d))) return expandDir(d);
  try {
    const cfgDir = loadConfig().defaultDir;
    if (cfgDir && fs.existsSync(expandDir(cfgDir))) return expandDir(cfgDir);
  } catch {}
  return os.homedir();
}
function setDefaultDir(d) {
  const td = tildeDir(d);
  saveState({defaultDir: td});
  try { updateConfigFile({defaultDir: td}); } catch {}
}

// ─────────────────────────── 会话模型（Target） ───────────────────────────
// kind: 'tui'（终端可见会话，由 hook 上报）| 'acp'（后台 ACP 会话）| 'history'（历史项）
const earlyUpdates = new Map(); // ACP may emit configuration before session/new responds.
const targets = new Map(); // sessionId -> Target
const pendingTabs = new Map(); // nonce -> {cwd, msg, media, createdAt, resolve}

const kindOf = (t) => (t.kind === 'tui' ? '终端可见' : t.kind === 'history' ? '历史会话' : '后台会话');

function makeRun(origin = 'mobile') {
  let resolveDone;
  const donePromise = new Promise((r) => { resolveDone = r; });
  return {
    startedAt: Date.now(),
    endedAt: 0,
    settled: false,
    startStepCount: 0,
    origin,
    muted: origin === 'desktop' ? muted : false,
    watched: origin === 'mobile',
    chunks: [],
    tool: '',
    error: '',
    stopped: false,
    stopRequestedAt: 0,
    doneMsg: null,
    settle(msg = null) {
      if (this.settled) return false;
      this.settled = true;
      if (!this.endedAt) this.endedAt = Date.now();
      this.doneMsg = msg;
      resolveDone(msg);
      return true;
    },
    wait() { return donePromise; },
  };
}

function makeTarget(sessionId, kind, init = {}) {
  const saved = loadTitles()[sessionId];
  const initModel = init.model || '';
  const initWindow = Number.isFinite(init.contextWindow) && init.contextWindow > 0
    ? init.contextWindow
    : inferModelContextWindow(initModel);
  const initUsed = Number.isFinite(init.usedTokens) && init.usedTokens >= 0 ? init.usedTokens : 0;
  return {
    sessionId,
    key: sessionId,
    kind, // 'tui' | 'acp' | 'history'
    cwd: init.cwd || os.homedir(),
    name: init.name || '',
    customName: saved?.title || init.customName || '',
    namingStatus: saved?.title ? 'named' : 'idle', // 'idle' | 'pending' | 'named' | 'failed'
    namingPromise: null,
    runStatus: 'idle',
    tabTimer: null,
    tabFrame: 0,
    firstInput: init.firstInput || '',
    model: initModel,
    thoughtLevel: init.thoughtLevel || '',
    mode: init.mode || liveConfig().defaultMode || 'default',
    configOptions: init.configOptions || [],
    availableCommands: init.availableCommands || [],
    usedTokens: initUsed,
    usedTokensKnown: Boolean(init.usedTokensKnown || initUsed > 0),
    contextWindow: initWindow,
    contextWindowModel: init.contextWindowModel || (initWindow ? initModel : ''),
    usageUpdatedAt: Number.isFinite(init.usageUpdatedAt) ? init.usageUpdatedAt : 0,
    transcriptPath: init.transcriptPath || '',
    _transcriptUsageCache: {},
    busy: false,
    bgActive: false,
    loaded: kind === 'acp',
    replaying: false,
    pid: init.pid || 0,
    loc: init.loc || {},
    lastActivity: init.lastActivity || Date.now(),
    updatedAt: init.updatedAt || Date.now(),
    currentRun: null,
    queue: [],
    steers: [],
    lastArtCount: 0,
    pendingHandoff: null,
    handoffCompleted: null,
    _lastHandoffTabTitle: '',
    label() {
      return stripCtrl(this.customName || this.name || this.firstInput || '') || (this.kind === 'history' ? '会话' : `新会话 · ${tildeDir(this.cwd)}`);
    },
    shortTitle() {
      return stripCtrl(this.customName || this.name || this.firstInput || '') || '新会话';
    },
  };
}

function refreshTuiLoc(pid, loc = {}) {
  if (!pid || !loc?.tty) return loc;
  try {
    const resolved = processContext(pid).loc?.tty;
    if (resolved) return {...loc, tty: resolved};
  } catch {}
  return loc;
}

function saveTuiSessions() {
  const tuiSessions = [];
  for (const t of targets.values()) {
    if (t.kind === 'tui' && t.pid && pidAlive(t.pid)) {
      tuiSessions.push({
        sessionId: t.sessionId,
        pid: t.pid,
        cwd: t.cwd,
        name: t.name,
        customName: t.customName,
        firstInput: t.firstInput,
        model: t.model,
        thoughtLevel: t.thoughtLevel,
        usedTokens: t.usedTokens,
        usedTokensKnown: t.usedTokensKnown,
        contextWindow: t.contextWindow,
        contextWindowModel: t.contextWindowModel,
        transcriptPath: t.transcriptPath,
        loc: t.loc,
        lastActivity: t.lastActivity,
        updatedAt: t.updatedAt,
      });
    }
  }
  saveState({tuiSessions});
}

function saveAcpSessions() {
  const now = Date.now();
  const idleCloseMs = liveConfig().idleCloseMs;
  const acpSessions = [];
  for (const t of targets.values()) {
    if (t.kind !== 'acp') continue;
    if (t.sessionId !== currentSessionId && now - (t.lastActivity || 0) > idleCloseMs) continue;
    acpSessions.push({
      sessionId: t.sessionId,
      cwd: t.cwd,
      name: t.name,
      customName: t.customName,
      firstInput: t.firstInput,
      model: t.model,
      thoughtLevel: t.thoughtLevel,
      mode: t.mode,
      usedTokens: t.usedTokens,
      usedTokensKnown: t.usedTokensKnown,
      contextWindow: t.contextWindow,
      contextWindowModel: t.contextWindowModel,
      lastActivity: t.lastActivity,
      updatedAt: t.updatedAt,
    });
  }
  saveState({acpSessions});
}

function getOrCreateTarget(sessionId, kind, init = {}) {
  let t = targets.get(sessionId);
  const prevKind = t?.kind || '';
  const pid = init.pid || t?.pid || 0;
  const loc = kind === 'tui' && init.loc ? refreshTuiLoc(pid, init.loc) : init.loc;
  if (!t) {
    t = makeTarget(sessionId, kind, {...init, loc});
    targets.set(sessionId, t);
  } else {
    if (kind === 'tui') { t.kind = 'tui'; t.loaded = false; }
    else if (kind === 'acp' && t.kind === 'history') t.kind = 'acp';
    if (init.cwd && (init.cwd !== '/' || !t.cwd || t.cwd === '/')) t.cwd = init.cwd;
    if (init.name) t.name = init.name;
    if (init.customName) t.customName = init.customName;
    if (init.firstInput && !t.firstInput) t.firstInput = init.firstInput;
    if (init.model) {
      const prevModel = t.model;
      t.model = init.model;
      const ef = extractEffortFromModel(init.model);
      if (ef) t.thoughtLevel = ef;
      else if (prevModel && init.model !== prevModel && !init.thoughtLevel) t.thoughtLevel = '';
      syncModelContextWindow(t, init.model);
    }
    if (init.thoughtLevel) t.thoughtLevel = init.thoughtLevel;
    if (init.transcriptPath) t.transcriptPath = init.transcriptPath;
    if (init.pid) t.pid = init.pid;
    if (loc && Object.values(loc).some(Boolean)) t.loc = {...t.loc, ...loc};
    t.lastActivity = Date.now();
  }
  if (t.kind === 'tui') {
    saveTuiSessions();
    if (prevKind === 'acp') saveAcpSessions();
  } else if (t.kind === 'acp') {
    saveAcpSessions();
  }
  return t;
}

{
  const savedState = loadState();
  for (const s of savedState.tuiSessions || []) {
    if (!s?.sessionId || !s.pid || !pidAlive(s.pid)) continue;
    const loc = refreshTuiLoc(s.pid, s.loc || {});
    targets.set(s.sessionId, makeTarget(s.sessionId, 'tui', {...s, loc}));
  }
  const now = Date.now();
  for (const s of savedState.acpSessions || []) {
    if (!s?.sessionId || targets.has(s.sessionId)) continue;
    if (s.sessionId !== currentSessionId && now - Number(s.lastActivity || 0) > CFG.idleCloseMs) continue;
    const t = makeTarget(s.sessionId, 'acp', s);
    t.loaded = false;
    targets.set(s.sessionId, t);
  }
  writeAcpState();
}

export function writeAcpState({clear = false} = {}) {
  const cfg = liveConfig();
  const payload = {
    version: 1,
    daemonPid: process.pid,
    port: Number(cfg.localPort) || CFG.localPort,
    updatedAt: Date.now(),
    sessions: {},
  };
  if (!clear) {
    const now = Date.now();
    for (const t of targets.values()) {
      if (t.handoffCompleted && (
        now - Number(t.handoffCompleted.endedAt || 0) > HANDOFF_NOTICE_TTL_MS
        || (t.handoffCompleted.pid && !pidAlive(t.handoffCompleted.pid))
      )) {
        t.handoffCompleted = null;
      }
      if (t.pendingHandoff?.pid && !pidAlive(t.pendingHandoff.pid)) {
        t.pendingHandoff = null;
        t._lastHandoffTabTitle = '';
      }
      if (t.kind === 'acp') {
        if (t.busy) {
          payload.sessions[t.sessionId] = {
            status: 'busy',
            label: t.shortTitle(),
            startedAt: t.currentRun?.startedAt || t.lastActivity || now,
            tool: t.currentRun?.tool || '',
            waitingPid: t.pendingHandoff?.pid || 0,
          };
        } else {
          payload.sessions[t.sessionId] = {
            status: 'idle',
            label: t.shortTitle(),
            updatedAt: t.lastActivity || now,
          };
        }
      } else if (t.kind === 'tui' && t.handoffCompleted) {
        payload.sessions[t.sessionId] = {
          status: t.handoffCompleted.status,
          stopped: Boolean(t.handoffCompleted.stopped),
          label: t.shortTitle(),
          endedAt: t.handoffCompleted.endedAt,
          waitingPid: t.handoffCompleted.pid || 0,
          snapshotTokens: t.handoffCompleted.snapshotTokens || 0,
        };
      }
    }
  }
  try {
    fs.mkdirSync(RUN_DIR, {recursive: true, mode: 0o700});
    const tmp = `${ACP_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(tmp, ACP_STATE_FILE);
  } catch {}
}

function registerPendingHandoff(t, {pid = 0, loc = {}, cwd = '', transcriptPath = '', totalTokens} = {}) {
  if (!t) return;
  const resolvedLoc = refreshTuiLoc(pid, loc);
  const snapshotTokens = totalTokens === undefined
    ? (t.pendingHandoff?.snapshotTokens || 0)
    : (Number(totalTokens) || 0);
  t.pendingHandoff = {
    pid: Number(pid) || 0,
    loc: resolvedLoc,
    cwd: cwd || t.cwd,
    transcriptPath: transcriptPath || t.transcriptPath || '',
    snapshotTokens,
    attachedAt: t.pendingHandoff?.attachedAt || Date.now(),
  };
  const cfg = liveConfig();
  if (readNamingPref(cfg).enabled && (resolvedLoc?.tty || injectKind(resolvedLoc))) {
    const title = `⏳ ${t.shortTitle()}`;
    if (t._lastHandoffTabTitle !== title) {
      t._lastHandoffTabTitle = title;
      void setTabTitle(resolvedLoc, title);
    }
  }
  writeAcpState();
}

async function completePendingHandoff(t, run) {
  const h = t?.pendingHandoff;
  if (!h || t.kind !== 'acp' || t.busy) {
    writeAcpState();
    return;
  }
  if (h.pid && !pidAlive(h.pid)) {
    t.pendingHandoff = null;
    t._lastHandoffTabTitle = '';
    writeAcpState();
    return;
  }
  if (t.loaded) {
    try {
      await acp.call('session/close', {sessionId: t.sessionId}, 10_000);
      t.loaded = false;
    } catch (e) {
      log(`handoff session/close failed id=${t.sessionId.slice(0, 8)}: ${e.message}`);
    }
  }
  const promoted = getOrCreateTarget(t.sessionId, 'tui', {
    cwd: h.cwd || t.cwd,
    pid: h.pid,
    loc: h.loc,
    transcriptPath: h.transcriptPath || t.transcriptPath,
  });
  promoted.pendingHandoff = null;
  promoted._lastHandoffTabTitle = '';
  const failed = Boolean(run?.error);
  const stopped = Boolean(run?.stopped);
  promoted.handoffCompleted = {
    endedAt: Date.now(),
    status: failed ? 'error' : 'done',
    stopped,
    pid: h.pid,
    snapshotTokens: h.snapshotTokens || 0,
  };
  const cfg = liveConfig();
  if (readNamingPref(cfg).enabled) {
    const tabLabel = failed ? `× ${promoted.shortTitle()} · 请刷新` : `· ${promoted.shortTitle()} · 请刷新`;
    promoted._lastTabTitle = tabLabel;
    void setTabTitle(promoted.loc, tabLabel);
  }
  writeAcpState();
  log(`hand off completed acp -> tui id=${promoted.sessionId.slice(0, 8)} pid=${promoted.pid}`);
  const notifyTitle = failed
    ? 'Agy Remote · 手机端任务失败'
    : stopped
      ? 'Agy Remote · 手机端任务已中断'
      : 'Agy Remote · 手机端任务已完成';
  const notifyBody = `「${promoted.label()}」已交接给当前终端，请在 Agy 中输入 /resume 刷新画面`;
  desktopNotifier(notifyTitle, notifyBody);
}

/**
 * 同步设置会话标题：更新内存、持久化 titles.json、写回 agy conversation_summaries.db，并刷新终端标签页
 */
export function setSessionTitle(t, title, source = 'manual') {
  const clean = stripCtrl(title);
  if (!t || !clean) return;
  const cfg = liveConfig();
  t.customName = clean;
  t.namingStatus = 'named';
  saveTitleEntry(t.sessionId, clean, source);
  syncSummaryDbTitle(cfg.agyDataDir, t.sessionId, clean);
  if (t.kind === 'tui') {
    const enabled = readNamingPref(cfg).enabled;
    updateTargetTabStatus(t, t.runStatus || (t.busy ? 'running' : 'idle'), {tabTitleEnabled: enabled});
    saveTuiSessions();
  } else if (t.kind === 'acp') {
    saveAcpSessions();
    writeAcpState();
  }
}

/**
 * 首条输入触发自动中文命名（无状态 HTTP 直连 DeepSeek-V4.1-Flash，失败只重试 1 次，不阻塞主任务，不建 agy 会话）
 */
export function triggerAutoNaming(t, promptText = '', {force = false, generator} = {}) {
  if (!t) return null;
  const pref = readNamingPref();
  if (!pref.enabled && !force) return null;
  if (!force && (t.customName || t.namingStatus === 'pending' || t.namingStatus === 'named' || t.namingStatus === 'failed')) {
    return t.namingPromise;
  }
  const text = stripCtrl(promptText || t.firstInput || '');
  if (!text) return null;
  t.namingStatus = 'pending';
  const model = pref.model || 'deepseek-v4.1-flash';
  const p = (async () => {
    try {
      let title;
      try {
        title = await requestChineseTitle(text, {model, generator});
      } catch (e) {
        await new Promise((r) => setTimeout(r, 800));
        title = await requestChineseTitle(text, {model, generator});
      }
      if (t.namingStatus === 'pending' || force) {
        setSessionTitle(t, title, 'auto');
        log(`auto-named session=${t.sessionId.slice(0, 8)} title=${JSON.stringify(title)}`);
      }
      return title;
    } catch (e) {
      if (t.namingStatus === 'pending') t.namingStatus = 'failed';
      log(`auto-name failed session=${t.sessionId.slice(0, 8)}: ${e?.message || e}`);
      return '';
    } finally {
      t.namingPromise = null;
    }
  })();
  t.namingPromise = p;
  return p;
}

async function waitForAutoName(t, maxMs = (Number.isFinite(liveConfig().nameWaitMs) ? liveConfig().nameWaitMs : 5000)) {
  if (!t || t.customName || !t.namingPromise || maxMs <= 0) return;
  const t0 = Date.now();
  await Promise.race([
    t.namingPromise,
    new Promise((r) => setTimeout(r, maxMs)),
  ]);
  log(`创建会话 等会话名 ${t.customName ? `命中 ${Date.now() - t0}ms` : `超时 ${maxMs}ms，用首条截断`}`);
}

function pidAlive(pid) {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function isLiveTarget(t) {
  if (!t || t.kind === 'history') return false;
  if (t.kind === 'tui') {
    if (t.pid && !pidAlive(t.pid)) {
      t.kind = t.loaded ? 'acp' : 'history';
      t.busy = false;
      saveTuiSessions();
      return t.kind === 'acp';
    }
    return true;
  }
  return t.kind === 'acp';
}

function currentTarget() {
  const t = targets.get(currentSessionId);
  return isLiveTarget(t) ? t : null;
}
function bindCurrent(t) {
  if (!t) return;
  currentSessionId = t.sessionId;
  muted = false;
  saveState({currentSessionId, muted: false});
  if (t.kind === 'acp') saveAcpSessions();
  // 新建或切换会话是用户主动动作，清空此前其他会话的推送记录，避免误弹路由确认卡。
  pushedIds = [];
}
function notePush(t) {
  if (!t) return;
  pushedIds = [t.sessionId, ...pushedIds.filter((id) => id !== t.sessionId)];
}
function pushedOthers(cur) {
  return pushedIds
    .filter((id) => id !== cur?.sessionId)
    .map((id) => targets.get(id))
    .filter((t) => isLiveTarget(t));
}

// ─────────────────────────── ACP 客户端与事件处理 ───────────────────────────
function acpArgs(cfg = liveConfig()) {
  return cfg.acpProcessPerSession === false ? ['acp'] : ['acp', '--process-per-session'];
}
function syncAcpLaunchOptions(cfg = liveConfig()) {
  acp.bin = cfg.agyBin || CFG.agyBin;
  if (!acp.alive) acp.args = acpArgs(cfg);
}
export const acp = new AcpClient({
  bin: CFG.agyBin,
  args: acpArgs(CFG),
  log: (msg) => log(msg),
});

function syncConfigOptions(t, configOptions) {
  if (!Array.isArray(configOptions)) return;
  t.configOptions = configOptions;
  const prevModel = t.model;
  const m = configOf(configOptions, 'model');
  if (m?.currentValue) {
    t.model = m.currentValue;
    syncModelContextWindow(t, m.currentValue);
  }
  const th = configOf(configOptions, 'thought_level');
  if (th?.currentValue) t.thoughtLevel = th.currentValue;
  else if (m?.currentValue && m.currentValue !== prevModel) {
    t.thoughtLevel = extractEffortFromModel(m.currentValue);
  }
  const md = configOf(configOptions, 'mode');
  if (md?.currentValue) t.mode = md.currentValue;
}

acp.on('update', (sessionId, update) => {
  const t = targets.get(sessionId);
  if (!t) {
    const buffered = earlyUpdates.get(sessionId) || [];
    buffered.push(update);
    earlyUpdates.set(sessionId, buffered.slice(-30));
    if (earlyUpdates.size > 30) earlyUpdates.delete(earlyUpdates.keys().next().value);
    return;
  }
  t.lastActivity = Date.now();
  const kind = update.sessionUpdate;
  if (kind === 'session_info_update' && update.title) {
    t.name = stripCtrl(update.title);
  } else if (kind === 'config_option_update' && update.configOptions) {
    syncConfigOptions(t, update.configOptions);
  } else if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) {
    t.availableCommands = update.availableCommands;
  } else if (kind === 'usage_update') {
    if (typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0) {
      t.usedTokens = update.used;
      t.usedTokensKnown = true;
      t.usageUpdatedAt = Date.now();
    }
    if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0) {
      t.contextWindow = update.size;
      t.contextWindowModel = t.model || '';
    }
  } else if (kind === 'tool_call' && t.currentRun) {
    const nextTool = update.name || update.title || '';
    if (nextTool !== t.currentRun.tool) {
      t.currentRun.tool = nextTool;
      if (t.kind === 'acp') writeAcpState();
    }
  } else if (kind === 'agent_message_chunk' && !t.replaying) {
    const chunk = update.content?.text || '';
    if (t.currentRun && chunk) t.currentRun.chunks.push(chunk);
  } else if (kind === 'user_message_chunk') {
    const txt = update.content?.text || '';
    if (txt && !t.firstInput) t.firstInput = stripCtrl(txt).slice(0, 80);
  }
});

acp.on('permission', (params, respond) => {
  const sessionId = params.sessionId;
  const t = targets.get(sessionId) || getOrCreateTarget(sessionId, 'acp');
  openPermissionPrompt(t, params, respond);
});

acp.on('exit', () => {
  for (const t of targets.values()) {
    t.loaded = false;
    if (t.kind === 'acp') {
      cancelPermissions(t);
      // The rejected session/prompt owns settlement; settling here as well double-pushes.
      if (t.currentRun) t.currentRun.exited = true;
    }
  }
  writeAcpState();
});

async function ensureAcpSession(t) {
  if (t.kind === 'tui' && isLiveTarget(t)) throw new Error('该会话仍在终端打开，不能同时由后台加载。请先关闭终端会话，再从历史会话恢复。');
  syncAcpLaunchOptions();
  await acp.start();
  if (t.loaded) return;
  t.replaying = true;
  try {
    const res = await acp.call('session/load', {
      sessionId: t.sessionId,
      cwd: t.cwd || os.homedir(),
      mcpServers: [],
    }, 60_000);
    if (res?.configOptions) syncConfigOptions(t, res.configOptions);
    if (res?.models?.currentModelId && !t.model) {
      t.model = res.models.currentModelId;
      syncModelContextWindow(t, t.model);
    }
    if (res?.modes?.currentModeId) t.mode = res.modes.currentModeId;
    t.loaded = true;
    refreshTargetContext(t);
  } finally {
    t.replaying = false;
  }
}

async function createAcpSession(cwd, initMode = effectiveDefaultMode()) {
  syncAcpLaunchOptions();
  await acp.start();
  const res = await acp.call('session/new', {cwd, mcpServers: []}, 60_000);
  const sid = res.sessionId;
  const t = getOrCreateTarget(sid, 'acp', {
    cwd,
    model: res.models?.currentModelId || '',
    mode: res.modes?.currentModeId || 'default',
    configOptions: res.configOptions || [],
  });
  syncConfigOptions(t, res.configOptions || []);
  const buffered = earlyUpdates.get(sid) || [];
  earlyUpdates.delete(sid);
  for (const update of buffered) acp.emit('update', sid, update);
  t.loaded = true;
  if (initMode && initMode !== 'default' && initMode !== t.mode) {
    try {
      const r = await acp.call('session/set_config_option', {sessionId: sid, configId: 'mode', value: initMode}, 15_000);
      if (r?.configOptions) syncConfigOptions(t, r.configOptions);
    } catch (e) { log(`set init mode failed: ${e.message}`); }
  }
  saveAcpSessions();
  writeAcpState();
  return t;
}

// ─────────────────────────── 权限确认卡片与 ask_question 卡片 ───────────────────────────
const uiPending = new Map(); // reqId -> entry
const askPending = new Map(); // reqId -> entry

function pickAlwaysAllowOption(options = []) {
  return options.find((o) => o.kind === 'allow_always' || o.optionId === 'allow_always');
}
function pickAllowOption(options = []) {
  return options.find((o) => o.kind === 'allow_once')
    || options.find((o) => String(o.kind || '').startsWith('allow'))
;
}
function pickRejectOption(options = []) {
  return options.find((o) => o.kind === 'reject_once')
    || options.find((o) => String(o.kind || '').startsWith('reject'))
;
}

function formatPermDetail(params) {
  const tc = params.toolCall || {};
  const lines = [];
  if (tc.title || tc.name) lines.push(`**${stripCtrl(tc.title || tc.name)}**`);
  const input = tc.rawInput || tc.args || {};
  if (input.CommandLine) lines.push('```sh\n' + String(input.CommandLine).slice(0, 600) + '\n```');
  else if (input.Path) lines.push(`文件：\`${input.Path}\``);
  else if (Object.keys(input).length) lines.push('```json\n' + JSON.stringify(input, null, 2).slice(0, 600) + '\n```');
  return lines.join('\n\n') || '工具执行需要授权确认';
}

function openPermissionPrompt(t, params, respond) {
  const options = Array.isArray(params.options) ? params.options : [];
  if (!options.length) { respond({outcome: 'cancelled'}); return; }
  const detail = formatPermDetail(params);
  if (shouldAutoAllowPermission(params.toolCall, t)) {
    const allow = pickAlwaysAllowOption(options) || pickAllowOption(options);
    if (allow) respond({outcome: 'selected', optionId: allow.optionId});
    else respond({outcome: 'cancelled'});
    return;
  }
  const cfg = liveConfig();
  const uiPolicy = cfg.remoteConfirm;
  const uiTimeoutMs = cfg.remoteConfirmTimeoutMs;
  const reqId = `perm_${crypto.randomUUID()}`;
  const timeoutMs = t.kind === 'tui' ? Math.min(uiTimeoutMs, 600_000) : uiTimeoutMs;
  const afterLabel = uiPolicy === 'ask-then-allow' ? '自动允许' : '自动拒绝';
  const entry = {
    reqId, t, params, respond, done: false,
    timer: setTimeout(() => {
      if (entry.done) return;
      entry.done = true;
      uiPending.delete(reqId);
      const chosen = uiPolicy === 'ask-then-allow' ? pickAllowOption(options) : pickRejectOption(options);
      if (chosen) respond({outcome: 'selected', optionId: chosen.optionId});
      else respond({outcome: 'cancelled'});
      sendText(plainText({
        head: uiPolicy === 'ask-then-allow' ? '⏰ 超时已自动允许' : '⏰ 超时已自动拒绝',
        subject: t.label(),
        body: detail,
        foot: `超过 ${Math.round(timeoutMs / 60000)} 分钟未操作`,
      }));
    }, timeoutMs),
  };
  entry.timer.unref?.();
  uiPending.set(reqId, entry);

  const cardOpts = options.slice(0, VOTE_OPT_MAX).map((o) => ({
    id: registerPick({act: 'ui', reqId, optionId: o.optionId, optionKind: o.kind || '', optionName: o.name || o.optionId}),
    text: clip(`${o.name || o.optionId}`, 60),
  }));
  const tid = taskId('perm');
  const card = {
    card_type: 'vote_interaction',
    title: clip(`🔐 权限确认 · ${t.shortTitle()}`, 26),
    desc: clip(`${stripCtrl(params.toolCall?.title || params.toolCall?.name || '工具调用')} · 超时${afterLabel}`, 44),
    options: cardOpts,
    mode: 0,
    submit_text: '提交决定',
    task_id: tid,
  };
  sendText(detail);
  sendCard(cardBlock(card, '**请确认是否允许执行**', `${detail}\n\n请打开企微卡片点击确认。`));
}

function cancelPermissions(t) {
  for (const [id, entry] of uiPending) {
    if (entry.t !== t) continue;
    entry.done = true;
    clearTimeout(entry.timer);
    uiPending.delete(id);
    entry.respond({outcome: 'cancelled'});
  }
  for (const [id, entry] of askPending) {
    if (entry.t !== t) continue;
    entry.done = true;
    clearTimeout(entry.timer);
    askPending.delete(id);
    entry.resolve({decision: 'deny', reason: '任务已取消或结束，无需继续等待作答。'});
  }
}

function hasPendingUi(t) {
  return [...uiPending.values()].some((p) => p.t === t && !p.done)
    || [...askPending.values()].some((p) => p.t === t && !p.done);
}

function normalizeAskQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const out = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue;
    const question = stripCtrl(item.question || '');
    const rawOpts = Array.isArray(item.options) ? item.options : [];
    const options = rawOpts
      .map((o) => stripCtrl(typeof o === 'string' ? o : (o?.label || o?.text || o?.value || '')))
      .filter(Boolean)
      .slice(0, VOTE_OPT_MAX);
    if (!question || !options.length) continue;
    out.push({question, options, multi: Boolean(item.is_multi_select)});
  }
  return out;
}

function formatAskDetail(questions, idx) {
  const q = questions[idx];
  const header = questions.length > 1 ? `**问题 ${idx + 1}/${questions.length}**：${q.question}` : `**${q.question}**`;
  const list = q.options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
  return `${header}${q.multi ? '（可多选）' : ''}\n\n${list}`;
}

function sendAskQuestionCard(entry) {
  const {reqId, t, questions, idx} = entry;
  const q = questions[idx];
  const detail = formatAskDetail(questions, idx);
  const cardOpts = q.options.map((opt, optIdx) => ({
    id: registerPick({act: 'ask', reqId, qIdx: idx, optIdx, optionText: opt, multi: q.multi}),
    text: clip(opt, 60),
  }));
  const titlePrefix = questions.length > 1 ? `❓ 问题 ${idx + 1}/${questions.length}` : '❓ 确认问题';
  const descText = q.multi ? `${q.question} · 可多选` : q.question;
  const card = {
    card_type: 'vote_interaction',
    title: clip(`${titlePrefix} · ${t.shortTitle()}`, 26),
    desc: clip(descText, 44),
    options: cardOpts,
    mode: q.multi ? 1 : 0,
    submit_text: '提交回答',
    task_id: taskId('ask'),
  };
  sendText(detail);
  sendCard(cardBlock(card, '**请选择回答**', `${detail}\n\n请打开企微卡片点击提交。`));
}

function openAskQuestionPrompt(t, questions, resolve) {
  const cfg = liveConfig();
  const timeoutMs = Math.min(cfg.remoteConfirmTimeoutMs, 600_000);
  const reqId = `ask_${crypto.randomUUID()}`;
  const entry = {
    reqId, t, questions, idx: 0, answers: [], resolve, done: false,
    timer: setTimeout(() => {
      if (entry.done) return;
      entry.done = true;
      askPending.delete(reqId);
      resolve({
        decision: 'deny',
        reason: '手机远程作答超时未收到回复，请先采用你的推荐方案或说明待确认项后继续。',
      });
      sendText(plainText({
        head: '⏰ 提问已超时',
        subject: t.label(),
        body: formatAskDetail(questions, entry.idx),
        foot: `超过 ${Math.round(timeoutMs / 60000)} 分钟未作答，已通知模型自行推进`,
      }));
    }, timeoutMs),
  };
  entry.timer.unref?.();
  askPending.set(reqId, entry);
  sendAskQuestionCard(entry);
}

function handleAskPick(picks) {
  const first = picks[0];
  const entry = askPending.get(first.reqId);
  if (!entry || entry.done) return plainText({head: 'ℹ️ 该提问已结束', body: '可能已超时或已在电脑端处理。'});
  if (first.qIdx !== entry.idx) return plainText({head: 'ℹ️ 该题已作答', subject: entry.t.label()});

  const q = entry.questions[entry.idx];
  const selectedTexts = picks.map((p) => p.optionText).filter(Boolean);
  const answerText = selectedTexts.join('、');
  entry.answers.push({question: q.question, selected: selectedTexts});
  entry.idx += 1;

  if (entry.idx < entry.questions.length) {
    sendAskQuestionCard(entry);
    return plainText({
      head: '✅ 已收到回答',
      subject: entry.t.label(),
      body: `已选择：**${answerText}**`,
      foot: `请继续作答第 ${entry.idx + 1}/${entry.questions.length} 题`,
    });
  }

  entry.done = true;
  clearTimeout(entry.timer);
  askPending.delete(entry.reqId);
  const summary = entry.answers
    .map((a, i) => (entry.answers.length > 1 ? `${i + 1}. ${a.question} -> ${a.selected.join(', ')}` : `${a.question} -> ${a.selected.join(', ')}`))
    .join('\n');
  entry.resolve({
    decision: 'deny',
    reason: `用户已通过手机远程回答问题，请直接采纳以下选择继续执行，不要再次调用 ask_question：\n${summary}`,
  });
  return plainText({
    head: '✅ 已提交回答',
    subject: entry.t.label(),
    body: `已选择：**${answerText}**`,
    foot: '任务继续执行中',
  });
}

function handleUiPick(pick) {
  const entry = uiPending.get(pick.reqId);
  if (!entry || entry.done) return plainText({head: 'ℹ️ 该确认请求已结束', body: '可能已超时或已在电脑端处理。'});
  entry.done = true;
  clearTimeout(entry.timer);
  uiPending.delete(pick.reqId);
  if (pick.optionId === 'allow_always' || pick.optionKind === 'allow_always') {
    entry.t.sessionAutoAllow = true;
  }
  entry.respond({outcome: 'selected', optionId: pick.optionId});
  return plainText({
    head: '✅ 已提交确认',
    subject: entry.t.label(),
    body: `已选择：**${pick.optionName}**`,
    foot: '任务继续执行中',
  });
}

// ─────────────────────────── 附件组装与回传格式化（对齐 pi-remote） ───────────────────────────
function composeMediaPrompt(raw, media = []) {
  const promptContent = [];
  const fileNotes = [];
  for (const m of media) {
    if (m.kind === 'image') {
      try {
        const b64 = fs.readFileSync(m.local).toString('base64');
        const ext = path.extname(m.name || '').toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
        promptContent.push({type: 'image', data: b64, mimeType});
        fileNotes.push(`已收到图片：${m.local}（请先查看）`);
        continue;
      } catch {}
    }
    fileNotes.push(`已收到文件：${m.local}`);
  }
  const lead = raw || (media.length ? '（见附件，请先查看）' : '');
  const text = [lead, ...fileNotes].filter(Boolean).join('\n\n');
  promptContent.unshift({type: 'text', text});
  return {textWithPaths: text, promptContent};
}

function syncModelContextWindow(t, model = t?.model || '') {
  if (!t) return;
  const m = String(model || '').trim();
  if (!m) return;
  const inferred = inferModelContextWindow(m);
  if (inferred > 0 && (!t.contextWindow || t.contextWindowModel !== m)) {
    t.contextWindow = inferred;
    t.contextWindowModel = m;
  }
}

function refreshTargetContext(t, explicitTranscriptPath = '') {
  if (!t) return;
  if (explicitTranscriptPath) t.transcriptPath = explicitTranscriptPath;
  if (!t._transcriptUsageCache) t._transcriptUsageCache = {};
  const usage = readContextUsage(liveConfig().agyDataDir, t.sessionId, {
    transcriptPath: t.transcriptPath,
    cache: t._transcriptUsageCache,
  });
  if (usage.found) {
    if (!t.model && usage.model) {
      t.model = usage.model;
      if (!t.thoughtLevel) {
        const ef = extractEffortFromModel(usage.model);
        if (ef) t.thoughtLevel = ef;
      }
    }
    if (typeof usage.usedTokens === 'number' && Number.isFinite(usage.usedTokens)) {
      if (usage.usedTokens > 0) {
        const acpNewer = t.usageUpdatedAt > 0 && t.usageUpdatedAt > usage.mtimeMs + 1000 && t.usedTokensKnown;
        if (!acpNewer) {
          t.usedTokens = usage.usedTokens;
          t.usedTokensKnown = true;
        }
      } else if (!usage.hasTurns && !t.firstInput && !t.busy && !t.usedTokensKnown) {
        t.usedTokens = 0;
        t.usedTokensKnown = true;
      }
    } else if (usage.afterCheckpoint) {
      const acpAfterCompact = t.usageUpdatedAt > 0 && t.usageUpdatedAt >= usage.mtimeMs;
      if (!acpAfterCompact) {
        t.usedTokens = 0;
        t.usedTokensKnown = false;
      }
    }
  }
  syncModelContextWindow(t);
  if (!usage.found && !t.usedTokensKnown && !t.usedTokens && !t.firstInput && !t.busy && t.contextWindow > 0) {
    t.usedTokens = 0;
    t.usedTokensKnown = true;
  }
}

function contextPctLabel(t) {
  refreshTargetContext(t);
  if (!t.contextWindow || (!t.usedTokensKnown && !t.usedTokens)) return '未知';
  return `${((t.usedTokens / t.contextWindow) * 100).toFixed(1)}%`;
}
function contextFullLabel(t) {
  refreshTargetContext(t);
  const win = t.contextWindow
    ? (t.contextWindow >= 1_000_000 ? `${(t.contextWindow / 1_000_000).toFixed(1)}m` : `${Math.round(t.contextWindow / 1000)}k`)
    : '未知';
  const pct = contextPctLabel(t);
  return pct === '未知' ? (win === '未知' ? '未知' : `未知 / ${win}`) : `${pct} / ${win}`;
}

function scanTargetArtifacts(t) {
  const dataDir = liveConfig().agyDataDir;
  const steps = readSteps(transcriptFile(dataDir, t.sessionId));
  return artifacts(steps, {artifactDir: brainDir(dataDir, t.sessionId)});
}
function artHint(t) {
  const list = scanTargetArtifacts(t);
  if (!list.length || list.length === t.lastArtCount) return '';
  t.lastArtCount = list.length;
  return `\n\n\u3000\n\n📎 本会话已有 ${list.length} 个产物，回复 \`产物\` 查看`;
}

function fmtDone(t, run, answerText, {fullyIdle = true} = {}) {
  const foot = [`目录：${dirLabel(t.cwd)}`, `运行：${human((run?.endedAt || Date.now()) - (run?.startedAt || Date.now()))}`];
  const ctx = contextPctLabel(t);
  if (ctx !== '未知') foot.push(`上下文：${ctx}`);
  if (!run?.stopped && !fullyIdle) foot.push('后台任务/子代理仍在运行，完成后将继续推送');
  const body = (answerText || '（无文本输出）').trim() + artHint(t);
  return sessionText(t, {
    head: run?.stopped ? '⚠️ 已中断' : (!fullyIdle ? '⏳ 阶段完成（后台运行中）' : '🏁 任务完成'),
    subject: t.label(),
    body,
    foot: foot.join(' · '),
  });
}

function watchTerminalAcceptance(t, run) {
  if (t.pendingMobileRun !== run) return;
  run.acceptTimer = setTimeout(() => {
    if (t.pendingMobileRun !== run) return;
    t.pendingMobileRun = null;
    run.error = '终端未确认收到消息，请检查电脑上的输入框和任务状态后再决定是否重发。';
    const msg = fmtFail(t, run);
    if (run.settle(msg) && run.asyncPushed) void sendText(msg).catch(() => {});
    if (t.queue.length) {
      void sendText(plainText({head: '⚠️ 排队消息未执行', subject: t.label(), body: `${t.queue.length} 条排队消息已取消，请检查后重发。`})).catch(() => {});
      t.queue = [];
    }
  }, 10_000);
  run.acceptTimer.unref?.();
}

function buildCompactDone(t, run) {
  const instructions = run.operation.instructions;
  const tok = (n) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
  const change = run.beforeTokens && t.usedTokens ? `${tok(run.beforeTokens)} → ${tok(t.usedTokens)}` : '已压缩';
  return stateCard({tag: 'compact', icon: '🗜️', title: '压缩会话',
    desc: instructions ? '已压缩，下一条消息生效' : '已压缩，下一条消息生效 · 发「压缩 说明」指定保留重点',
    emph: {title: change}, emphMax: EMPH_NAME_MAX,
    facts: [{keyname: '会话', value: t.label()}, ...(instructions ? [{keyname: '重点', value: instructions.slice(0, 40)}] : [])],
    fallback: () => plainText({head: '🗜️ 压缩会话', subject: t.label(), body: change, foot: instructions ? `重点：${instructions.slice(0, 40)}` : '发送 `压缩 说明` 指定保留重点'}),
  });
}

function fmtQueued(t) {
  const foot = t.kind === 'tui' && isLiveTarget(t)
    ? '发送 `插话 内容` 可直接纠偏，或 `停止` 中断当前任务并清空队列'
    : '发送 `停止` 中断当前任务并清空队列';
  return sessionText(t, {head: '⏳ 已排队', subject: t.label(), body: `前一轮仍在执行，当前有 ${t.queue.length} 条消息等待处理。`, foot});
}

function displayModel(t, catalog = null) {
  return formatModelLabel(t?.model || '', {configOptions: t?.configOptions, catalog});
}

function fmtAccepted(t, text = '') {
  const foot = [`目录：${dirLabel(t.cwd)}`];
  const modelLabel = displayModel(t);
  if (modelLabel) foot.push(`模型：${modelLabel}`);
  return sessionText(t, {
    head: t.pendingMobileRun ? '⏳ 等待终端接收' : '⏳ 运行中',
    subject: t.label(),
    body: (text ? `> ${clipWidth(stripCtrl(text), 40)}\n\n\u3000\n\n` : '') + (t.pendingMobileRun ? '已发送到终端，等待会话确认接收。' : '已送达，完成后推送'),
    foot: foot.join(' · '),
  });
}

function fmtFail(t, run) {
  return sessionText(t, {
    head: '⚠️ 任务失败',
    subject: t.label(),
    body: `错误：${run.error}`,
    foot: `目录：${dirLabel(t.cwd)} · 运行：${human((run.endedAt || Date.now()) - run.startedAt)}`,
  });
}

// ─────────────────────────── 向会话投递消息（对齐 pi-remote 的 2s 同步等待窗口） ───────────────────────────
function startAcpRun(t, text, media = [], operation = null) {
  t.busy = true;
  const {textWithPaths, promptContent} = composeMediaPrompt(text, media);
  if (!t.firstInput) t.firstInput = stripCtrl(text).slice(0, 80);
  if (!t.customName) triggerAutoNaming(t, text || t.firstInput);
  refreshTargetContext(t);
  const run = makeRun('mobile');
  run.operation = operation;
  run.beforeTokens = t.usedTokens;
  t.currentRun = run;
  t.lastActivity = Date.now();
  writeAcpState();

  (async () => {
    try {
      await ensureAcpSession(t);
      run.startStepCount = readSteps(transcriptFile(liveConfig().agyDataDir, t.sessionId)).length;
      const res = await acp.call('session/prompt', {
        sessionId: t.sessionId,
        prompt: promptContent,
      }, 0);
      refreshTargetContext(t);
      if (res?.usage?.totalTokens && !t.usedTokensKnown) {
        t.usedTokens = res.usage.totalTokens;
        t.usedTokensKnown = true;
        syncModelContextWindow(t);
      }
      const steps = readSteps(transcriptFile(liveConfig().agyDataDir, t.sessionId));
      const last = lastAnswer(steps.slice(run.startStepCount));
      const answer = (run.chunks.join('') || last?.answer || '').trim();
      run.stopped = res?.stopReason === 'cancelled';
      if (res?.stopReason && !['end_turn', 'cancelled'].includes(res.stopReason)) {
        run.error = {max_tokens: '达到输出 Token 上限', max_turn_requests: '达到本轮请求次数上限', refusal: '模型拒绝继续执行'}[res.stopReason] || `本轮未正常完成：${res.stopReason}`;
      }
      t.busy = false;
      t.currentRun = null;
      saveAcpSessions();
      if (run.error && answer) run.error += `\n\n${answer}`;
      const msg = run.error ? fmtFail(t, run) : run.operation?.command === 'compact' && !run.stopped ? buildCompactDone(t, run) : fmtDone(t, run, answer);
      run.settle(msg);
      if (run.asyncPushed) {
        notePush(t);
        void sendText(msg).catch((e) => log(`result delivery failed: ${e.message}`));
      }
    } catch (e) {
      t.busy = false;
      t.currentRun = null;
      const canceled = !e?.exited && /cancel|abort/i.test(e?.message || '');
      run.stopped = canceled;
      run.error = e?.message || String(e);
      const msg = canceled ? fmtDone(t, run, run.chunks.join('').trim() || '任务已中断。') : fmtFail(t, run);
      run.settle(msg);
      if (run.asyncPushed) {
        notePush(t);
        void sendText(msg).catch((e) => log(`result delivery failed: ${e.message}`));
      }
    } finally {
      cancelPermissions(t);
      if (run.error || run.stopped || run.exited) {
        if (t.queue.length) void sendText(plainText({head: '⚠️ 排队消息未执行', subject: t.label(), body: `本轮已结束或失败，${t.queue.length} 条排队消息已取消，请检查状态后重发。`})).catch(() => {});
        t.queue = [];
      }
      if (t.queue.length && !t.busy && t.kind === 'acp') {
        const next = t.queue.shift();
        const nextRun = startAcpRun(t, next.text, next.media);
        nextRun.asyncPushed = true;
      } else if (!t.busy && t.kind === 'acp' && t.pendingHandoff) {
        await completePendingHandoff(t, run);
      } else {
        writeAcpState();
      }
    }
  })();

  return run;
}

async function deliverToTarget(t, text, media = [], ack = {media: false}, {asyncOnly = false} = {}) {
  ack.media = true;
  pushedIds = [];
  bindCurrent(t);
  const {textWithPaths} = composeMediaPrompt(text, media);

  if (t.kind === 'tui' && isLiveTarget(t)) {
    t.loc = refreshTuiLoc(t.pid, t.loc);
    const canInject = injectKind(t.loc);
    if (t.busy || t.pendingMobileRun) {
      t.queue.push({text: textWithPaths, media: []});
      return fmtQueued(t);
    }
    if (canInject) {
      try {
        const run = makeRun('mobile');
        if (asyncOnly) run.asyncPushed = true;
        t.pendingMobileRun = run;
        await injectText(t.loc, textWithPaths);
        if (!t.firstInput) t.firstInput = stripCtrl(text).slice(0, 80);
        if (!t.customName) triggerAutoNaming(t, text || t.firstInput);
        t.lastActivity = Date.now();
        watchTerminalAcceptance(t, run);
        if (asyncOnly) return '';
        const which = await Promise.race([
          run.wait().then(() => 'DONE'),
          new Promise((r) => setTimeout(() => r('TIMEOUT'), SYNC_WINDOW_MS)),
        ]);
        if (which === 'DONE' && run.doneMsg) return run.doneMsg;
        run.asyncPushed = true;
        return fmtAccepted(t, text);
      } catch (e) {
        t.pendingMobileRun = null;
        ack.media = false;
        return plainText({head: '⚠️ 消息未投递', subject: t.label(), body: `终端投递失败：${e.message}`, foot: '请检查终端后重发，或创建后台会话'});
      }
    }
    ack.media = false;
    return plainText({head: '⚠️ 消息未投递', subject: t.label(), body: '当前终端不支持远程输入。请在电脑继续，或关闭该终端会话后从历史会话恢复。', foot: '发送 `创建后台会话` 新建后台任务'});
  }

  if (t.kind === 'history') t.kind = 'acp';
  if (t.busy) {
    t.queue.push({text, media});
    return fmtQueued(t);
  }
  const run = startAcpRun(t, text, media);
  if (asyncOnly) {
    run.asyncPushed = true;
    return '';
  }
  const which = await Promise.race([
    run.wait().then(() => 'DONE'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), SYNC_WINDOW_MS)),
  ]);
  if (which === 'DONE' && run.doneMsg) return run.doneMsg;
  run.asyncPushed = true;
  return fmtAccepted(t, text);
}

// ─────────────────────────── 历史会话扫描（ACP session/list） ───────────────────────────
let histStat = {total: 0, matched: 0, find: ''};
let selectionSnapshot = {ids: [], at: 0};

async function fetchAcpSessions({timeoutMs = 20_000} = {}) {
  try {
    let timer;
    const work = (async () => {
      syncAcpLaunchOptions();
      await acp.start();
      const res = await acp.call('session/list', {}, timeoutMs);
      return Array.isArray(res?.sessions) ? res.sessions : [];
    })();
    if (timeoutMs < 20_000) {
      const guarded = Promise.race([
        work,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve([]), timeoutMs);
          timer.unref?.();
        }),
      ]);
      work.catch(() => {});
      try { return await guarded; } finally { clearTimeout(timer); }
    }
    return await work;
  } catch (e) {
    log(`session/list failed: ${e.message}`);
    return [];
  }
}

async function buildRows({find = '', timeoutMs = 20_000} = {}) {
  const list = await fetchAcpSessions({timeoutMs});
  const savedTitles = loadTitles();
  for (const s of list) {
    if (!s.sessionId) continue;
    const existing = targets.get(s.sessionId);
    const updatedMs = s.updatedAt ? Date.parse(s.updatedAt) || Date.now() : Date.now();
    const customName = savedTitles[s.sessionId]?.title || '';
    if (!existing) {
      targets.set(s.sessionId, makeTarget(s.sessionId, 'history', {
        cwd: s.cwd || os.homedir(),
        name: s.title || '',
        customName,
        updatedAt: updatedMs,
        lastActivity: updatedMs,
      }));
    } else {
      if (customName && !existing.customName) existing.customName = customName;
      if (s.title && !existing.name) existing.name = s.title;
      if (s.cwd && !existing.cwd) existing.cwd = s.cwd;
      existing.updatedAt = Math.max(existing.updatedAt || 0, updatedMs);
    }
  }
  const all = [...targets.values()];
  const live = all.filter((t) => isLiveTarget(t)).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  let hist = all.filter((t) => !isLiveTarget(t)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const total = hist.length;
  const terms = String(find || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    hist = hist.filter((t) => {
      const hay = `${t.customName} ${t.name} ${t.firstInput} ${t.cwd} ${t.sessionId}`.toLowerCase();
      return terms.every((w) => hay.includes(w));
    });
  }
  histStat = {total, matched: hist.length, find};
  return {live, hist: hist.slice(0, HIST_LIST)};
}

// ─────────────────────────── 卡片构建（对齐 pi-remote 的卡片文案与状态卡） ───────────────────────────
function optText(t, extraTag = '') {
  const bits = [t.label()];
  if (t.busy) bits.push('← 运行中');
  if (t.sessionId === currentSessionId) bits.push('← 当前');
  if (extraTag) bits.push(`← ${extraTag}`);
  return clip(bits.join(' · '), 64);
}
const selOpt = (t, held = null) => ({
  id: registerPick({act: 'sel', held, sessionId: t.sessionId}),
  text: optText(t),
});

function renderListFallback(list, title) {
  const lines = list.map((t, idx) => `${idx + 1}. ${optText(t)} · ${ago(t.updatedAt || t.lastActivity)}`);
  return plainText({
    head: '⚠️ 卡片发送失败', subject: title,
    body: lines.join('\n') || '（空）',
    foot: '发送 `选择会话 序号` 直达，如 `选择会话 2`',
  });
}

export function buildLsCard(live) {
  selectionSnapshot = {ids: live.slice(0, VOTE_OPT_MAX).map((t) => t.sessionId), at: Date.now()};
  if (!live.length) {
    return plainText({
      head: '💬 活跃会话 · 0 个',
      body: '现在没有已接入的活跃会话。直接发消息即可新建，也可以先建空白会话或从历史里找。\n（安装前已打开的 agy 终端需重启或新开才会出现）',
      foot: '发送 `创建会话` 新建，或 `历史会话` 找回',
    });
  }
  const options = live.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
  const card = {
    card_type: 'vote_interaction',
    title: clip('💬 活跃会话', 26),
    desc: `活跃 ${live.length} 个 · 发「历史会话」查询历史`,
    options,
    mode: 0,
    submit_text: '选择会话',
    task_id: taskId('ls'),
  };
  return cardBlock(card, '**请选择会话**', () => renderListFallback(live.slice(0, VOTE_OPT_MAX), '活跃会话'));
}

export function buildHistCard(hist) {
  selectionSnapshot = {ids: hist.slice(0, VOTE_OPT_MAX).map((t) => t.sessionId), at: Date.now()};
  const {total, matched, find} = histStat;
  if (find && !hist.length) {
    return plainText({
      head: '🔍 历史检索',
      subject: `“${clip(find, 16)}”`,
      body: '没有找到。只搜会话名和开场白，不搜全文。',
      foot: `已搜 ${total} 个 · 换个词，或发 \`历史会话\` 看最近 ${HIST_LIST} 条`,
    });
  }
  if (!hist.length) {
    return plainText({
      head: '🗂️ 历史会话 · 0 个',
      body: '还没有历史会话记录。',
      foot: '发送 `创建会话` 新建',
    });
  }
  const options = hist.slice(0, VOTE_OPT_MAX).map((t) => selOpt(t));
  const card = {
    card_type: 'vote_interaction',
    title: clip(find ? `🔍 “${find}” 的检索结果` : '🗂️ 历史会话', 26),
    desc: find ? `找到 ${matched} 个 · 显示 ${options.length} 个` : `最近 ${options.length} 个 · 发「历史会话 关键词」搜索`,
    options,
    mode: 0,
    submit_text: '选择会话',
    task_id: taskId('h'),
  };
  return cardBlock(card, '**请选择会话**', () => renderListFallback(hist, find ? `检索“${find}”` : '历史会话'));
}

const RECAP_TIP = '发送「回顾」，查看上一轮内容';

async function buildSelectedCard(t) {
  if (t.kind === 'history') t.kind = 'acp';
  if (t.kind === 'acp' && !t.loaded) {
    try { await ensureAcpSession(t); } catch (e) {
      t.kind = 'history';
      return plainText({head: '⚠️ 打开历史会话失败', subject: t.label(), body: e.message, foot: '发送 `历史会话` 重新选择'});
    }
  }
  bindCurrent(t);
  refreshTargetContext(t);
  const name = t.shortTitle();
  const facts = [
    {keyname: '目录', value: tildeDir(t.cwd)},
    {keyname: '类型', value: kindOf(t)},
    {keyname: '模型', value: displayModel(t) || '未知'},
    {keyname: '上下文', value: contextFullLabel(t)},
  ];
  return stateCard({
    tag: 'selected',
    icon: '📥',
    title: '选择会话',
    desc: t.busy ? '进行中，完成后推送结果' : '已选择，可开始对话',
    emph: {title: name},
    emphMax: EMPH_NAME_MAX,
    body: t.busy ? '' : RECAP_TIP,
    facts,
    fallback: () => plainText({
      head: '📥 选择会话',
      subject: name,
      body: t.busy ? '' : RECAP_TIP,
      foot: facts.map((f) => `${f.keyname}：${f.value}`).join(' · '),
    }),
  });
}

function buildCreatedCard(t, note = '') {
  const name = t.shortTitle();
  const started = Boolean(t.busy || t.pendingMobileRun);
  const facts = [
    {keyname: '目录', value: tildeDir(t.cwd)},
    {keyname: '类型', value: kindOf(t)},
    {keyname: '模型', value: displayModel(t) || '未知'},
  ];
  return stateCard({
    tag: 'created',
    lead: `**✏️ 已创建 ${clip(name, 20)}**`,
    icon: '✏️',
    title: '创建会话',
    desc: started ? '任务已开始，完成后推送结果' : '发「创建会话 目录别名 消息」，指定目录',
    body: note,
    emph: {title: name},
    emphMax: EMPH_NAME_MAX,
    facts,
    fallback: () => plainText({
      head: '✏️ 会话已创建',
      subject: name,
      foot: [`目录：${dirLabel(t.cwd)}`, `类型：${kindOf(t)}`, `模型：${displayModel(t) || '未知'}`, note, started ? '' : '发送 `创建会话 目录别名 消息`，指定目录'].filter(Boolean).join(' · '),
    }),
  });
}

const NO_BIND = () => plainText({
  head: '⚠️ 未选会话',
  body: '还没有选定要操作的会话。',
  foot: '发送 `活跃会话` 选择，或 `创建会话` 新建',
});

async function ensureConfigLoaded(t) {
  if (!t.configOptions?.length) {
    await ensureAcpSession(t);
  }
  return t.configOptions || [];
}

function canInjectTerminalConfig(t, configId) {
  if (t?.kind !== 'tui' || !isLiveTarget(t)) return false;
  if (configId !== 'model' && configId !== 'thought_level') return false;
  t.loc = refreshTuiLoc(t.pid, t.loc);
  return Boolean(injectKind(t.loc));
}

function terminalConfigNotice(t, configId) {
  if (t?.kind !== 'tui' || !isLiveTarget(t)) return null;
  const command = {model: '/model', thought_level: '/effort'}[configId];
  return plainText({head: 'ℹ️ 请在当前终端切换', subject: t.label(),
    body: command ? `当前终端不支持远程注入，请在电脑的 Agy 会话中输入 \`${command}\` 选择。该原生命令也会更新默认模型设置。` : '请在电脑的 Agy 会话中按 `Shift+Tab` 切换执行权限模式。',
    foot: '后台会话或支持远程注入的终端支持在企微卡片中切换'});
}

function readSettingsSnapshot() {
  const file = path.join(liveConfig().agyDataDir, 'settings.json');
  try {
    const stat = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {exists: true, mtimeMs: stat.mtimeMs, model: String(data?.model || '')};
  } catch {
    return {exists: false, mtimeMs: 0, model: ''};
  }
}

async function waitForSettingsModelUpdate(before, timeoutMs = 1200) {
  if (!before?.exists) return before?.model || '';
  const deadline = Date.now() + timeoutMs;
  let latest = before;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    latest = readSettingsSnapshot();
    if (latest.mtimeMs !== before.mtimeMs || latest.model !== before.model) return latest.model;
  }
  return latest.model;
}

async function buildModelCard(t, find = '') {
  if (!t) return NO_BIND();
  const isTui = t.kind === 'tui' && isLiveTarget(t);
  let all = [];
  let currentModel = t.model || '';
  let cliCatalog = null;

  if (isTui) {
    if (!canInjectTerminalConfig(t, 'model')) return terminalConfigNotice(t, 'model');
    if (t.busy || t.pendingMobileRun) {
      return plainText({head: '⚠️ 切换模型失败', subject: t.label(), body: '当前终端会话正在执行任务，请等待完成或先 `停止` 后再切换。'});
    }
    try {
      cliCatalog = await fetchCliModels({bin: liveConfig().agyBin});
    } catch (e) {
      return plainText({head: '⚠️ 无法获取模型列表', subject: t.label(), body: `读取可用模型失败：${e.message}`, foot: '可在电脑终端输入 `/model` 切换'});
    }
    all = cliCatalog.models || [];
    if (!currentModel) {
      const resolved = resolveVariantByDisplayName(cliCatalog, readAgySettings(liveConfig().agyDataDir).model);
      if (resolved) currentModel = resolved.modelId;
    }
  } else {
    try {
      const opts = await ensureConfigLoaded(t);
      const mOpt = configOf(opts, 'model');
      all = mOpt?.options || [];
      currentModel = mOpt?.currentValue || t.model || '';
    } catch (e) {
      return plainText({head: '⚠️ 无法获取模型列表', subject: t.label(), body: e.message});
    }
  }

  if (!all.length) return plainText({head: '⚠️ 无法获取模型列表', subject: t.label(), body: isTui ? 'agy models 未返回可用模型选项。' : 'ACP 未返回可用模型选项。'});
  const q = String(find || '').trim().toLowerCase();
  let filtered = q ? all.filter((o) => `${o.value} ${o.name}`.toLowerCase().includes(q)) : all;
  if (q && !filtered.length && cliCatalog) {
    const variants = cliCatalog.models.flatMap((m) => m.variants || []).filter((v) => `${v.value} ${v.name}`.toLowerCase().includes(q));
    if (variants.length) filtered = variants;
  }
  if (q && filtered.length === 1) return applyConfigOption(t, 'model', filtered[0].value, filtered[0].name);
  if (!filtered.length) return plainText({head: '🔍 没有匹配的模型', subject: `“${clip(find, 16)}”`, body: `共 ${all.length} 个可选模型，没有找到包含该关键词的模型。`, foot: '发送 `模型` 查看全部'});
  const cardOpts = filtered.slice(0, VOTE_OPT_MAX).map((o) => ({
    id: registerPick({act: 'cfg', sessionId: t.sessionId, configId: 'model', value: o.value, label: o.name || o.value}),
    text: clip(`${o.name || o.value}${modelMatchesCurrent(currentModel, o.value, o.name) ? ' · ← 当前' : ''}`, 60),
  }));
  const card = {
    card_type: 'vote_interaction',
    title: clip(`💡 切换模型 · ${t.label()}`, 26),
    desc: q ? `找到 ${filtered.length} 个${filtered.length > VOTE_OPT_MAX ? ` · 显示前 ${VOTE_OPT_MAX} 个` : ''}` : `可选 ${filtered.length} 个${filtered.length > VOTE_OPT_MAX ? ` · 显示前 ${VOTE_OPT_MAX} 个` : ''} · 发「模型 关键词」筛选`,
    options: cardOpts,
    mode: 0,
    submit_text: '切换模型',
    task_id: taskId('model'),
  };
  return cardBlock(card, '**请选择模型**', () => plainText({head: '⚠️ 卡片发送失败', subject: '切换模型', body: filtered.slice(0, VOTE_OPT_MAX).map((o) => `${o.name || o.value}${modelMatchesCurrent(currentModel, o.value, o.name) ? ' · ← 当前' : ''}`).join('\n'), foot: '发送 `模型 模型名` 直接切换'}));
}

async function buildThinkCard(t, arg = '') {
  if (!t) return NO_BIND();
  const isTui = t.kind === 'tui' && isLiveTarget(t);
  let all = [];
  let currentThought = t.thoughtLevel || '';

  if (isTui) {
    if (!canInjectTerminalConfig(t, 'thought_level')) return terminalConfigNotice(t, 'thought_level');
    if (t.busy || t.pendingMobileRun) {
      return plainText({head: '⚠️ 切换思考强度失败', subject: t.label(), body: '当前终端会话正在执行任务，请等待完成或先 `停止` 后再切换。'});
    }
    try {
      const cfg = liveConfig();
      const catalog = await fetchCliModels({bin: cfg.agyBin});
      const settingsModel = readAgySettings(cfg.agyDataDir).model || '';
      const entry = findModelEntry(catalog, t.model) || findModelEntry(catalog, settingsModel);
      all = (entry?.efforts || []).map((v) => ({value: v, name: v}));
      if (!currentThought) currentThought = extractEffortFromModel(t.model) || extractEffortFromModel(settingsModel) || '';
    } catch (e) {
      return plainText({head: '⚠️ 切换思考强度失败', subject: t.label(), body: `读取模型能力失败：${e.message}`, foot: '可在电脑终端输入 `/effort` 切换'});
    }
  } else {
    try {
      const opts = await ensureConfigLoaded(t);
      const thOpt = configOf(opts, 'thought_level');
      all = thOpt?.options || [];
      currentThought = thOpt?.currentValue || t.thoughtLevel || '';
    } catch (e) {
      return plainText({head: '⚠️ 切换思考强度失败', subject: t.label(), body: e.message});
    }
  }

  if (!all.length) return plainText({head: '🧠 当前模型不支持思考强度', subject: `${displayModel(t) || '未知模型'} · ${t.label()}`, foot: '发送 `模型` 换一个支持推理的模型'});
  const CN_TO_EN = {'低': 'low', '中': 'medium', '高': 'high', '超高': 'xhigh', '最高': 'max'};
  const want = CN_TO_EN[arg.trim()] || arg.trim().toLowerCase();
  if (want) {
    const hit = all.find((o) => o.value.toLowerCase() === want);
    if (hit) return applyConfigOption(t, 'thought_level', hit.value, THINK_CN[hit.value] ? `${hit.value} · ${THINK_CN[hit.value]}` : hit.value);
    return plainText({head: '⚠️ 切换思考强度失败', body: `当前模型不支持：${clip(arg, 20)}\n\n可选：${all.map((o) => o.value).join(' / ')}`});
  }
  const cardOpts = all.slice(0, VOTE_OPT_MAX).map((o) => ({
    id: registerPick({act: 'cfg', sessionId: t.sessionId, configId: 'thought_level', value: o.value, label: THINK_CN[o.value] ? `${o.value} · ${THINK_CN[o.value]}` : o.value}),
    text: `${o.value}${THINK_CN[o.value] ? ` · ${THINK_CN[o.value]}` : ''}${o.value === currentThought ? ' · ← 当前' : ''}`,
  }));
  const sample = all.find((o) => o.value !== currentThought && o.value !== 'off')?.value || all[0].value;
  const card = {
    card_type: 'vote_interaction',
    title: clip(`🧠 切换思考强度 · ${t.label()}`, 26),
    desc: clip(`当前 ${currentThought || '未知'} · 发「思考强度 ${sample}」直接切换`, 30),
    options: cardOpts,
    mode: 0,
    submit_text: '切换思考强度',
    task_id: taskId('think'),
  };
  return cardBlock(card, '**请选择思考强度**', () => plainText({head: '⚠️ 卡片发送失败', subject: '切换思考强度', body: cardOpts.map((o) => o.text).join('\n'), foot: `发送 \`思考强度 ${sample}\` 直接切换`}));
}

async function buildModeCard(t, arg = '') {
  const terminalNotice = terminalConfigNotice(t, 'mode');
  if (terminalNotice) return terminalNotice;
  if (!t) return NO_BIND();
  const opts = await ensureConfigLoaded(t);
  const mOpt = configOf(opts, 'mode');
  const all = mOpt?.options || [];
  if (!all.length) return plainText({head: 'ℹ️ 当前会话不支持切换模式', subject: t.label()});
  const want = arg.trim().toLowerCase();
  if (want) {
    const hit = all.find((o) => o.value.toLowerCase() === want);
    if (hit) return applyConfigOption(t, 'mode', hit.value, `${hit.value} · ${MODE_CN[hit.value] || hit.name}`);
  }
  const cardOpts = all.slice(0, VOTE_OPT_MAX).map((o) => ({
    id: registerPick({act: 'cfg', sessionId: t.sessionId, configId: 'mode', value: o.value, label: `${o.value} · ${MODE_CN[o.value] || o.name}`}),
    text: clip(`${o.value} · ${MODE_CN[o.value] || o.name}${o.value === (mOpt?.currentValue || t.mode) ? ' ← 当前' : ''}`, 62),
  }));
  const card = {
    card_type: 'vote_interaction',
    title: clip('⚙️ 切换执行模式', 26),
    desc: clip(`当前：${mOpt?.currentValue || t.mode || 'default'}`, 44),
    options: cardOpts,
    mode: 0,
    submit_text: '切换模式',
    task_id: taskId('mode'),
  };
  return cardBlock(card, '**请选择执行模式**', all.map((o) => `- \`${o.value}\`: ${MODE_CN[o.value] || o.name}`).join('\n'));
}

async function applyConfigOption(t, configId, value, label) {
  const metaMap = {
    model: {icon: '💡', title: '切换模型', retry: '模型'},
    thought_level: {icon: '🧠', title: '切换思考强度', retry: '思考强度'},
    mode: {icon: '⚙️', title: '切换模式', retry: '模式'},
  };
  const {icon, title, retry} = metaMap[configId] || {icon: '✅', title: '配置更新', retry: '状态'};

  if (t?.kind === 'tui' && isLiveTarget(t)) {
    if (!canInjectTerminalConfig(t, configId)) return terminalConfigNotice(t, configId);
    if (t.busy || t.pendingMobileRun) {
      return plainText({head: `⚠️ ${title}失败`, subject: t.label(), body: '当前终端会话正在执行任务，请等待完成或先 `停止` 后再切换。'});
    }
    const slashCmd = configId === 'model' ? `/model ${value}` : `/effort ${value}`;
    const before = readSettingsSnapshot();
    try {
      await injectText(t.loc, slashCmd);
    } catch (e) {
      return plainText({
        head: `⚠️ ${title}失败`,
        subject: t.label(),
        body: `终端投递失败：${e.message}`,
        foot: `请在电脑终端输入 \`${slashCmd}\` 切换`,
      });
    }
    const updatedDisplay = await waitForSettingsModelUpdate(before);
    let catalog = null;
    try { catalog = await fetchCliModels({bin: liveConfig().agyBin}); } catch {}
    const resolved = updatedDisplay && catalog ? resolveVariantByDisplayName(catalog, updatedDisplay) : null;
    if (configId === 'model') {
      if (resolved && modelMatchesCurrent(resolved.modelId, value)) {
        t.model = resolved.modelId;
        t.thoughtLevel = resolved.effort || '';
      } else {
        t.model = value;
        t.thoughtLevel = extractEffortFromModel(value);
      }
    } else if (configId === 'thought_level') {
      t.thoughtLevel = value;
      if (resolved && (!t.model || modelMatchesCurrent(resolved.modelId, stripEffortSuffix(t.model)))) {
        t.model = resolved.modelId;
      } else if (t.model && extractEffortFromModel(t.model)) {
        t.model = `${stripEffortSuffix(t.model)}-${value}`;
      }
    }
    syncModelContextWindow(t);
    refreshTargetContext(t);
    t.lastActivity = Date.now();
    saveTuiSessions();
    const facts = [
      {keyname: '会话', value: t.label()},
      {keyname: '模型', value: displayModel(t, catalog) || '未知'},
      ...(configId === 'thought_level' ? [] : [{keyname: '上下文', value: contextFullLabel(t)}]),
    ];
    return stateCard({
      tag: configId,
      icon,
      title,
      desc: '已切换，下一条消息生效',
      emph: {title: label || value},
      emphMax: EMPH_NAME_MAX,
      facts,
      fallback: () => plainText({
        head: `${icon} ${title}`,
        subject: label || value,
        foot: facts.map((f) => `${f.keyname}：${f.value}`).join(' · '),
      }),
    });
  }

  try {
    await ensureAcpSession(t);
    const option = configOf(t.configOptions, configId);
    if (!option?.options?.some((o) => o.value === value)) {
      return plainText({head: '⚠️ 选项已失效', subject: t.label(), body: '当前模型或会话已不支持这个选项，请重新打开选择卡。', foot: `发送 \`${retry}\` 重新选择`});
    }
    const res = await acp.call('session/set_config_option', {
      sessionId: t.sessionId,
      configId,
      value,
    }, 20_000);
    if (res?.configOptions) syncConfigOptions(t, res.configOptions);
    t.lastActivity = Date.now();
    saveAcpSessions();
  } catch (e) {
    return plainText({
      head: `⚠️ ${title}失败`,
      subject: t.label(),
      body: e?.message || String(e),
      foot: `发送 \`${retry}\` 重新选择`,
    });
  }

  const facts = [
    {keyname: '会话', value: t.label()},
    {keyname: '模型', value: displayModel(t) || '未知'},
    ...(configId === 'thought_level' ? [] : [{keyname: '上下文', value: contextFullLabel(t)}]),
  ];
  return stateCard({
    tag: configId,
    icon,
    title,
    desc: '已切换，下一条消息生效',
    emph: {title: label || value},
    emphMax: EMPH_NAME_MAX,
    facts,
    fallback: () => plainText({
      head: `${icon} ${title}`,
      subject: label || value,
      foot: facts.map((f) => `${f.keyname}：${f.value}`).join(' · '),
    }),
  });
}

function applyDefaultDir(d, via = '') {
  setDefaultDir(d);
  const td = tildeDir(d);
  return stateCard({
    tag: 'cwd',
    icon: '📁',
    title: '切换目录',
    desc: '发「创建会话 目录别名 消息」，指定目录',
    emph: {title: via || path.basename(d) || '~', desc: td},
    emphMax: EMPH_NAME_MAX,
    fallback: () => plainText({
      head: '📁 已切换目录',
      subject: td,
      body: '之后新建会话默认在此目录，已有会话不受影响',
      foot: '发送 `创建会话 目录别名 消息`，指定目录',
    }),
  });
}

function buildDirCard(arg = '') {
  const aliases = loadAliases();
  const cur = defaultDir();
  const want = arg.trim();
  if (want) {
    const hit = Object.hasOwn(aliases, want.toLowerCase()) ? want.toLowerCase() : '';
    const resolved = hit ? expandDir(aliases[hit]) : expandDir(want);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return plainText({head: '⚠️ 切换目录失败', body: `找不到目录：${clip(want, 40)}`, foot: '发送 `目录` 从别名中选择'});
    }
    return applyDefaultDir(resolved, hit);
  }
  const rows = [['~', os.homedir()], ...Object.entries(aliases).map(([n, d]) => [n, path.resolve(expandDir(d))])]
    .filter(([, d], i) => i === 0 || fs.existsSync(d))
    .slice(0, VOTE_OPT_MAX);
  if (rows.length <= 1) {
    return plainText({
      head: '📁 当前目录',
      subject: tildeDir(cur),
      body: '还没有配置目录别名。',
      foot: '在电脑运行 `agy-remote` 或 `agy-remote alias` 添加 · 或发送 `目录 ~/路径`',
    });
  }
  const cardOpts = rows.map(([n, d]) => ({
    id: registerPick({act: 'dir', dir: d, alias: n === '~' ? '' : n}),
    text: clip([n, n === '~' ? '' : tildeDir(d), d === cur ? '← 当前' : ''].filter(Boolean).join(' · '), 60),
  }));
  const card = {
    card_type: 'vote_interaction',
    title: '📁 切换目录',
    desc: '未配置别名的目录，可发「目录 ~/路径」',
    options: cardOpts,
    mode: 0,
    submit_text: '切换目录',
    task_id: taskId('cd'),
  };
  return cardBlock(card, '**请选择目录**', () => plainText({head: '⚠️ 卡片发送失败', subject: '切换目录', body: rows.map(([n, d]) => `${n} · ${tildeDir(d)}${d === cur ? ' · ← 当前' : ''}`).join('\n'), foot: '发送 `目录 别名` 直接切换'}));
}

function buildRecap(t) {
  if (!t) return NO_BIND();
  const steps = readSteps(transcriptFile(liveConfig().agyDataDir, t.sessionId));
  const active = t.currentRun || t.pendingMobileRun;
  const allTurns = turns(t.busy && active ? steps.slice(0, active.startStepCount) : steps);
  if (!allTurns.length) {
    return sessionText(t, {head: '📜 暂无可回顾', subject: t.label(), body: t.busy ? '第一轮还在进行中，完成后推送。' : '这个会话还没有已结束的对话。'});
  }
  const last = allTurns[allTurns.length - 1];
  return sessionText(t, {
    head: '📜 回顾', subject: t.label(),
    body: `> ${clipWidth(stripCtrl(last.question) || '（附件）', 60)}\n\n\u3000\n\n${last.answer || '（无文本输出）'}`,
    foot: [`目录：${dirLabel(t.cwd)}`, t.busy ? '当前任务进行中' : ''].filter(Boolean).join(' · '),
  });
}

async function sendArtifacts(picks) {
  const notes = [];
  for (const pick of picks) {
    let stat;
    try { stat = fs.statSync(pick.file); } catch {}
    if (!stat?.isFile()) notes.push(`${path.basename(pick.file)}：文件已不存在`);
    else if (stat.size > 50 * 1024 * 1024) notes.push(`${path.basename(pick.file)}：超过 50MB，未发送`);
    else await transport.send({file: pick.file});
  }
  return notes.length ? plainText({head: '⚠️ 部分文件未发送', body: notes.join('\n')}) : '';
}

async function handleArtifacts(t) {
  if (!t) return NO_BIND();
  const list = scanTargetArtifacts(t);
  if (!list.length) return plainText({head: '📎 暂无产物', subject: t.label(), body: '本会话还没有生成 HTML / 文档类文件。', foot: '支持：html md pdf docx xlsx pptx png svg'});
  if (list.length <= 3) return sendArtifacts(list);
  const rows = list.slice(0, VOTE_OPT_MAX);
  return cardBlock({card_type: 'vote_interaction', title: '📎 会话产物',
    desc: clip(list.length > rows.length ? `共 ${list.length} 个 · 仅显示最近 ${rows.length} 个` : `共 ${list.length} 个 · 可多选`, 30),
    options: rows.map((x) => ({id: registerPick({act: 'art', file: x.file}), text: clip(`${x.name} · ${fmtSize(x.bytes)} · ${ago(x.mtimeMs)}`, 60)})),
    mode: 1, submit_text: '发送文件', task_id: taskId('art')}, '**请选择要发送的文件**', () => plainText({
      head: '📎 会话产物', subject: t.label(), body: rows.map((x) => `- ${tildeDir(x.file)} · ${fmtSize(x.bytes)}`).join('\n'), foot: '卡片发送失败，请到电脑上取用',
    }));
}

function footerInfo(t) {
  refreshTargetContext(t);
  return [
    `目录：${dirLabel(t.cwd)}`,
    `类型：${kindOf(t)}`,
    `模型：${displayModel(t) || '未知'}${t.thoughtLevel ? ` · ${t.thoughtLevel}` : ''}`,
    `上下文：${contextFullLabel(t)}`,
    ...(t.kind === 'acp' && t.mode ? [`模式：${t.mode}（发 \`模式\` 切换）`] : []),
  ];
}

const mutedFoot = () => (muted ? ['已取关：电脑任务不推送'] : []);
const updateFoot = () => {
  const next = diskVersion();
  return next !== VERSION ? [`Agy Remote 新版本 v${next}，发送 \`重启\` 生效`] : [];
};

function buildStatusPicker() {
  const cur = currentTarget();
  const running = [...targets.values()].filter((t) => isLiveTarget(t) && t.busy && t !== cur).sort((a, b) => b.lastActivity - a.lastActivity);
  if (!running.length) return buildStatus(cur);
  const rows = [...(cur ? [cur] : []), ...running].slice(0, VOTE_OPT_MAX);
  if (rows.length === 1) return buildStatus(rows[0]);
  return cardBlock({card_type: 'vote_interaction', title: '📊 查看状态', desc: `运行中 ${rows.filter((t) => t.busy).length} 个 · 选择要查看的会话`,
    options: rows.map((t) => ({id: registerPick({act: 'status', sessionId: t.sessionId}), text: optText(t)})),
    mode: 0, submit_text: '查看状态', task_id: taskId('status')}, '**请选择会话**', () => plainText({head: '⚠️ 卡片发送失败', subject: '查看状态', body: rows.map((t) => `- ${optText(t)}`).join('\n'), foot: '发送 `活跃会话` 切换后，再发 `状态` 查看'}));
}

function buildStatus(t = currentTarget()) {
  const live = [...targets.values()].filter((x) => isLiveTarget(x));
  if (!t && live.length) t = live[0];
  if (!t) return NO_BIND();
  const info = footerInfo(t).map((l) => `- ${l}`).join('\n');
  const tunnel = transport.connected ? [] : ['企微：断开'];
  const stopHint = t === currentTarget()
    ? (t.kind === 'tui' && isLiveTarget(t) ? '发送 `插话 内容` 纠偏，或 `停止` 停止' : '发送 `停止` 停止')
    : '引用消息，回复会发给该会话';
  if (t.busy || t.pendingMobileRun) {
    const r = t.currentRun || t.pendingMobileRun || {startedAt: Date.now()};
    const steerNote = t.steers?.length ? `，待注入插话 ${t.steers.length} 条` : '';
    return sessionText(t, {
      head: t.pendingMobileRun ? '⏳ 等待终端接收' : '⏳ 运行中',
      subject: t.label(),
      body: `已${t.pendingMobileRun ? '等待' : '运行'} ${human(Date.now() - r.startedAt)}${r.tool ? `，当前动作：${r.tool}` : ''}${steerNote}。\n\n${info}`,
      foot: [...tunnel, ...mutedFoot(), ...updateFoot(), stopHint].join(' · '),
    });
  }
  if (t.bgActive) {
    return sessionText(t, {
      head: '⏳ 后台任务运行中',
      subject: t.label(),
      body: `主轮次已暂停，后台任务或子代理仍在运行，完成后会自动推送。\n\n${info}`,
      foot: [...tunnel, ...mutedFoot(), ...updateFoot()].join(' · '),
    });
  }
  return sessionText(t, {
    head: '🧊 空闲',
    subject: t.label(),
    body: `等你发消息，上次活动 ${ago(t.lastActivity)}。\n\n${info}`,
    foot: [...tunnel, ...mutedFoot(), ...updateFoot()].join(' · '),
  });
}

async function buildUsage(rest = '') {
  try {
    const forceRefresh = /^(?:refresh|刷新)$/i.test(String(rest || '').trim());
    const {groups, fetchedAt} = await fetchCliUsage({
      bin: liveConfig().agyBin || CFG.agyBin,
      useCache: !forceRefresh,
    });
    if (!groups.length) {
      return plainText({
        head: '📊 暂无用量数据',
        body: '当前账号未返回可用额度分组。',
        foot: '可在电脑终端运行 `agy -p "/usage"` 检查',
      });
    }
    return plainText({
      head: '📊 模型用量',
      body: formatUsageBody(groups, {now: fetchedAt, currentModel: currentTarget()?.model || ''}),
      foot: `更新：${formatUsageClock(fetchedAt)} · 发送 \`模型\` 切换模型`,
    });
  } catch (e) {
    return plainText({
      head: '⚠️ 查询用量失败',
      body: e?.message || String(e),
      foot: '稍后发送 `用量` 重试，或在电脑终端运行 `/usage`',
    });
  }
}

function remoteAll() {
  muted = false;
  remoteWatchAll = true;
  saveState({muted: false});
  const cur = currentTarget();
  const rows = [];
  for (const t of targets.values()) {
    if (!isLiveTarget(t) || !t.busy) continue;
    if (t.currentRun) {
      t.currentRun.muted = false;
      t.currentRun.watched = true;
    }
    rows.push(t);
  }
  if (!rows.length) {
    return plainText({head: '📌 关注', body: '目前没有运行中的任务。', foot: '发送 `活跃会话` 选择'});
  }
  const lines = rows.map((t) => {
    const r = t.currentRun;
    const bits = [t.label(), `已运行 ${human(Date.now() - (r?.startedAt || Date.now()))}`];
    if (hasPendingUi(t)) bits.push('等你回答');
    if (t === cur) bits.push('← 当前');
    return `- ${bits.join(' · ')}`;
  });
  return plainText({
    head: `📌 已关注 · ${rows.length} 个运行中会话`,
    body: lines.join('\n'),
    foot: '引用消息，回复会发给相应会话',
  });
}

function muteAll() {
  muted = true;
  remoteWatchAll = false;
  saveState({muted: true});
  const lines = [];
  for (const t of targets.values()) {
    if (!isLiveTarget(t) || !t.busy || !t.currentRun || t.currentRun.origin !== 'desktop') continue;
    t.currentRun.muted = true;
    lines.push(`- ${t.label()} · 已运行 ${human(Date.now() - t.currentRun.startedAt)}`);
  }
  const note = '电脑上发起的任务不再推送，手机发起的照常推送。';
  return plainText({
    head: lines.length ? `🔕 已取关 · ${lines.length} 个运行中会话` : '🔕 已取关',
    body: lines.length ? `${lines.join('\n')}\n\n${note}` : note,
    foot: '发送 `关注` 恢复',
  });
}

async function stopCurrentTask(t = currentTarget()) {
  if (!t) return NO_BIND();
  t.queue = [];
  t.steers = [];
  t.bgActive = false;
  if (!t.busy && !t.pendingMobileRun) {
    return plainText({head: '🧊 无需中断', subject: t.label(), body: '当前会话已空闲。'});
  }
  if (t.currentRun) t.currentRun.stopRequestedAt = Date.now();
  if (t.kind === 'tui') {
    try {
      await injectEscape(t.loc);
      return plainText({head: '🛑 已请求中断', subject: t.label(), body: '已向终端发送 Esc，等待当前轮次结束。'});
    } catch (e) {
      return plainText({head: '⚠️ 无法远程中断该终端', subject: t.label(), body: e.message});
    }
  }
  try {
    cancelPermissions(t);
    acp.notify('session/cancel', {sessionId: t.sessionId});
  } catch (e) { return plainText({head: '⚠️ 中断未送达', subject: t.label(), body: e.message, foot: '发送 `状态` 检查任务'}); }
  return plainText({head: '🛑 已请求中断', subject: t.label(), body: '正在中断当前轮次，结束后推送。'});
}

// ─────────────────────────── 创建终端会话与后台会话（对齐 buildCreatedCard） ───────────────────────────
function splitDirAndMsg(rest) {
  const s = String(rest || '').trim();
  if (!s) return {cwd: defaultDir(), msg: ''};
  const aliases = loadAliases();
  const [first, ...tail] = s.split(/\s+/);
  const tailMsg = tail.join(' ').trim();
  if (aliases[first.toLowerCase()]) {
    return {cwd: expandDir(aliases[first.toLowerCase()]), msg: tailMsg};
  }
  if (first === '~' || first.startsWith('~/') || first.startsWith('/')) {
    const cand = expandDir(first);
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return {cwd: cand, msg: tailMsg};
  }
  return {cwd: defaultDir(), msg: s};
}

async function newBackgroundSession(cwd, msg, media, ack, note = '') {
  const t = await createAcpSession(cwd, effectiveDefaultMode());
  bindCurrent(t);
  if (msg || media?.length) {
    ack.media = true;
    const run = startAcpRun(t, msg || '（见附件，请先查看）', media);
    run.asyncPushed = true;
    await waitForAutoName(t);
  }
  return buildCreatedCard(t, note);
}

async function newTerminalSession(cwd, msg, media, ack) {
  const cfg = liveConfig();
  let term;
  try { term = await resolveTerminal(cfg); } catch (e) {
    return plainText({head: '⚠️ 新建失败', subject: '标签页', body: e.message, foot: '发送 `创建后台会话` 改用后台'});
  }
  if (!term) return newBackgroundSession(cwd, msg, media, ack, '未找到可用终端，已改用后台新建');
  if (term.gui && await screenLocked()) return newBackgroundSession(cwd, msg, media, ack, '屏幕已锁，已改用后台新建');
  // Create an empty native session, release ACP's ownership, then resume it in the TUI.
  // No prompt/model call is made until terminal registration has completed.
  let t;
  try {
    t = await createAcpSession(cwd, effectiveDefaultMode());
    await acp.call('session/close', {sessionId: t.sessionId}, 10_000);
  } catch (e) {
    return plainText({head: '⚠️ 新建失败', subject: term.label, body: e.message, foot: '发送 `创建后台会话` 改用后台'});
  }
  t.loaded = false;
  t.kind = 'history';
  saveAcpSessions();
  writeAcpState();
  const nonce = `tab_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const launcher = fileURLToPath(new URL('../bin/launch-agy.mjs', import.meta.url));
  const agyCmd = [process.execPath, launcher, RUN_DIR, t.sessionId].map(sq).join(' ');
  let cancelWait;
  const claimedPromise = new Promise((resolve) => {
    const timer = setTimeout(() => { pendingTabs.delete(nonce); resolve(null); }, 45_000);
    timer.unref?.();
    cancelWait = () => {clearTimeout(timer); pendingTabs.delete(nonce); resolve(null);};
    pendingTabs.set(nonce, {cwd, sessionId: t.sessionId, createdAt: Date.now(), resolve: (target) => {clearTimeout(timer); resolve(target);}});
  });
  try {
    await term.open({cwd, nonce, agyCmd, kittySocket: cfg.kittySocket, tmuxSession: cfg.tmuxSession || 'agy'});
  } catch (e) {
    cancelWait();
    if (isAutomationPermissionError(e)) {
      targets.delete(t.sessionId);
      saveAcpSessions();
      writeAcpState();
      return newBackgroundSession(
        cwd,
        msg,
        media,
        ack,
        `${term.label} 自动化权限未授权，已改用后台新建（请在电脑「系统设置 › 隐私与安全性 › 自动化」允许）`,
      );
    }
    return plainText({head: '⚠️ 新建失败', subject: term.label, body: e.message, foot: `${term.hint} · 发送 \`创建后台会话\` 改用后台`});
  }
  const claimed = await claimedPromise;
  if (!claimed || !isLiveTarget(claimed)) return plainText({
    head: '⚠️ 标签页未就绪', body: '标签页已经打开，但 45 秒内没等到 agy 注册上来。',
    foot: `目录：${dirLabel(cwd)} · 稍后发送 \`活跃会话\` 查看 · 发送 \`创建后台会话\` 改用后台`,
  });
  bindCurrent(claimed);
  if (msg || media?.length) {
    const delivered = await deliverToTarget(claimed, msg || '（见附件，请先查看）', media, ack, {asyncOnly: true});
    if (!ack.media) return delivered;
    await waitForAutoName(claimed);
  }
  return buildCreatedCard(claimed);
}

async function handleNameCommand(arg = '', t = currentTarget()) {
  const val = String(arg || '').trim();
  const [head = '', ...restParts] = val.split(/\s+/);
  const tail = restParts.join(' ').trim();

  if (head === 'off') {
    writeNamingPref({enabled: false, model: '', source: 'off'});
    return plainText({
      head: '🏷️ 已关闭自动命名',
      body: '新会话不再调用模型生成中文短标题，手机列表显示首条输入或默认名。',
      foot: '发送 `命名 model` 可重新开启',
    });
  }
  if (head === 'model') {
    if (!tail || tail === 'show') {
      return plainText({
        head: '🏷️ 命名模型设置',
        body: `当前自动命名模型：**${namingStatusLabel(liveConfig())}**`,
        foot: '用法：`命名 model <模型ID>` · `命名 model default` · `命名 off`',
      });
    }
    if (tail === 'default' || tail === 'reset') {
      writeNamingPref({source: 'default'});
      return plainText({
        head: '🏷️ 已恢复默认命名模型',
        body: `当前命名模型：**${namingStatusLabel(liveConfig())}**`,
      });
    }
    writeNamingPref({enabled: true, model: tail, source: 'custom'});
    return plainText({
      head: '🏷️ 命名模型已更新',
      subject: tail,
      body: `之后新会话将使用 \`${tail}\` 生成 4–10 字中文标题。`,
    });
  }
  if (!t) return NO_BIND();
  if (!val) {
    return plainText({
      head: '🏷️ 会话命名',
      subject: t.shortTitle(),
      body: [
        `- **当前名称**：${t.shortTitle()}`,
        `- **自动命名模型**：${namingStatusLabel(liveConfig())}`,
      ].join('\n'),
      foot: '发送 `命名 新名称` 改名 · `命名 auto` 重新生成 · `命名 off` 关闭',
    });
  }
  if (val === 'auto') {
    const prompt = t.firstInput || lastAnswer(readSteps(transcriptFile(liveConfig().agyDataDir, t.sessionId)))?.question || '';
    if (!prompt) {
      return plainText({head: '⚠️ 无法自动命名', subject: t.label(), body: '还没有可用于命名的首条用户文本，请直接发送 `命名 新名称`。'});
    }
    const p = triggerAutoNaming(t, prompt, {force: true});
    if (p) await waitForAutoName(t, 10_000);
    if (t.namingStatus !== 'named') return plainText({head: t.namingStatus === 'pending' ? '⏳ 正在生成名称' : '⚠️ 自动命名失败', subject: t.shortTitle(), body: t.namingStatus === 'pending' ? '生成后会同步更新会话名与终端标签。' : '请稍后重试，或发送 `命名 新名称` 手动改名。'});
    return stateCard({
      tag: 'name',
      icon: '🏷️',
      title: '会话已重命名',
      desc: '已同步到终端标签页与企微会话列表',
      emph: {title: t.shortTitle()},
      emphMax: EMPH_NAME_MAX,
      facts: [{keyname: '目录', value: tildeDir(t.cwd)}, {keyname: '来源', value: '自动生成'}],
      fallback: () => plainText({head: '🏷️ 会话已重命名', subject: t.shortTitle()}),
    });
  }
  setSessionTitle(t, val, 'manual');
  return stateCard({
    tag: 'name',
    icon: '🏷️',
    title: '会话已重命名',
    desc: '已同步到终端标签页与企微会话列表',
    emph: {title: t.shortTitle()},
    emphMax: EMPH_NAME_MAX,
    facts: [{keyname: '目录', value: tildeDir(t.cwd)}, {keyname: '来源', value: '手动指定'}],
    fallback: () => plainText({head: '🏷️ 会话已重命名', subject: t.shortTitle()}),
  });
}

// ─────────────────────────── 命令解析与分发 ───────────────────────────
const NL_ALIASES = [
  ['活跃会话', 'ls', false],
  ['查询活跃会话', 'ls', false],
  ['切换会话', 'ls', false],
  ['历史会话', 'h', true],
  ['查询历史会话', 'h', true],
  ['创建会话', 'n', true],
  ['新建会话', 'n', true],
  ['创建后台会话', 'nb', true],
  ['新建后台会话', 'nb', true],
  ['状态', 'status', false],
  ['查询状态', 'status', false],
  ['用量', 'usage', false],
  ['查询用量', 'usage', false],
  ['查看用量', 'usage', false],
  ['额度', 'usage', false],
  ['查询额度', 'usage', false],
  ['查看额度', 'usage', false],
  ['停止', 'stop', false],
  ['停止任务', 'stop', false],
  ['切换模型', 'model', true],
  ['模型', 'model', true],
  ['切换目录', 'cd', true],
  ['目录', 'cd', true],
  ['切换思考强度', 'think', true],
  ['思考强度', 'think', true],
  ['切换模式', 'mode', true],
  ['模式', 'mode', true],
  ['会话命名', 'name', true],
  ['命名', 'name', true],
  ['改名', 'name', true],
  ['重命名', 'name', true],
  ['压缩会话', 'compact', true],
  ['压缩', 'compact', true],
  ['重启服务', 'restart', true],
  ['重启', 'restart', true],
  ['产物', 'art', false],
  ['查看产物', 'art', false],
  ['回顾', 'recap', false],
  ['关注', 'remote', false],
  ['取消关注', 'mute', false],
  ['取关', 'mute', false],
  ['静音', 'mute', false],
  ['插话', 'steer', true],
  ['纠偏', 'steer', true],
  ['帮助', 'help', false],
  ['更多命令', 'more', false],
  ['进阶命令', 'more', false],
  ['全部命令', 'more', false],
  ['更多帮助', 'more', false],
].sort((a, b) => b[0].length - a[0].length);

const COMMANDS = new Set(['ls', 'h', 'n', 'nb', 'model', 'think', 'mode', 'name', 'cd', 'compact', 'restart', 'art', 'recap', 'remote', 'mute', 'steer', 'status', 'usage', 'quota', 'stop', 'help', 'more']);
const BARE_ARGS = new Set(['h', 'n', 'nb', 'model', 'cd', 'think', 'mode', 'name', 'compact', 'restart', 'steer']);

export function parseCmd(text) {
  const t = String(text || '').trim();
  const sel = t.match(/^(?:选择会话|select)\s+(\d+)(?:\s+([\s\S]*))?$/i);
  if (sel) return {cmd: 'select_num', rest: sel[1], ...(sel[2] ? {message: sel[2].trim()} : {})};
  if (/^(?:usage|quota|用量|查询用量|查看用量|额度|查询额度|查看额度)\s+(?:refresh|刷新)$/i.test(t)) {
    return {cmd: 'usage', rest: 'refresh'};
  }
  if (/^(?:help|帮助)\s+(?:more|all|更多|全部|进阶)$/i.test(t)) {
    return {cmd: 'help', rest: 'more'};
  }
  for (const [word, cmd, hasArgs] of NL_ALIASES) {
    if (!t.startsWith(word)) continue;
    const tail = t.slice(word.length);
    if (!tail) return cmd === 'more' ? {cmd: 'help', rest: 'more'} : {cmd, rest: ''};
    if (!hasArgs || !/^\s/.test(tail)) continue;
    return {cmd, rest: tail.trim()};
  }
  const m = t.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const rawCmd = m[1].toLowerCase();
  if (!COMMANDS.has(rawCmd)) return null;
  const rest = (m[2] || '').trim();
  if (rawCmd === 'more') return rest ? null : {cmd: 'help', rest: 'more'};
  const cmd = rawCmd === 'quota' ? 'usage' : rawCmd;
  if (rest && !BARE_ARGS.has(cmd)) return null;
  return {cmd, rest};
}

const helpText = () => [
    "**📖 命令表**",
    "",
    "---",
    "",
    "| 英文 | 中文 |",
    "|---|---|",
    "| n | 创建会话 |",
    "| ls | 活跃会话 |",
    "| remote / mute | 关注 / 取关 |",
    "| model | 模型 |",
    "| think | 思考强度 |",
    "| cd | 目录 |",
    "| compact | 压缩 |",
    "| recap | 回顾 |",
    "| status | 状态 |",
    "| usage | 用量 |",
    "| stop | 停止 |",
    "| help / help all | 帮助 / 更多帮助 |",
    "",
    "",
    "---",
    "",
    "**Tips**",
    "",
    "> 1. 电脑终端 `agy-remote` 配置",
    "> 2. 先发附件，5 分钟内补文字一并发送",
    "> 3. 引用消息，可发送回复给相应会话",
].join("\n");

const moreHelpText = () => [
    "**📖 更多帮助**",
    "",
    "---",
    "",
    "| 英文 | 中文 | 说明 |",
    "|---|---|---|",
    "| nb | 创建后台会话 | 后台 ACP 启动，不依赖终端 |",
    "| h | 历史会话 | 检索并恢复历史会话（可加关键词） |",
    "| steer | 插话 | 终端运行中注入纠偏指令 |",
    "| mode | 模式 | 切换后台会话执行权限模式 |",
    "| name | 命名 | 手动改名或管理自动命名 |",
    "| art | 产物 | 查看或下载当前会话产物 |",
    "| restart | 重启 | 重启服务（`重启 force` 强制） |",
].join("\n");

const quoteRoutes = Array.isArray(loadState().quoteRoutes) ? loadState().quoteRoutes : [];
function sessionText(t, props) {
  const subject = props.subject || t.label();
  const label = clipWidth(subject, 32);
  const i = quoteRoutes.findIndex((r) => r.label === label && r.sessionId === t.sessionId);
  if (i >= 0) quoteRoutes.splice(i, 1);
  quoteRoutes.push({label, sessionId: t.sessionId});
  if (quoteRoutes.length > 300) quoteRoutes.splice(0, quoteRoutes.length - 300);
  saveState({quoteRoutes});
  return plainText({...props, subject});
}

async function quotedTarget(quote) {
  const line = String(quote || '').split('\n', 1)[0].trim().replace(/^#{1,6}\s+/, '');
  const match = /^\S+ [^·]+? · (.+)$/.exec(line);
  if (!match) return null;
  const label = match[1].trim();
  const ids = new Set(quoteRoutes.filter((r) => r.label === label).map((r) => r.sessionId));
  for (const t of targets.values()) if (clipWidth(t.label(), 32) === label) ids.add(t.sessionId);
  if (ids.size === 1) {
    const id = [...ids][0];
    if (!targets.has(id)) await buildRows();
    const target = targets.get(id);
    if (target) return {target};
  }
  return {missed: label};
}

function buildRouteCard(rows, text, media, ack, missed = '') {
  if (!rows.length) return plainText({head: '⚠️ 消息未投递', body: '引用的会话无法确定，请先选择或找回会话后重发。', foot: '发送 `活跃会话` 或 `历史会话` 选择'});
  ack.media = true;
  const content = [text ? clipWidth(text, 36) : '', media.length ? `（${media.length} 个附件）` : ''].join('');
  const pushedLabel = !missed && rows[1] ? clipWidth(rows[1].label(), 18) : '';
  const desc = missed
    ? clip(`找不到「${clipWidth(missed, 20)}」${content ? ` · 消息内容：${content}` : ''}`, 80)
    : clip(`${pushedLabel ? `「${pushedLabel}」刚推送过` : '其他会话推送过结果'}${content ? ` · 消息内容：${content}` : ''}`, 80);
  return cardBlock({
    card_type: 'vote_interaction',
    title: missed ? '✉️ 引用的会话不在，发给哪个？' : '✉️ 发给哪个会话？',
    desc,
    options: rows.slice(0, VOTE_OPT_MAX).map((t, idx) => ({
      id: registerPick({act: 'route', sessionId: t.sessionId, text, media}),
      text: optText(t, !missed && idx === 1 ? '刚推送' : ''),
    })),
    mode: 0,
    submit_text: '发送',
    task_id: taskId('route'),
  }, '', '消息未投递，请发送 `活跃会话` 选择后重发。');
}

function buildNoSessionCard(text, media, ack, hist = []) {
  ack.media = true;
  const cwd = defaultDir();
  const shortDir = tildeDir(cwd);
  const content = [text ? clipWidth(text, 36) : '', media.length ? `（${media.length} 个附件）` : ''].join('');
  const options = [
    {
      id: registerPick({act: 'create', mode: 'tui', cwd, text, media}),
      text: clip(`✏️ 新建终端会话（${shortDir}）`, 64),
    },
    {
      id: registerPick({act: 'create', mode: 'acp', cwd, text, media}),
      text: clip(`⚡ 新建后台会话（${shortDir}）`, 64),
    },
    ...hist.slice(0, Math.min(5, VOTE_OPT_MAX - 2)).map((t) => ({
      id: registerPick({act: 'sel', held: {text, media}, sessionId: t.sessionId}),
      text: optText(t, '历史'),
    })),
  ];
  return cardBlock({
    card_type: 'vote_interaction',
    title: '✉️ 暂无活跃会话，怎么处理？',
    desc: clip(`选择后自动投递${content ? ` · 消息内容：${content}` : ''}`, 80),
    options,
    mode: 0,
    submit_text: '发送',
    task_id: taskId('create'),
  }, '', () => plainText({
    head: '✉️ 暂无活跃会话',
    body: '当前没有打开的会话，可直接新建会话或从历史会话继续。',
    foot: '发送 `创建会话 内容` 或 `创建后台会话 内容` 新建，或 `历史会话` 找回',
  }));
}

export async function handleCommand(text, media = [], ack = {media: false}, {quote = ''} = {}) {
  const quoted = await quotedTarget(quote);
  const qTarget = quoted?.target;
  if (qTarget && qTarget.kind !== 'history' && isLiveTarget(qTarget)) bindCurrent(qTarget);

  const parsed = parseCmd(text);
  if (!parsed) {
    if (quoted?.missed) {
      const cur = currentTarget();
      const live = [...targets.values()].filter(isLiveTarget).sort((a, b) => b.lastActivity - a.lastActivity);
      const ordered = cur ? [cur, ...live.filter((x) => x.sessionId !== cur.sessionId)] : live;
      return buildRouteCard(ordered, text, media, ack, quoted.missed);
    }
    if (qTarget) return deliverToTarget(qTarget, text, media, ack);
    const cur = currentTarget();
    if (!cur) {
      const live = [...targets.values()].filter(isLiveTarget).sort((a, b) => b.lastActivity - a.lastActivity).slice(0, VOTE_OPT_MAX);
      if (!live.length) {
        const {hist} = await buildRows({timeoutMs: 3000});
        return buildNoSessionCard(text, media, ack, hist);
      }
      ack.media = true;
      const options = live.slice(0, VOTE_OPT_MAX - 1).map((t) => selOpt(t, {text, media}));
      const cwd = defaultDir();
      options.push({
        id: registerPick({act: 'create', mode: 'tui', cwd, text, media}),
        text: clip(`➕ 新建会话（${tildeDir(cwd)}）`, 64),
      });
      return cardBlock({
        card_type: 'vote_interaction', title: '✉️ 发给哪个会话？',
        desc: clip(`未绑定会话，选择后投递 · 消息内容：${text || ''}${media.length ? `（${media.length} 个附件）` : ''}`, 80),
        options, mode: 0,
        submit_text: '发送', task_id: taskId('bind'),
      }, '', '消息未投递，请发送 `活跃会话` 选择后重发。');
    }
    const others = !qTarget ? pushedOthers(cur) : [];
    if (others.length) return buildRouteCard([cur, ...others], text, media, ack);
    return deliverToTarget(cur, text, media, ack);
  }

  const {cmd, rest} = parsed;
  if (cmd === 'help') return rest === 'more' ? moreHelpText() : helpText();
  if (cmd === 'ls') {
    const {live} = await buildRows();
    return buildLsCard(live);
  }
  if (cmd === 'h') {
    const {hist} = await buildRows({find: rest});
    return buildHistCard(hist);
  }
  if (cmd === 'select_num') {
    const idx = Number(rest) - 1;
    const rows = selectionSnapshot.ids;
    if (!rows.length || Date.now() - selectionSnapshot.at > CARD_TTL_MS) return plainText({head: '⚠️ 会话列表已失效', foot: '发送 `活跃会话` 或 `历史会话` 重新选择'});
    if (idx < 0 || idx >= rows.length) return plainText({head: '⚠️ 序号超出范围', body: `有效序号：1–${rows.length}`});
    const t = targets.get(rows[idx]);
    if (!t) return NO_BIND();
    if (parsed.message) return deliverToTarget(t, parsed.message, media, ack);
    return buildSelectedCard(t);
  }
  if (cmd === 'n') {
    const {cwd, msg} = splitDirAndMsg(rest);
    return newTerminalSession(cwd, msg, media, ack);
  }
  if (cmd === 'nb') {
    const {cwd, msg} = splitDirAndMsg(rest);
    return newBackgroundSession(cwd, msg, media, ack);
  }
  if (cmd === 'model') return buildModelCard(currentTarget(), rest);
  if (cmd === 'think') return buildThinkCard(currentTarget(), rest);
  if (cmd === 'mode') return buildModeCard(currentTarget(), rest);
  if (cmd === 'name') return handleNameCommand(rest, currentTarget());
  if (cmd === 'cd') return buildDirCard(rest);
  if (cmd === 'compact') {
    const t = currentTarget();
    if (!t) return NO_BIND();
    if (t.kind === 'tui') return plainText({head: 'ℹ️ 当前会话不支持远程压缩', subject: t.label(), body: '请在电脑的 Agy 会话中执行 `/compact`。'});
    if (t.busy) return plainText({head: '⚠️ 压缩会话失败', subject: t.label(), body: '原因：会话正在运行，请等任务结束或先 `停止`'});
    await ensureAcpSession(t);
    if (!t.availableCommands.some((c) => String(c.name).replace(/^\//, '') === 'compact')) return plainText({head: 'ℹ️ 当前会话不支持远程压缩', subject: t.label()});
    const run = startAcpRun(t, rest ? `/compact ${rest}` : '/compact', [], {command: 'compact', instructions: rest});
    await Promise.race([run.wait(), new Promise((r) => setTimeout(r, SYNC_WINDOW_MS))]);
    if (run.doneMsg) return run.doneMsg;
    run.asyncPushed = true;
    return plainText({head: '⏳ 正在压缩', subject: t.label(), body: '完成后推送结果。'});
  }
  if (cmd === 'recap') return buildRecap(currentTarget());
  if (cmd === 'art') return handleArtifacts(currentTarget());
  if (cmd === 'status') return buildStatusPicker();
  if (cmd === 'usage') return buildUsage(rest);
  if (cmd === 'stop') return stopCurrentTask(currentTarget());
  if (cmd === 'steer') return handleSteerCommand(rest, media, ack, currentTarget());
  if (cmd === 'remote') return remoteAll();
  if (cmd === 'mute') return muteAll();
  if (cmd === 'restart') {
    const busyList = [...targets.values()].filter((x) => isLiveTarget(x) && x.busy);
    if (busyList.length && rest.toLowerCase() !== 'force') {
      return plainText({
        head: '⚠️ 有任务正在运行，暂不重启',
        body: busyList.map((x) => `- ${x.label()}`).join('\n'),
        foot: '等任务结束，或发送 `重启 force` 强制重启',
      });
    }
    transport.drain();
    if (process.env.AGY_REMOTE_NO_LISTEN !== '1') {
      setImmediate(() => { void shutdownDaemon(); });
    }
    return plainText({head: '🔄 正在重启 Agy Remote 服务', body: 'launchd 将在数秒内拉起新进程并恢复连接。'});
  }
  return helpText();
}

function handleSteerCommand(rest = '', media = [], ack = {media: false}, t = currentTarget()) {
  const msg = String(rest || '').trim();
  if (!msg && !media?.length) {
    return plainText({
      head: '💬 运行中插话',
      body: '终端任务执行中可随时插入纠偏指令，在下一次模型调用前注入上下文，无需中断重来。',
      foot: '用法：`插话 改用方案 B` 或 `steer 改用方案 B`',
    });
  }
  if (!t) return NO_BIND();
  if (!t.busy && !t.pendingMobileRun) {
    return deliverToTarget(t, msg, media, ack);
  }
  ack.media = true;
  const {textWithPaths} = composeMediaPrompt(msg, media);
  if (t.kind === 'tui' && isLiveTarget(t)) {
    t.steers.push({text: textWithPaths, at: Date.now()});
    return sessionText(t, {
      head: '💬 已加入插话',
      subject: t.label(),
      body: `> ${clipWidth(stripCtrl(msg || '（见附件）'), 40)}\n\n\u3000\n\n将在本轮下一次模型调用前注入上下文（当前待注入 ${t.steers.length} 条）。`,
      foot: '若本轮已无后续工具调用，将在结束时自动续跑',
    });
  }
  t.queue.push({text: msg, media});
  return sessionText(t, {
    head: '⏳ 已加入排队',
    subject: t.label(),
    body: `后台 ACP 会话暂不支持运行中注入，已加入排队（当前 ${t.queue.length} 条），本轮结束后立即执行。`,
    foot: '发送 `停止` 中断当前任务并清空队列',
  });
}

function retryHintForTask(tid = '', pick = null) {
  if (pick) {
    const mapped = {
      sel: '活跃会话',
      route: '活跃会话',
      create: '创建会话',
      cfg: pick.configId === 'model' ? '模型' : pick.configId === 'mode' ? '模式' : '思考强度',
      dir: '目录',
      art: '产物',
      status: '状态',
      ui: '状态',
      ask: '状态',
    }[pick.act];
    if (mapped) return mapped;
  }
  const tag = /^task_([A-Za-z]+)_/.exec(String(tid || ''))?.[1]?.toLowerCase() || '';
  return {
    model: '模型',
    think: '思考强度',
    mode: '模式',
    ls: '活跃会话',
    bind: '活跃会话',
    route: '活跃会话',
    create: '创建会话',
    h: '历史会话',
    cd: '目录',
    art: '产物',
    status: '状态',
    perm: '状态',
    ask: '状态',
  }[tag] || '帮助';
}

async function resolveTargetById(sessionId) {
  if (!sessionId) return null;
  let t = targets.get(sessionId);
  if (!t) {
    await buildRows();
    t = targets.get(sessionId);
  }
  return t || null;
}

export async function handleCardCallback({taskId: tid, optionId, optionIds = []}) {
  const picks = (optionIds.length ? optionIds : [optionId]).map((id) => cardPicks.get(id)).filter(Boolean);
  const pick = picks[0];
  const retry = retryHintForTask(tid, pick);
  if (!tid || !pick || picks.some((p) => p.taskId !== tid || (p.act !== 'ui' && p.act !== 'ask' && Date.now() - p.at > CARD_TTL_MS)) || picks.length !== (optionIds.length || 1)) {
    return plainText({head: '⚠️ 卡片已失效', foot: `发送 \`${retry}\` 重新选择`});
  }
  if (pick.act !== 'art' && !(pick.act === 'ask' && pick.multi) && picks.length !== 1) return '这张卡片只能选择一项，请重新选择。';
  if (consumeTask(tid)) return `这张卡片已经提交过，请发送 \`${retry}\` 获取新卡片。`;

  if (pick.act === 'create') {
    const cwd = pick.cwd && fs.existsSync(pick.cwd) ? pick.cwd : defaultDir();
    const deliveryAck = {media: false};
    return pick.mode === 'acp'
      ? newBackgroundSession(cwd, pick.text || '', pick.media || [], deliveryAck)
      : newTerminalSession(cwd, pick.text || '', pick.media || [], deliveryAck);
  }
  if (pick.act === 'sel') {
    const t = await resolveTargetById(pick.sessionId);
    if (!t || (t.kind !== 'history' && !isLiveTarget(t))) return plainText({head: '⚠️ 会话已关闭', foot: '发送 `活跃会话` 重新选择'});
    if (pick.held) {
      if (hasPendingUi(t)) {
        bindCurrent(t);
        return plainText({head: '📥 已切换', subject: t.label(), body: '待答的问题已推送，请先在卡片上作答。这条消息没有投递，需要的话请重发。'});
      }
      return deliverToTarget(t, pick.held.text, pick.held.media, {media: true});
    }
    return buildSelectedCard(t);
  }
  if (pick.act === 'cfg') {
    const t = await resolveTargetById(pick.sessionId);
    if (!t) return NO_BIND();
    if (t.kind === 'history') t.kind = 'acp';
    return applyConfigOption(t, pick.configId, pick.value, pick.label);
  }
  if (pick.act === 'status') return buildStatus(await resolveTargetById(pick.sessionId));
  if (pick.act === 'dir') {
    if (!fs.existsSync(pick.dir) || !fs.statSync(pick.dir).isDirectory()) return plainText({head: '⚠️ 切换目录失败', body: '目录已不存在', foot: '发送 `目录` 重新选择'});
    return applyDefaultDir(pick.dir, pick.alias);
  }
  if (pick.act === 'art') return sendArtifacts(picks);
  if (pick.act === 'route') {
    const t = await resolveTargetById(pick.sessionId);
    if (!t) return NO_BIND();
    return deliverToTarget(t, pick.text, pick.media || [], {media: true});
  }
  if (pick.act === 'ui') {
    return handleUiPick(pick);
  }
  if (pick.act === 'ask') {
    return handleAskPick(picks);
  }
  return '';
}

// ─────────────────────────── Hook HTTP 接口（接收终端会话上报 + PreToolUse 远程确认） ───────────────────────────
export function resolveHookCwd(body = {}, existingCwd = '') {
  const clean = (p) => (typeof p === 'string' ? p.trim() : '');
  const isRoot = (p) => p === '/' || p === path.sep;
  const rawCwd = clean(body.cwd);
  const workspaces = Array.isArray(body.workspacePaths) ? body.workspacePaths.map(clean).filter(Boolean) : [];
  const specificWs = workspaces.find((p) => !isRoot(p)) || '';
  if (rawCwd && !isRoot(rawCwd)) return rawCwd;
  if (specificWs) return specificWs;
  const prev = clean(existingCwd);
  if (prev && !isRoot(prev)) return prev;
  return rawCwd || workspaces[0] || os.homedir();
}

export async function handleAttachEvent(body = {}) {
  const sid = String(body.conversationId || '').trim();
  const pid = Number(body.pid) || 0;
  const loc = body.loc || {};
  const totalTokens = Number(body.totalTokens) || 0;
  const refreshed = Boolean(body.refreshed);
  if (!sid) return {ok: true, action: 'noop'};
  const existing = targets.get(sid);
  if (refreshed) {
    if (existing?.handoffCompleted) {
      existing.handoffCompleted = null;
      updateTargetTabStatus(existing, existing.busy ? 'running' : 'idle', {
        tabTitleEnabled: readNamingPref(liveConfig()).enabled,
      });
      writeAcpState();
      return {ok: true, action: 'cleared'};
    }
    return {ok: true, action: 'noop'};
  }
  if (!existing) return {ok: true, action: 'noop', kind: 'none'};
  if (existing.kind === 'tui') {
    if (existing.handoffCompleted && totalTokens > 0 && totalTokens > (existing.handoffCompleted.snapshotTokens || 0)) {
      existing.handoffCompleted = null;
      updateTargetTabStatus(existing, existing.busy ? 'running' : 'idle', {
        tabTitleEnabled: readNamingPref(liveConfig()).enabled,
      });
      writeAcpState();
      return {ok: true, action: 'cleared'};
    }
    return {ok: true, action: 'noop', kind: 'tui'};
  }
  if (existing.kind !== 'acp') return {ok: true, action: 'noop', kind: existing.kind};

  if (existing.busy) {
    registerPendingHandoff(existing, {
      pid,
      loc,
      cwd: resolveHookCwd(body, existing.cwd),
      transcriptPath: body.transcriptPath || '',
      totalTokens,
    });
    return {
      ok: true,
      action: 'waiting',
      busy: true,
      startedAt: existing.currentRun?.startedAt || existing.lastActivity,
      tool: existing.currentRun?.tool || '',
    };
  }

  if (existing.loaded) {
    try {
      await acp.call('session/close', {sessionId: sid}, 10_000);
      existing.loaded = false;
    } catch (e) {
      return {ok: false, action: 'error', error: e.message};
    }
  }
  const t = getOrCreateTarget(sid, 'tui', {
    cwd: resolveHookCwd(body, existing.cwd),
    pid,
    loc,
    transcriptPath: body.transcriptPath || '',
  });
  t.pendingHandoff = null;
  t.handoffCompleted = null;
  t._lastHandoffTabTitle = '';
  refreshTargetContext(t, body.transcriptPath || '');
  updateTargetTabStatus(t, 'idle', {tabTitleEnabled: readNamingPref(liveConfig()).enabled});
  writeAcpState();
  log(`hand off idle acp -> tui id=${sid.slice(0, 8)} pid=${t.pid}`);
  return {ok: true, action: 'handed_off', busy: false};
}

export async function handleHookEvent(body) {
  const sid = body.conversationId;
  if (!sid) return {};
  const ev = body.hookEventName;
  const existing = targets.get(sid);
  const cwd = resolveHookCwd(body, existing?.cwd || '');
  const model = body.modelName && body.modelName !== 'auto' ? body.modelName : '';
  const input = stripCtrl(body.lastUserInput || '');

  if (ev === 'RemoteExit') {
    const t = targets.get(sid);
    if (!t || t.pid !== body.pid) return {};
    if (body.error && !t.currentRun && !t.pendingMobileRun) void sendText(plainText({head: '⚠️ 标签页已关闭', subject: t.label(), body: body.error, foot: '发送 `历史会话` 找回会话'})).catch(() => {});
    const run = t.currentRun || t.pendingMobileRun;
    clearTimeout(run?.acceptTimer);
    cancelPermissions(t);
    updateTargetTabStatus(t, 'idle', {tabTitleEnabled: false});
    t.kind = 'history'; t.loaded = false; t.busy = false; t.bgActive = false;
    t.currentRun = null; t.pendingMobileRun = null;
    t.pendingHandoff = null; t.handoffCompleted = null; t._lastHandoffTabTitle = '';
    saveTuiSessions();
    writeAcpState();
    if (run && !run.settled) {
      run.error = body.error || '终端已关闭，本轮未收到结束回传。';
      const msg = fmtFail(t, run);
      if (run.settle(msg) && run.asyncPushed) void sendText(msg).catch(() => {});
    }
    if (t.queue.length || t.steers.length) void sendText(plainText({head: '⚠️ 排队消息未执行', subject: t.label(), body: '终端已关闭，请选择会话后重发。'})).catch(() => {});
    t.queue = [];
    t.steers = [];
    return {};
  }

  let handedOffFromAcp = false;
  if (existing?.kind === 'acp') {
    const blocked = (message) => ({
      injectSteps: [{systemMessage: {systemMessage: '', metadata: {user_markdown: message}}}],
      ...(ev === 'PreInvocation' ? {terminationBehavior: 'terminate'} : {}),
    });
    if (existing.busy) {
      if (ev === 'Stop') return {};
      if (ev === 'PreToolUse') return {decision: 'deny', reason: '同一会话仍在后台执行，请等它结束后重试。'};
      registerPendingHandoff(existing, {
        pid: body.pid || 0,
        loc: body.loc || {},
        cwd,
        transcriptPath: body.transcriptPath || '',
      });
      const run = existing.currentRun;
      const detailBits = [];
      if (run?.startedAt) detailBits.push(`已运行 ${human(Date.now() - run.startedAt)}`);
      if (run?.tool) detailBits.push(`当前动作：\`${run.tool}\``);
      const detail = detailBits.length ? `（${detailBits.join(' · ')}）` : '';
      return blocked(`⏳ 该会话仍在后台执行${detail}，本条消息暂未发出。完成后将自动交接给当前终端并提醒，届时请输入 \`/resume\` 重新选择本会话刷新画面；也可在企微发送「停止」中断。`);
    }
    if (existing.loaded) {
      try {
        await acp.call('session/close', {sessionId: sid}, 10_000);
        existing.loaded = false;
      } catch (e) {
        return blocked(`⚠️ 后台会话尚未释放，暂不能接到终端：${e.message}`);
      }
    }
    existing.pendingHandoff = null;
    existing.handoffCompleted = null;
    existing._lastHandoffTabTitle = '';
    handedOffFromAcp = true;
  }

  const t = getOrCreateTarget(sid, 'tui', {
    cwd,
    model,
    firstInput: input,
    pid: body.pid || 0,
    loc: body.loc || {},
    transcriptPath: body.transcriptPath || '',
  });
  if (handedOffFromAcp) writeAcpState();
  refreshTargetContext(t, body.transcriptPath || '');

  if (body.nonce && pendingTabs.has(body.nonce) && pendingTabs.get(body.nonce).sessionId === sid) {
    const tab = pendingTabs.get(body.nonce);
    pendingTabs.delete(body.nonce);
    tab.resolve(t);
  }

  if (ev === 'SessionStart') {
    const cfg = liveConfig();
    log(`hook SessionStart id=${sid.slice(0, 8)} cwd=${tildeDir(cwd)} tty=${t.loc?.tty || '-'}`);
    if (input && !t.customName) triggerAutoNaming(t, input);
    updateTargetTabStatus(t, t.busy ? 'running' : t.runStatus || 'idle', {tabTitleEnabled: readNamingPref(cfg).enabled});
    return {};
  }

  if (ev === 'PreInvocation') {
    const cfg = liveConfig();
    if (input && !t.customName) triggerAutoNaming(t, input);
    if (t.handoffCompleted) {
      t.handoffCompleted = null;
      writeAcpState();
    }
    t.bgActive = false;
    if (!t.busy) {
      clearTimeout(t.pendingMobileRun?.acceptTimer);
      t.busy = true;
      t.currentRun = t.pendingMobileRun || makeRun('desktop');
      const steps = readSteps(body.transcriptPath || transcriptFile(cfg.agyDataDir, sid));
      const lastUser = steps.findLastIndex((st) => st.type === 'USER_INPUT');
      t.currentRun.startStepCount = lastUser >= 0 ? lastUser : steps.length;
      t.pendingMobileRun = null;
    }
    updateTargetTabStatus(t, 'running', {tabTitleEnabled: readNamingPref(cfg).enabled});
    if (t.steers.length) {
      const drained = t.steers.splice(0, t.steers.length);
      return {
        injectSteps: drained.map((s) => ({
          userMessage: `[来自企微手机运行中插话]: ${s.text}`,
        })),
      };
    }
    return {};
  }

  if (ev === 'PreToolUse') {
    const tc = body.toolCall || {};
    if (t.currentRun) t.currentRun.tool = tc.name || '';
    const isMobileTurn = t.currentRun?.origin === 'mobile';
    // 电脑端自己操作的轮次（即使开启了「关注」）直接返回 ask 交给电脑终端自身决定，不阻塞电脑端操作
    if (!isMobileTurn) return {decision: 'ask'};
    if (tc.name === 'ask_question') {
      const questions = normalizeAskQuestions(tc.args?.questions || tc.rawInput?.questions);
      if (!questions.length) return {decision: 'ask'};
      return new Promise((resolve) => {
        openAskQuestionPrompt(t, questions, resolve);
      });
    }
    if (shouldAutoAllowPermission(tc, t)) return {decision: 'allow'};

    return new Promise((resolve) => {
      openPermissionPrompt(
        t,
        {
          sessionId: sid,
          toolCall: {name: tc.name, title: `${tc.name}`, args: tc.args},
          options: [
            {optionId: 'allow', kind: 'allow_once', name: '允许执行'},
            {optionId: 'allow_always', kind: 'allow_always', name: '本会话始终允许'},
            {optionId: 'deny', kind: 'reject_once', name: '拒绝执行'},
          ],
        },
        (outcome) => {
          if (outcome?.optionId === 'allow' || outcome?.optionId === 'allow_always') resolve({decision: 'allow'});
          else resolve({decision: 'deny', reason: outcome?.outcome === 'cancelled' ? '确认请求已取消或任务已结束' : '远程权限确认未允许该操作'});
        },
      );
    });
  }

  if (ev === 'Stop') {
    const cfg = liveConfig();
    const run = t.currentRun || t.pendingMobileRun || makeRun('desktop');
    clearTimeout(t.pendingMobileRun?.acceptTimer);
    t.pendingMobileRun = null;
    t.busy = false;
    t.currentRun = null;

    const steps = readSteps(body.transcriptPath || transcriptFile(cfg.agyDataDir, sid));
    const last = lastAnswer(steps);
    if (last?.question && !t.firstInput) t.firstInput = clip(last.question, 80);
    refreshTargetContext(t, body.transcriptPath || '');
    saveTuiSessions();

    const termReason = String(body.terminationReason || '');
    const canceled = termReason === 'USER_CANCELED';
    const errored = Boolean(body.error) || ['ERROR', 'MAX_INVOCATIONS', 'MAX_TOKEN_BUDGET_EXCEEDED'].includes(termReason);
    const stillRunningBg = !canceled && !errored && body.fullyIdle === false;
    t.bgActive = stillRunningBg;
    run.stopped = canceled;
    if (errored) run.error = body.error || termReason;
    updateTargetTabStatus(t, canceled ? 'idle' : errored ? 'error' : stillRunningBg ? 'running' : 'done', {tabTitleEnabled: readNamingPref(cfg).enabled});
    if (t.customName) {
      syncSummaryDbTitle(cfg.agyDataDir, sid, t.customName);
      setTimeout(() => syncSummaryDbTitle(liveConfig().agyDataDir, sid, t.customName), 1500).unref?.();
    }

    cancelPermissions(t);
    const current = lastAnswer(steps.slice(run.startStepCount));
    const msg = errored
      ? fmtFail(t, run)
      : fmtDone(t, run, current?.answer || (canceled ? '任务已中断。' : '（本轮无文本输出）'), {fullyIdle: !stillRunningBg});
    run.settle(msg);

    const shouldPush = (run.origin === 'mobile' && run.asyncPushed)
      || (run.origin === 'desktop' && !run.muted && (remoteWatchAll || sid === currentSessionId));

    if (shouldPush && msg) {
      notePush(t);
      void sendText(msg);
    }

    if (canceled || errored) {
      const dropped = t.queue.length + t.steers.length;
      if (dropped) void sendText(plainText({head: '⚠️ 排队消息未执行', subject: t.label(), body: `${dropped} 条排队消息已取消，请检查后重发。`})).catch(() => {});
      t.queue = [];
      t.steers = [];
    }
    if (!stillRunningBg && t.steers.length) {
      const leftover = t.steers.splice(0, t.steers.length);
      t.queue.unshift({text: leftover.map((s) => s.text).join('\n\n'), media: []});
    }
    if (!stillRunningBg && t.queue.length && (injectKind(t.loc) || !body.continuationActive)) {
      const next = t.queue.shift();
      if (injectKind(t.loc)) {
        const nextRun = makeRun('mobile');
        nextRun.asyncPushed = true;
        t.pendingMobileRun = nextRun;
        setTimeout(() => {
          injectText(t.loc, next.text).then(() => watchTerminalAcceptance(t, nextRun)).catch((e) => {
            t.pendingMobileRun = null;
            nextRun.error = e.message;
            nextRun.settle(fmtFail(t, nextRun));
            void sendText(nextRun.doneMsg).catch(() => {});
          });
        }, 300);
      } else if (!body.continuationActive) {
        const nextRun = makeRun('mobile');
        nextRun.asyncPushed = true;
        t.busy = true;
        t.currentRun = nextRun;
        return {decision: 'continue', reason: `[来自企微远程消息]: ${next.text}`};
      }
    }
    return {};
  }

  return {};
}

// ─────────────────────────── 企微传输与本地 HTTP 服务 ───────────────────────────
const PRIORITY_COMMANDS = new Set(['stop', 'status', 'help', 'usage', 'remote', 'mute', 'steer']);
export function isPriorityCardEvent(ev) {
  return /^task_(?:perm|ask)_/.test(String(ev?.task_id || ''));
}
export function isPriorityCommandText(text) {
  const parsed = parseCmd(text);
  return Boolean(parsed && PRIORITY_COMMANDS.has(parsed.cmd));
}

export const transport = new WeComTransport({
  config: CFG,
  dir: RUN_DIR,
  log,
  onBind: async (userid) => saveOwner(userid),
  onMessage: (text, media, ack, meta) => handleCommand(text, media, ack, meta),
  onCard: (ev) => handleCardCallback(ev),
  isPriorityCard: isPriorityCardEvent,
  isPriorityMessage: isPriorityCommandText,
  onKickExhausted: (msg) => notifyDesktop('Agy Remote 已断开', msg),
});

function sendText(msg) { return transport.send(msg); }
function sendCard(block) { return transport.send(block); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.headers['x-agy-token'] !== TOKEN) return sendJson(res, 401, {error: 'unauthorized'});
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    const live = [...targets.values()].filter((t) => isLiveTarget(t));
    return sendJson(res, 200, {
      service: 'agy-remote-wecom',
      version: VERSION,
      diskVersion: diskVersion(),
      wecom: transport.status(),
      acpAlive: acp.alive,
      currentSessionId,
      muted,
      targets: live.map((t) => ({
        sessionId: t.sessionId,
        kind: t.kind,
        label: t.label(),
        cwd: t.cwd,
        model: t.model,
        mode: t.mode,
        busy: t.busy,
      })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const reply = await handleHookEvent(body);
      return sendJson(res, 200, reply);
    } catch (e) {
      return sendJson(res, 400, {error: e.message});
    }
  }
  if (req.method === 'POST' && url.pathname === '/attach') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const reply = await handleAttachEvent(body);
      return sendJson(res, 200, reply);
    } catch (e) {
      return sendJson(res, 400, {error: e.message});
    }
  }
  if ( req.method === 'POST' && url.pathname === '/name') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const t = body.sessionId ? targets.get(body.sessionId) : currentTarget();
      const reply = await handleNameCommand(body.arg || '', t);
      return sendJson(res, 200, {
        ok: true,
        sessionId: t?.sessionId || '',
        title: t?.shortTitle() || '',
        namingModel: namingStatusLabel(liveConfig()),
        reply,
      });
    } catch (e) {
      return sendJson(res, 400, {error: e.message});
    }
  }
  return sendJson(res, 404, {error: 'not found'});
});

setInterval(() => {
  const now = Date.now();
  const idleCloseMs = liveConfig().idleCloseMs;
  let changed = false;
  for (const t of targets.values()) {
    if (t.kind === 'acp' && !t.busy && t.sessionId !== currentSessionId && now - t.lastActivity > idleCloseMs) {
      t.kind = 'history';
      t.loaded = false;
      changed = true;
    }
  }
  if (changed) {
    saveAcpSessions();
    writeAcpState();
  }
}, 600_000).unref();

let shuttingDown = false;
export async function shutdownDaemon({exit = process.env.AGY_REMOTE_NO_LISTEN !== '1', timeoutMs = 5000} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('daemon shutting down');
  writeAcpState({clear: true});
  transport.drain();
  acp.stop();
  try { server.close(); } catch {}
  await Promise.race([
    (async () => {
      try { await transport.waitIdle(); } catch {}
      try { await transport.flush(); } catch {}
    })(),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  transport.stop();
  if (exit) process.exit(0);
}

if (process.env.AGY_REMOTE_NO_LISTEN !== '1') {
  server.listen(CFG.localPort, '127.0.0.1', () => {
    log(`daemon up v${VERSION} port=${CFG.localPort}`);
    if (CFG.botId && CFG.secret) transport.start();
    else log('未配置 botId/secret，仅启动本地 HTTP 服务');
  });
  process.on('SIGTERM', () => { void shutdownDaemon(); });
  process.on('SIGINT', () => { void shutdownDaemon(); });
}
