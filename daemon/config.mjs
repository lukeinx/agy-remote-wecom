import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const RUN_DIR = process.env.AGY_REMOTE_HOME || path.join(os.homedir(), '.config', 'agy-remote-wecom');
export const CONFIG_FILE = path.join(RUN_DIR, 'config.json');
export const WELCOME_FILE = 'welcome.json'; // 已发送主动欢迎的标记
export const RESTART_FILE = 'restart.json'; // 待通知的重启标记：优雅退出前写入，下次连上后消费一次
export const RESTART_NOTICE_TTL_MS = 10 * 60 * 1000; // 停止后长期未启动则不再通知
export const BIND_FILE = 'bind.json'; // 待绑定的一次性绑定码
export const BIND_TTL_MS = 10 * 60 * 1000;
export const BIND_MAX_FAILURES = 5;

// 版本唯一来源为 package.json，避免升级后 startService 误判已是新版而跳过重启。
const PACKAGE_JSON = new URL('../package.json', import.meta.url);
export const VERSION = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;

/** 每次现读磁盘：已运行的进程借此发现升级后尚未生效的新版本。 */
export function diskVersion() {
  try { return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || VERSION; } catch { return VERSION; }
}

export const DEFAULT_TAB_TITLE = {
  enabled: true,
  apiUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  thinking: 'off', // 'off' | 'low'
};

export const VALID_TERMINALS = ['auto', 'cmux', 'ghostty', 'iterm', 'wezterm', 'kitty', 'tmux', 'terminal', 'none'];

export const DEFAULTS = {
  botId: '',
  secret: '',
  ownerUserId: '',
  terminal: 'auto',
  defaultDir: '~',
  defaultMode: 'default',
  remoteConfirm: 'ask-then-allow',
  remoteConfirmTimeoutMs: 600000,
  aliases: {home: '~'},
  tabTitle: {...DEFAULT_TAB_TITLE},
  localPort: 18779,
  tmuxSession: 'agy',
  kittySocket: '',
  agyBin: 'agy',
  acpProcessPerSession: true,
  inboxDir: path.join(RUN_DIR, 'inbox'),
  agyDataDir: process.env.AGY_REMOTE_HOME
    ? path.join(RUN_DIR, 'agy-data')
    : path.join(os.homedir(), '.gemini', 'antigravity-cli'),
  idleCloseMs: 6 * 3600 * 1000,
  nameWaitMs: 5000,
  // 兼容旧字段
  tabTitleEnabled: true,
  namingModel: 'deepseek-v4.1-flash',
};

/** 去除 JSONC 中的单行（//）与块级（/* ... *\/）注释，严格跳过字符串字面量内部（如 https://）。 */
export function stripJsonComments(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      if (i < src.length) out += src[i];
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n' || src[i] === '\r') out += src[i];
        i += 1;
      }
      if (i < src.length) i += 1; // skip '/'
      continue;
    }
    out += ch;
  }
  return out;
}

/** 去除对象/数组末尾允许的尾随逗号（仅处理字符串外部）。 */
export function stripTrailingCommas(text) {
  const src = String(text ?? '');
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === '}' || src[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** 判断文本中在字符串外部是否包含 JSONC 注释（避免把 "https://" 误判为注释）。 */
export function hasJsonComments(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      if (ch === '\\' && i + 1 < src.length) i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && (next === '/' || next === '*')) return true;
  }
  return false;
}

/** 解析 JSON / JSONC（支持 //、/* *\/ 注释与尾随逗号）。 */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function indentMultilineJson(value, baseIndent) {
  const raw = JSON.stringify(value, null, 2);
  return raw.split('\n').map((line, idx) => (idx === 0 ? line : `${baseIndent}${line}`)).join('\n');
}

function formatObjectEntries(entries, indent = '  ') {
  const lines = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const comma = i < entries.length - 1 ? ',' : '';
    if (entry.beforeBlank && lines.length) lines.push('');
    for (const c of entry.comments || []) lines.push(`${indent}// ${c}`);
    if (entry.rawLines) {
      for (let j = 0; j < entry.rawLines.length; j += 1) {
        const suffix = j === entry.rawLines.length - 1 ? comma : '';
        lines.push(`${indent}${entry.rawLines[j]}${suffix}`);
      }
    } else {
      lines.push(`${indent}${JSON.stringify(entry.key)}: ${indentMultilineJson(entry.value, indent)}${comma}`);
    }
  }
  return lines;
}

/** 将配置对象渲染为分段清晰、带中文注释的 JSONC 配置文件内容。 */
export function formatConfigJsonc(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const aliases = src.aliases ?? src.dirAliases ?? DEFAULTS.aliases;
  const rawTab = src.tabTitle && typeof src.tabTitle === 'object' && !Array.isArray(src.tabTitle) ? src.tabTitle : null;
  const tabEnabled = typeof rawTab?.enabled === 'boolean'
    ? rawTab.enabled
    : typeof src.tabTitleEnabled === 'boolean'
      ? src.tabTitleEnabled
      : DEFAULT_TAB_TITLE.enabled;
  const tabApiUrl = rawTab?.apiUrl ?? DEFAULT_TAB_TITLE.apiUrl;
  const tabApiKey = rawTab && Object.hasOwn(rawTab, 'apiKey') ? rawTab.apiKey : '$DEEPSEEK_API_KEY';
  const tabModel = rawTab?.model ?? src.namingModel ?? DEFAULT_TAB_TITLE.model;
  const tabThinking = rawTab?.thinking === 'low' ? 'low' : 'off';

  const tabKnownKeys = new Set(['enabled', 'apiUrl', 'apiKey', 'model', 'thinking']);
  const tabEntries = [
    {
      key: 'enabled',
      value: tabEnabled,
      comments: ['是否启用自动中文标题与终端标签状态图标（true | false）'],
    },
    {
      key: 'apiUrl',
      value: tabApiUrl,
      comments: ['OpenAI 兼容 Chat Completions 接口地址（无状态直连，不建 agy 会话）'],
    },
    {
      key: 'apiKey',
      value: tabApiKey,
      comments: ['API Key：支持 "$环境变量名"（读取同名环境变量）；留空则回退本地规则提取'],
    },
    {
      key: 'model',
      value: tabModel,
      comments: ['命名模型 ID（默认 deepseek-v4.1-flash；DeepSeek 官方接口会自动映射为 deepseek-flash）'],
    },
    {
      key: 'thinking',
      value: tabThinking,
      comments: ['思考链开关：off（默认，更快更省）| low'],
    },
  ];
  if (rawTab) {
    for (const [k, v] of Object.entries(rawTab)) {
      if (!tabKnownKeys.has(k) && v !== undefined) tabEntries.push({key: k, value: v});
    }
  }
  const tabTitleRawLines = [
    '"tabTitle": {',
    ...formatObjectEntries(tabEntries, '  '),
    '}',
  ];

  const entries = [
    // 1. 企微机器人与主人绑定
    {
      key: 'botId',
      value: src.botId ?? DEFAULTS.botId,
      comments: [
        '==================== 1. 企微机器人与主人绑定（修改后需重启） ====================',
        '在企业微信「工作台 → 智能机器人 → API 模式 → 长连接」获取 BotID 与 Secret',
        '也可直接运行 `agy-remote setup` 通过向导填写',
      ],
    },
    {
      key: 'secret',
      value: src.secret ?? DEFAULTS.secret,
    },
    {
      key: 'ownerUserId',
      value: src.ownerUserId ?? DEFAULTS.ownerUserId,
      comments: ['已绑定的主人企微 UserID；留空后运行 `agy-remote bind` 通过 6 位绑定码自动写入'],
    },

    // 2. 会话与终端默认行为
    {
      beforeBlank: true,
      key: 'terminal',
      value: src.terminal ?? DEFAULTS.terminal,
      comments: [
        '==================== 2. 会话与终端默认行为（保存即生效） ====================',
        '手机「创建会话」打开的终端：',
        '  auto（自动探测）| cmux | ghostty | iterm | wezterm | kitty | tmux | terminal | none（仅后台）',
      ],
    },
    {
      key: 'defaultDir',
      value: src.defaultDir ?? DEFAULTS.defaultDir,
      comments: ['新建会话的默认工作目录（支持 ~）'],
    },
    {
      key: 'defaultMode',
      value: src.defaultMode ?? DEFAULTS.defaultMode,
      comments: [
        '新建后台会话的默认权限模式：',
        '  default（读写需确认）| accept-edits（自动允许改文件）| auto（自动允许编辑与安全命令）| plan（先规划后执行）',
      ],
    },

    // 3. 远程权限确认
    {
      beforeBlank: true,
      key: 'remoteConfirm',
      value: src.remoteConfirm ?? DEFAULTS.remoteConfirm,
      comments: [
        '==================== 3. 远程权限确认（保存即生效） ====================',
        '手机端工具审批策略：',
        '  ask-then-allow（弹卡片，超时自动放行）| ask（弹卡片，超时拒绝）| allow（全部自动放行，不弹卡片）',
      ],
    },
    {
      key: 'remoteConfirmTimeoutMs',
      value: src.remoteConfirmTimeoutMs ?? DEFAULTS.remoteConfirmTimeoutMs,
      comments: ['权限确认卡片超时时间（毫秒，范围 1000–86400000；默认 600000 = 10 分钟）'],
    },

    // 4. 目录别名
    {
      beforeBlank: true,
      key: 'aliases',
      value: aliases,
      comments: [
        '==================== 4. 目录别名（保存即生效） ====================',
        '手机发「创建会话 <别名> 消息」或「目录 <别名>」时快速定位到对应路径（支持 ~）',
        '也可通过 `agy-remote alias <别名> <目录>` / `agy-remote alias rm <别名>` 管理',
      ],
    },

    // 5. 会话自动命名与终端 Tab 标题
    {
      beforeBlank: true,
      rawLines: tabTitleRawLines,
      comments: [
        '==================== 5. 会话自动命名与终端 Tab 标题（保存即生效） ====================',
      ],
    },

    // 6. 高级设置
    {
      beforeBlank: true,
      key: 'localPort',
      value: src.localPort ?? DEFAULTS.localPort,
      comments: [
        '==================== 6. 高级设置（按需调整，一般保持默认） ====================',
        '本机守护进程监听端口（1024–65535，默认 18779；修改后需重启）',
      ],
    },
    {
      key: 'agyBin',
      value: (typeof src.agyBin === 'string' && src.agyBin.trim()) ? src.agyBin.trim() : DEFAULTS.agyBin,
      comments: ['agy 可执行文件命令名或绝对路径（默认 "agy"）'],
    },
    {
      key: 'acpProcessPerSession',
      value: typeof src.acpProcessPerSession === 'boolean' ? src.acpProcessPerSession : DEFAULTS.acpProcessPerSession,
      comments: ['后台 ACP 会话是否按会话隔离独立进程（true | false；默认 true，修改后需重启）'],
    },
    {
      key: 'tmuxSession',
      value: src.tmuxSession ?? DEFAULTS.tmuxSession,
      comments: ['tmux 终端适配器使用的会话名（terminal 为 tmux 时生效）'],
    },
    {
      key: 'kittySocket',
      value: src.kittySocket ?? DEFAULTS.kittySocket,
      comments: ['kitty 终端远控 socket（如 "unix:/tmp/mykitty"；terminal 为 kitty 时按需填写）'],
    },
    {
      key: 'nameWaitMs',
      value: src.nameWaitMs ?? DEFAULTS.nameWaitMs,
      comments: ['首条消息完成后等待自动命名返回的最大时长（毫秒，默认 5000）'],
    },
    {
      key: 'idleCloseMs',
      value: src.idleCloseMs ?? DEFAULTS.idleCloseMs,
      comments: ['后台 ACP 会话空闲自动关闭时长（毫秒，默认 21600000 = 6 小时）'],
    },
  ];

  // 按需保留非默认的内部路径或调试字段，避免污染常规配置表
  if (typeof src.agyDataDir === 'string' && src.agyDataDir.trim() && src.agyDataDir !== DEFAULTS.agyDataDir) {
    entries.push({
      key: 'agyDataDir',
      value: src.agyDataDir,
      comments: ['自定义 agy 数据目录（删除则使用默认 ~/.gemini/antigravity-cli）'],
    });
  }
  if (typeof src.inboxDir === 'string' && src.inboxDir.trim() && src.inboxDir !== DEFAULTS.inboxDir) {
    entries.push({
      key: 'inboxDir',
      value: src.inboxDir,
      comments: ['自定义入站附件暂存目录'],
    });
  }
  if (typeof src.wsUrl === 'string' && src.wsUrl.trim()) {
    entries.push({
      key: 'wsUrl',
      value: src.wsUrl,
      comments: ['自定义企微长连接地址（仅调试用，须使用 wss://；修改后需重启）'],
    });
  }

  const knownKeys = new Set([
    'botId', 'secret', 'ownerUserId',
    'terminal', 'defaultDir', 'defaultMode',
    'remoteConfirm', 'remoteConfirmTimeoutMs',
    'aliases', 'dirAliases',
    'tabTitle', 'tabTitleEnabled', 'namingModel',
    'localPort', 'agyBin', 'acpProcessPerSession', 'tmuxSession', 'kittySocket', 'nameWaitMs', 'idleCloseMs',
    'agyDataDir', 'inboxDir', 'wsUrl',
  ]);
  let addedCustomHeader = false;
  for (const [k, v] of Object.entries(src)) {
    if (knownKeys.has(k) || v === undefined) continue;
    entries.push({
      beforeBlank: !addedCustomHeader,
      key: k,
      value: v,
      comments: addedCustomHeader ? [] : ['自定义扩展项'],
    });
    addedCustomHeader = true;
  }

  return [
    '// Agy Remote WeCom 配置文件（支持 // 注释与尾随逗号）',
    '// 保存即可热生效；标明「需重启」的项修改后请执行：agy-remote restart',
    '{',
    ...formatObjectEntries(entries, '  '),
    '}',
    '',
  ].join('\n');
}

function writeConfigAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, content, {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, {force: true});
  }
}

export function loadConfig() {
  let user = {};
  try {
    user = parseJsonc(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`遥控配置无效，请检查 config.json（${e.message}）`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('遥控配置无效：config.json 根节点必须是 JSON 对象');
  }
  const rawAliases = user.aliases ?? user.dirAliases ?? DEFAULTS.aliases;
  const rawTabTitle = user.tabTitle && typeof user.tabTitle === 'object' ? user.tabTitle : {};
  const enabled = typeof rawTabTitle.enabled === 'boolean'
    ? rawTabTitle.enabled
    : typeof user.tabTitleEnabled === 'boolean'
      ? user.tabTitleEnabled
      : DEFAULTS.tabTitle.enabled;
  const model = rawTabTitle.model || user.namingModel || DEFAULTS.tabTitle.model;
  const tabTitle = {
    ...DEFAULT_TAB_TITLE,
    ...rawTabTitle,
    enabled,
    model,
    thinking: rawTabTitle.thinking === 'low' ? 'low' : 'off',
  };

  const cfg = {
    ...DEFAULTS,
    ...user,
    agyBin: (typeof user.agyBin === 'string' && user.agyBin.trim()) ? user.agyBin.trim() : DEFAULTS.agyBin,
    acpProcessPerSession: typeof user.acpProcessPerSession === 'boolean' ? user.acpProcessPerSession : DEFAULTS.acpProcessPerSession,
    agyDataDir: (typeof user.agyDataDir === 'string' && user.agyDataDir.trim()) ? user.agyDataDir.trim() : DEFAULTS.agyDataDir,
    aliases: rawAliases,
    dirAliases: rawAliases,
    tabTitle,
    tabTitleEnabled: tabTitle.enabled,
    namingModel: tabTitle.model,
  };

  if (cfg.wsUrl) {
    const endpoint = new URL(cfg.wsUrl);
    if (
      endpoint.protocol !== 'wss:' &&
      !(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
    ) {
      throw new Error('wsUrl 必须使用 wss（本机测试服务除外）');
    }
  }
  if (process.env.AGY_REMOTE_PORT) cfg.localPort = Number(process.env.AGY_REMOTE_PORT);
  if (!Number.isInteger(cfg.localPort) || cfg.localPort < 1024 || cfg.localPort > 65535) {
    throw new Error('localPort 无效（需为 1024–65535 整数）');
  }
  if (!VALID_TERMINALS.includes(String(cfg.terminal || 'auto').toLowerCase())) {
    throw new Error(`terminal 无效（可选：${VALID_TERMINALS.join(' / ')}）`);
  }
  if (!cfg.aliases || typeof cfg.aliases !== 'object' || Array.isArray(cfg.aliases) || Object.values(cfg.aliases).some((v) => typeof v !== 'string')) {
    throw new Error('aliases 无效');
  }
  if (!['default', 'accept-edits', 'auto', 'plan'].includes(cfg.defaultMode)) {
    throw new Error('defaultMode 只能是 default、accept-edits、auto 或 plan');
  }
  if (!['ask-then-allow', 'ask', 'allow'].includes(cfg.remoteConfirm)) {
    throw new Error('remoteConfirm 只能是 ask-then-allow、ask 或 allow');
  }
  if (!Number.isFinite(cfg.remoteConfirmTimeoutMs) || cfg.remoteConfirmTimeoutMs < 1000 || cfg.remoteConfirmTimeoutMs > 86400000) {
    throw new Error('remoteConfirmTimeoutMs 需在 1000–86400000 毫秒之间');
  }
  return cfg;
}

const validField = (v) => typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v);

export function validateCredentials(cfg) {
  if (![cfg.botId, cfg.secret].every(validField)) throw new Error('需要 botId、secret；请运行 agy-remote setup 或编辑 config.json');
  if (cfg.ownerUserId && !validField(cfg.ownerUserId)) throw new Error('ownerUserId 无效；请检查 config.json');
}

/** 生成 6 位绑定码并写入运行目录（600），返回明文供电脑端展示。 */
export function createBindCode(dir = RUN_DIR, now = Date.now()) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const file = path.join(dir, BIND_FILE);
  const tmp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify({code, expiresAt: now + BIND_TTL_MS, failures: 0}), {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, {force: true});
  }
  return code;
}

/** 原子更新 config.json（保留用户已有字段并维持分段注释排版）。 */
export function updateConfigFile(patch) {
  let current = {};
  try {
    current = parseJsonc(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const merged = {...current, ...patch};
  if (merged.aliases && 'dirAliases' in merged) delete merged.dirAliases;
  writeConfigAtomic(CONFIG_FILE, formatConfigJsonc(merged));
  return merged;
}

export function saveConfig(cfg) {
  validateCredentials(cfg);
  const clean = {...cfg};
  if (clean.aliases && 'dirAliases' in clean) delete clean.dirAliases;
  writeConfigAtomic(CONFIG_FILE, formatConfigJsonc(clean));
  ensureToken();
}

/** 只改磁盘上的 ownerUserId，避免把环境变量覆盖或默认值写回配置。 */
export function saveOwner(userid) {
  let user = {};
  try { user = parseJsonc(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  saveConfig({...user, ownerUserId: userid});
}

/** 首次安装时若 config.json 不存在，预生成带分段与中文注释的默认配置表（0600），方便用户直接打开编辑。 */
export function ensureDefaultConfigFile(file = CONFIG_FILE) {
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  try {
    fs.writeFileSync(file, formatConfigJsonc(), {mode: 0o600, flag: 'wx'});
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return file;
}

/**
 * 打开编辑器前的准备：
 * - 不存在则生成带分段与注释的模板；
 * - 已存在但为旧版无注释纯 JSON 时，自动无损升级为分段+注释格式；
 * - 已带注释或语法有误时保持原样不动（方便用户直接修改或排错）。
 */
export function ensureConfigFileForEdit(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) {
    ensureDefaultConfigFile(file);
    return {file, created: true, migrated: false};
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (hasJsonComments(raw)) {
    return {file, created: false, migrated: false};
  }
  try {
    const parsed = parseJsonc(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      writeConfigAtomic(file, formatConfigJsonc(parsed));
      return {file, created: false, migrated: true};
    }
  } catch (e) {
    return {file, created: false, migrated: false, parseError: e.message};
  }
  return {file, created: false, migrated: false};
}

export function ensureToken() {
  fs.mkdirSync(RUN_DIR, {recursive: true, mode: 0o700});
  const file = path.join(RUN_DIR, '.token');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(file, 'utf8').trim();
}

/** 读取电脑端 agy 自身的 settings.json（如 toolPermission: "always-proceed" 与 permissions.allow）。 */
export function readAgySettings(agyDataDir = DEFAULTS.agyDataDir) {
  if (!agyDataDir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(agyDataDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 判断电脑端 agy 的 settings.json 是否已将该工具调用设为自动放行（免确认）。 */
export function isToolAutoAllowedByAgy(agyDataDir = DEFAULTS.agyDataDir, toolCall = {}) {
  const settings = readAgySettings(agyDataDir);
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
