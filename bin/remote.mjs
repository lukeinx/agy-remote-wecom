#!/usr/bin/env node
// agy-remote-wecom 电脑端 CLI：管理单一配置表 ~/.config/agy-remote-wecom/config.json、企微绑定码与 launchd 守护进程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  loadConfig,
  saveConfig,
  createBindCode,
  ensureToken,
  ensureDefaultConfigFile,
  ensureConfigFileForEdit,
  parseJsonc,
  RUN_DIR,
  CONFIG_FILE,
  WELCOME_FILE,
  BIND_FILE,
  BIND_TTL_MS,
  BIND_MAX_FAILURES,
} from '../daemon/config.mjs';
import {loadAliases, saveAliases, tildeDir, missingDirs, expandDir, checkName} from '../daemon/aliases.mjs';
import {health, startService, stopService, restartService, uninstallService} from '../daemon/service.mjs';
import {writeNamingPref, namingStatusLabel, resolveApiKey} from '../daemon/naming.mjs';
import {fetchCliUsage, formatUsageBody, formatUsageClock} from '../daemon/usage.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = path.join(ROOT, 'plugin');
const INSTALLED_PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-remote-wecom');
const LOCAL_BIN_LINK = path.join(os.homedir(), '.local', 'bin', 'agy-remote');

function writePackagePointer() {
  const payload = JSON.stringify({
    root: ROOT,
    cli: path.join(ROOT, 'bin', 'remote.mjs'),
    updatedAt: Date.now(),
  }, null, 2) + '\n';
  for (const dir of [RUN_DIR, INSTALLED_PLUGIN_DIR]) {
    try {
      fs.mkdirSync(dir, {recursive: true});
      const file = dir === RUN_DIR ? path.join(dir, 'package-root.json') : path.join(dir, '.package-root.json');
      fs.writeFileSync(file, payload, {mode: 0o600});
    } catch {}
  }
}

function cleanupPluginLegacySkills() {
  try { fs.rmSync(path.join(INSTALLED_PLUGIN_DIR, 'skills'), {recursive: true, force: true}); } catch {}
}

function cleanupOwnedLocalBinLink() {
  try {
    if (!fs.lstatSync(LOCAL_BIN_LINK).isSymbolicLink()) return;
    const target = path.resolve(path.dirname(LOCAL_BIN_LINK), fs.readlinkSync(LOCAL_BIN_LINK));
    if (target === path.join(ROOT, 'bin', 'remote.mjs')) {
      fs.unlinkSync(LOCAL_BIN_LINK);
    }
  } catch {}
}

export function installPlugin(agyBin = 'agy') {
  ensureDefaultConfigFile();
  cleanupPluginLegacySkills();
  try {
    const out = execFileSync(agyBin, ['plugin', 'install', PLUGIN_DIR], {encoding: 'utf8', timeout: 15_000});
    writePackagePointer();
    cleanupPluginLegacySkills();
    return out.trim();
  } catch (e) {
    writePackagePointer();
    cleanupPluginLegacySkills();
    throw new Error(`安装 agy hook 插件失败：${e.stderr || e.message}`);
  }
}

function uninstallPlugin(agyBin = 'agy') {
  try {
    execFileSync(agyBin, ['plugin', 'uninstall', 'agy-remote-wecom'], {encoding: 'utf8', timeout: 10_000});
  } catch {}
  cleanupOwnedLocalBinLink();
  cleanupPluginLegacySkills();
}

export function openConfigInEditor({
  file = CONFIG_FILE,
  editor = (process.env.VISUAL || process.env.EDITOR || '').trim(),
  platform = process.platform,
  spawnSyncFn = spawnSync,
  ensureFileFn = ensureConfigFileForEdit,
  loadConfigFn = loadConfig,
} = {}) {
  const prep = ensureFileFn(file);
  const migratedNote = prep?.migrated ? '（已自动整理为分段带注释格式，原配置值完整保留）' : '';
  if (editor) {
    const [bin, ...rest] = editor.split(/\s+/);
    const res = spawnSyncFn(bin, [...rest, file], {stdio: 'inherit'});
    if (!res?.error) {
      if (res?.status !== 0) {
        return `⚠️ 编辑器非正常退出（exit ${res?.status ?? '?'}）：${file}`;
      }
      try {
        loadConfigFn();
        return `✔ 已保存配置文件：${file}${migratedNote}（校验通过，热加载项已生效；修改 botId / secret / localPort 需执行 agy-remote restart）`;
      } catch (e) {
        process.exitCode = 1;
        return `⚠️ 配置文件已保存，但校验失败：${e.message}\n   请重新运行 \`agy-remote config edit\` 修正（守护进程暂沿用旧配置）。`;
      }
    }
  }
  if (platform === 'darwin') {
    spawnSyncFn('open', ['-t', file], {stdio: 'ignore'});
    return `✔ 已在系统文本编辑器中打开：${file}${migratedNote}（保存即热生效；修改 botId / secret / localPort 需执行 agy-remote restart）`;
  }
  return `请使用编辑器打开配置文件：${file}${migratedNote}`;
}

export function tryInstallPlugin(agyBin = 'agy', installer = installPlugin) {
  try {
    const output = installer(agyBin);
    return {ok: true, output, error: ''};
  } catch (e) {
    return {ok: false, output: '', error: String(e?.message || e).trim()};
  }
}

export function formatPluginStatus(plugin) {
  if (!plugin || plugin.ok) return '✔ Hook 插件已安装';
  return `⚠️ Hook 插件未自动安装：${plugin.error}\n   （手机仍可用后台会话；如需联动本机终端，请确认 agy 可执行后运行 \`agy-remote install-plugin\`）`;
}

export function formatWeComStatus(wecom) {
  if (wecom?.fatalError) return `🔴 ${wecom.fatalError}`;
  if (wecom?.connected) return '🟢 企微已连接';
  return `🟡 ${wecom?.reason || '正在连接企微'}`;
}

export function readValidBindCode(dir = RUN_DIR, now = Date.now()) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, BIND_FILE), 'utf8'));
    if (
      typeof data?.code === 'string' &&
      /^\d{6}$/.test(data.code) &&
      Number(data.expiresAt) > now &&
      (data.failures || 0) < BIND_MAX_FAILURES
    ) {
      return data.code;
    }
  } catch {}
  return '';
}

export async function waitForWeComReady({
  healthFn = health,
  timeoutMs = 5000,
  intervalMs = 250,
  initialState = null,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let latest = initialState;
  const deadline = now() + timeoutMs;
  if (latest?.wecom?.connected || latest?.wecom?.fatalError) return latest;
  while (now() < deadline) {
    await sleep(intervalMs);
    const next = await healthFn().catch(() => null);
    if (next) latest = next;
    if (latest?.wecom?.connected || latest?.wecom?.fatalError) return latest;
  }
  return latest;
}

export async function watchBindingInTerminal(deadlineOrOpts = Date.now() + BIND_TTL_MS) {
  const opts = typeof deadlineOrOpts === 'object' && deadlineOrOpts !== null
    ? deadlineOrOpts
    : {deadline: deadlineOrOpts};
  const {
    now = Date.now,
    deadline = now() + BIND_TTL_MS,
    healthFn = health,
    loadConfigFn = loadConfig,
    bindFile = path.join(RUN_DIR, BIND_FILE),
    intervalMs = 1500,
    warnAfterMs = 15_000,
    isTTY = Boolean(process.stdout.isTTY),
    write = (s) => process.stdout.write(s),
    logLine = (s) => console.log(s),
    initiallyConnected = false,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  if (!isTTY) return {status: 'non-tty'};
  const startedAt = now();
  let announcedConnected = Boolean(initiallyConnected);
  let warnedSlow = false;
  let missedHealth = 0;
  write('⏳ 正在等待手机企微发送绑定码（按 Ctrl+C 可随时退出等待，后台仍可完成绑定）...');
  while (now() < deadline) {
    await sleep(intervalMs);
    const state = await healthFn().catch(() => null);
    if (!state) {
      missedHealth += 1;
      if (missedHealth >= 3) {
        logLine(`\n\n❌ 后台服务已停止，请检查 ${path.join(RUN_DIR, 'service.log')} 后重试。\n`);
        return {status: 'stopped'};
      }
      continue;
    }
    missedHealth = 0;
    if (state.wecom?.fatalError) {
      logLine(`\n\n❌ ${state.wecom.fatalError}\n   请重新执行 \`agy-remote setup\` 核对凭证，或运行 \`agy-remote status\` 查看详情。\n`);
      return {status: 'error', error: state.wecom.fatalError};
    }
    if (!announcedConnected && state.wecom?.connected) {
      announcedConnected = true;
      logLine('\n🟢 企微已连接，正在等待手机发送绑定码...');
    } else if (!state.wecom?.connected && !warnedSlow && now() - startedAt >= warnAfterMs && state.wecom?.lastError) {
      warnedSlow = true;
      logLine(`\n⚠️ 企微暂未连上（${state.wecom.lastError}），仍在重试...`);
    }
    if (state.wecom?.bound) {
      const owner = loadConfigFn().ownerUserId || '已绑定';
      logLine(`\n\n🎉 企微绑定成功（主人账号：${owner}）！现在可以直接在手机企微发消息遥控 agy 了。\n   提示：此前已打开的 agy 终端需重启或新开，才能在「活跃会话」中看到。\n`);
      return {status: 'bound', owner};
    }
    if (!fs.existsSync(bindFile)) {
      logLine('\n\n⚠️ 绑定码已作废，请执行 `agy-remote bind` 重新获取。\n');
      return {status: 'invalidated'};
    }
  }
  logLine('\n\n⚠️ 绑定码已过期，请执行 `agy-remote bind` 重新获取。\n');
  return {status: 'expired'};
}

async function performBind() {
  const cfg = loadConfig();
  if (!cfg.botId || !cfg.secret) {
    throw new Error('尚未配置机器人凭证，请先执行 `agy-remote setup` 或编辑 ' + CONFIG_FILE);
  }
  await stopService();
  saveConfig({...cfg, ownerUserId: ''});
  const code = createBindCode();
  const started = await startService();
  const state = (await waitForWeComReady({initialState: started})) || started;
  return {code, state};
}

async function performQuickSetup(botId, secret, ownerArg = '') {
  const running = await health();
  if (running?.targets?.some((t) => t.busy)) {
    throw new Error('请先等正在运行的遥控任务结束，再修改配置。');
  }
  const cfg = loadConfig();
  const changedBot = botId !== cfg.botId;
  const ownerUserId = ownerArg || (changedBot ? '' : cfg.ownerUserId);
  const next = {...cfg, botId: botId.trim(), secret: secret.trim(), ownerUserId};
  try { fs.rmSync(path.join(RUN_DIR, WELCOME_FILE), {force: true}); } catch {}
  saveConfig(next);
  const plugin = tryInstallPlugin(next.agyBin);
  await stopService();
  const code = ownerUserId ? '' : createBindCode();
  const started = await startService();
  const state = (await waitForWeComReady({initialState: started})) || started;
  return {code, state, ownerUserId, botId: next.botId, plugin};
}

export async function performStart({
  loadConfigFn = loadConfig,
  healthFn = health,
  startServiceFn = startService,
  restartServiceFn = restartService,
  installPluginFn = tryInstallPlugin,
  readBindCodeFn = readValidBindCode,
  createBindCodeFn = createBindCode,
  waitReadyFn = waitForWeComReady,
  force = false,
  restart = false,
} = {}) {
  const cfg = loadConfigFn();
  if (!cfg.botId || !cfg.secret) {
    throw new Error(`尚未配置机器人凭证，请先执行 \`agy-remote setup\`，或运行 \`agy-remote config edit\` 填入 botId 与 secret。`);
  }
  const running = await healthFn();
  if (restart || running) {
    const busy = (running?.targets || []).filter((t) => t.busy);
    if (busy.length && !force) {
      throw new Error(`有任务正在运行：${busy.map((t) => t.label).join('、')}。等任务结束，或执行 agy-remote restart force 强制重启。`);
    }
  }
  let code = '';
  if (!cfg.ownerUserId) {
    code = readBindCodeFn() || createBindCodeFn();
  }
  const plugin = installPluginFn(cfg.agyBin);
  const started = running && restart
    ? await restartServiceFn({force})
    : await startServiceFn();
  const state = (await waitReadyFn({healthFn, initialState: started})) || started;
  return {state, plugin, code, ownerUserId: cfg.ownerUserId, botId: cfg.botId};
}

export function formatStartOutput({state, plugin, code, ownerUserId, action = '启动'}) {
  const conn = formatWeComStatus(state?.wecom);
  const lines = [
    `🔄 **Agy Remote 服务已${action}** · ${conn}（v${state?.version || ''}）`,
  ];
  if (plugin && !plugin.ok) lines.push(formatPluginStatus(plugin));
  if (state?.wecom?.fatalError) {
    lines.push('请检查 BotID / Secret 或运行 `agy-remote setup` 重新配置。');
  } else if (code && !ownerUserId) {
    lines.push('');
    lines.push(`👉 尚未绑定主人账号，请在手机企业微信单聊该机器人，发送 6 位绑定码：**\`${code}\`**（10 分钟内有效）`);
  }
  return lines.join('\n');
}

async function interactiveSetup() {
  ensureDefaultConfigFile();
  const cfg = loadConfig();
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  let code = '';
  let state = null;
  try {
    console.log('=== Agy Remote WeCom 配置向导 ===');
    console.log('（在企业微信「工作台 → 智能机器人 → 创建机器人 → API 模式 → 长连接」获取凭证）\n');
    const botId = (await rl.question(`1. BotID ${cfg.botId ? `[${cfg.botId}] ` : ''}`)).trim() || cfg.botId;
    const secret = (await rl.question(`2. Secret ${cfg.secret ? '[已配置，回车保持不变] ' : ''}`)).trim() || cfg.secret;
    if (!botId || !secret) throw new Error('BotID 与 Secret 不能为空');
    console.log('\n正在保存配置并启动后台服务...');
    const res = await performQuickSetup(botId, secret);
    code = res.code;
    state = res.state;
    console.log(formatPluginStatus(res.plugin));
    console.log(`✔ 后台服务已启动（${formatWeComStatus(state.wecom)}）`);
    console.log(`✔ 统一配置表：${CONFIG_FILE}（后续可直接运行 agy-remote config edit 修改）`);
    if (state.wecom?.fatalError) {
      console.log('\n❌ 企微连接失败，暂无法绑定。请重新执行 `agy-remote setup` 核对 BotID 和 Secret。\n');
      process.exitCode = 1;
      code = '';
    } else if (code) {
      console.log(`\n👉 请在手机企业微信单聊该机器人，发送以下 6 位绑定码：\n\n      ${code}  （10 分钟内有效）\n`);
    } else {
      console.log(`\n✔ 已保留当前绑定账号：${res.ownerUserId}（如需重新绑定请执行 agy-remote bind）\n`);
    }
  } finally {
    rl.close();
  }
  if (code) {
    const result = await watchBindingInTerminal({initiallyConnected: Boolean(state?.wecom?.connected)});
    if (result.status === 'error' || result.status === 'stopped') process.exitCode = 1;
  }
}

function formatConfigSummary() {
  ensureDefaultConfigFile();
  const cfg = loadConfig();
  const aliases = loadAliases();
  const hasKey = Boolean(resolveApiKey(cfg.tabTitle?.apiKey));
  const aliasLines = Object.entries(aliases).map(([k, v]) => `    "${k}": "${tildeDir(v)}"`);
  return [
    `### ⚙️ Agy Remote WeCom 配置表`,
    '',
    `- **配置文件路径**：[\`${CONFIG_FILE}\`](file://${CONFIG_FILE})（运行 \`agy-remote config edit\` 打开，保存即热生效）`,
    `- **企微机器人 (\`botId\`)**：\`${cfg.botId || '未配置'}\``,
    `- **绑定账号 (\`ownerUserId\`)**：\`${cfg.ownerUserId || '待绑定'}\``,
    `- **默认终端 (\`terminal\`)**：\`${cfg.terminal}\`（可选 \`auto\` / \`ghostty\` / \`cmux\` / \`iterm\` / \`wezterm\` / \`kitty\` / \`tmux\` / \`terminal\` / \`none\`）`,
    `- **默认新建目录 (\`defaultDir\`)**：\`${tildeDir(cfg.defaultDir || '~')}\``,
    `- **默认后台模式 (\`defaultMode\`)**：\`${cfg.defaultMode}\`（\`default\` / \`accept-edits\` / \`auto\` / \`plan\`）`,
    `- **权限确认策略 (\`remoteConfirm\`)**：\`${cfg.remoteConfirm}\`（超时 \`${Math.round(cfg.remoteConfirmTimeoutMs / 60000)}m\`）`,
    `- **Tab 自动命名 (\`tabTitle\`)**：\`${namingStatusLabel(cfg)}\` · ${hasKey ? 'AI 命名已就绪' : '未配 API Key（自动使用本地短标题提取）'}`,
    `- **目录别名 (\`aliases\`)**：`,
    '```json',
    '{',
    aliasLines.join(',\n'),
    '}',
    '```',
  ].join('\n');
}

async function formatStatusMarkdown() {
  ensureDefaultConfigFile();
  const cfg = loadConfig();
  const configured = Boolean(cfg.botId && cfg.secret);
  if (!configured) {
    return [
      '### 📱 Agy Remote WeCom · 尚未配置',
      '',
      '用手机企业微信遥控本机 `agy`。任选一种方式完成初始化：',
      '',
      '1. **交互式向导（推荐）**：在终端执行 `agy-remote setup`',
      `2. **直接编辑配置表**：运行 \`agy-remote config edit\` 打开 [\`${CONFIG_FILE}\`](file://${CONFIG_FILE})，填入 \`botId\` 与 \`secret\` 后执行 \`agy-remote start\``,
    ].join('\n');
  }
  const h = await health();
  if (!h) {
    return [
      '### ⚪ Agy Remote WeCom · 后台服务未运行',
      '',
      `- **配置文件**：[\`${CONFIG_FILE}\`](file://${CONFIG_FILE})（\`agy-remote config edit\`）`,
      `- **机器人 BotID**：\`${cfg.botId}\``,
      `- **绑定状态**：${cfg.ownerUserId ? `已绑定 (\`${cfg.ownerUserId}\`)` : '未绑定'}`,
      `- **自动命名**：\`${namingStatusLabel(cfg)}\``,
      '',
      '在终端执行 `agy-remote start` 启动服务。',
    ].join('\n');
  }
  const connText = formatWeComStatus(h.wecom);
  const bindText = h.wecom?.bound
    ? `已绑定 (\`${cfg.ownerUserId}\`)`
    : '⏳ 待绑定（执行 `agy-remote bind` 获取 6 位绑定码）';
  const verUpdate = h.diskVersion && h.diskVersion !== h.version
    ? `（发现新版本 v${h.diskVersion}，执行 \`agy-remote restart\` 生效）`
    : '';
  const targets = h.targets || [];
  const targetLines = targets.length
    ? targets.slice(0, 6).map((t) => `  - ${t.sessionId === process.env.AGY_SESSION_ID ? '当前电脑 · ' : ''}${t.sessionId === h.currentSessionId ? '手机所选 · ' : ''}\`${t.label}\` (${t.kind === 'tui' ? '终端' : '后台'}${t.busy ? ' · 运行中' : ''})`)
    : ['  - （暂无活跃会话）'];
  const headerIcon = h.wecom?.fatalError ? '🔴' : h.wecom?.connected ? '🟢' : '🟡';
  const lastErrLine = !h.wecom?.connected && h.wecom?.lastError && !h.wecom?.fatalError
    ? [`- **最近错误**：\`${h.wecom.lastError}\``]
    : [];
  return [
    `### ${headerIcon} Agy Remote WeCom · v${h.version}${verUpdate}`,
    '',
    `- **连接状态**：${connText}`,
    ...lastErrLine,
    `- **主人绑定**：${bindText}`,
    `- **自动命名**：\`${namingStatusLabel(cfg)}\``,
    `- **配置文件**：[\`${CONFIG_FILE}\`](file://${CONFIG_FILE})（运行 \`agy-remote config edit\` 编辑，保存即生效）`,
    `- **活跃会话（${targets.length}）**：`,
    ...targetLines,
  ].join('\n');
}

async function runSlashCommand(rawArgs) {
  const tokens = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  const sub = (tokens[0] || 'status').toLowerCase();
  const arg1 = tokens[1] || '';
  const arg2 = tokens[2] || '';
  const arg3 = tokens[3] || '';

  if (sub === 'status' || sub === 'doctor') {
    return formatStatusMarkdown();
  }
  if (sub === 'usage' || sub === 'quota') {
    const cfg = loadConfig();
    const {groups, fetchedAt} = await fetchCliUsage({bin: cfg.agyBin});
    if (!groups.length) return '### 📊 暂无用量数据\n\n---\n\n当前账号未返回可用额度分组。';
    return [
      '### 📊 模型用量',
      '',
      '---',
      '',
      formatUsageBody(groups, {now: fetchedAt}),
      '',
      '---',
      '',
      `\`更新：${formatUsageClock(fetchedAt)}\``,
    ].join('\n');
  }
  if (sub === 'config') {
    if (arg1 === 'edit' || arg1 === '--edit' || arg1 === '-e') return openConfigInEditor();
    if (arg1 === 'path' || arg1 === '--path') return CONFIG_FILE;
    return formatConfigSummary();
  }
  if (sub === 'edit') {
    return openConfigInEditor();
  }
  if (sub === 'setup') {
    if (!arg1 || !arg2) {
      return [
        '### ⚙️ Agy Remote WeCom 配置向导',
        '',
        '请在终端执行交互式配置：`agy-remote setup`，或直接运行：`agy-remote setup <BotID> <Secret>`',
      ].join('\n');
    }
    const {code, state, ownerUserId, botId, plugin} = await performQuickSetup(arg1, arg2, arg3);
    const conn = formatWeComStatus(state.wecom);
    const pluginLines = plugin && !plugin.ok ? [`- **Hook 插件**：${formatPluginStatus(plugin)}`] : [];
    if (state.wecom?.fatalError) {
      return [
        '### ❌ 配置已保存，但企微连接失败',
        '',
        `- **机器人 BotID**：\`${botId}\``,
        `- **连接状态**：${conn}`,
        ...pluginLines,
        '',
        '请核对 BotID 与 Secret 后重新执行 `agy-remote setup`。',
      ].join('\n');
    }
    if (code) {
      return [
        '### ✅ 配置已保存并启动服务',
        '',
        `- **机器人 BotID**：\`${botId}\``,
        `- **连接状态**：${conn}`,
        ...pluginLines,
        `- **6 位绑定码**：**\`${code}\`**（10 分钟内有效）`,
        '',
        `👉 请在手机企业微信单聊该机器人，直接发送 **\`${code}\`** 完成绑定。`,
      ].join('\n');
    }
    return [
      '### ✅ 配置已更新并重启服务',
      '',
      `- **机器人 BotID**：\`${botId}\``,
      `- **连接状态**：${conn}`,
      ...pluginLines,
      `- **绑定账号**：\`${ownerUserId}\`（如需更换请执行 \`agy-remote bind\`）`,
    ].join('\n');
  }
  if (sub === 'bind') {
    const {code, state} = await performBind();
    const conn = formatWeComStatus(state.wecom);
    if (state.wecom?.fatalError) {
      return [
        '### ❌ 企微连接失败，暂无法绑定',
        '',
        `- **连接状态**：${conn}`,
        '',
        '请重新执行 `agy-remote setup` 核对机器人凭证。',
      ].join('\n');
    }
    return [
      '### 🔑 企微绑定码已生成',
      '',
      `- **6 位绑定码**：**\`${code}\`**（10 分钟内有效）`,
      `- **连接状态**：${conn}`,
      '',
      `👉 请在手机企业微信单聊机器人发送 **\`${code}\`**，绑定成功后只接受你的消息。`,
    ].join('\n');
  }
  if (sub === 'name') {
    const restArg = rawArgs.trim().slice('name'.length).trim();
    const cfg = loadConfig();
    const h = await health();
    if (h) {
      const token = ensureToken();
      const res = await fetch(`http://127.0.0.1:${cfg.localPort}/name`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-agy-token': token},
        body: JSON.stringify({arg: restArg, sessionId: process.env.AGY_SESSION_ID || ''}),
        signal: AbortSignal.timeout(15_000),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '命名操作失败');
      const reply = typeof out.reply === 'string' ? out.reply : out.reply?.fallback;
      return (reply || '命名操作未返回结果，请重试。').replace(/`命名/g, '`agy-remote name');
    }
    if (arg1 === 'off') {
      writeNamingPref({enabled: false, model: '', source: 'off'});
      return '🏷️ 已关闭会话自动命名。';
    }
    if (arg1 === 'model') {
      if (!arg2 || arg2 === 'show') return `🏷️ 自动命名模型：\`${namingStatusLabel(cfg)}\``;
      if (arg2 === 'default' || arg2 === 'reset') {
        writeNamingPref({source: 'default'});
        return `🏷️ 已恢复默认命名模型：\`${namingStatusLabel(loadConfig())}\``;
      }
      writeNamingPref({enabled: true, model: arg2, source: 'custom'});
      return `🏷️ 已设置自动命名模型：\`${arg2}\``;
    }
    return `🏷️ 自动命名模型：\`${namingStatusLabel(cfg)}\`（可在 \`${CONFIG_FILE}\` 的 \`tabTitle\` 中配置）`;
  }
  if (sub === 'alias') {
    const table = loadAliases();
    const aliasHelp = `可在 \`${CONFIG_FILE}\` 的 \`aliases\` 字段直接编辑，或用 \`agy-remote alias 名称 [目录]\` · \`agy-remote alias rm 名称\``;
    if (arg1 === 'help') return aliasHelp;
    if (arg1 === 'edit') return `请编辑配置表中的 \`aliases\` 字段：\`${CONFIG_FILE}\`，保存后即时生效。`;
    if (!arg1 || arg1 === 'list' || arg1 === 'ls') {
      const lines = Object.entries(table).map(([k, v]) => `- \`${k}\` → \`${tildeDir(v)}\``);
      const miss = missingDirs(table);
      return [
        '### 📁 目录别名',
        '',
        ...(lines.length ? lines : ['- （暂无别名）']),
        ...(miss.length ? [`\n⚠️ 目录不存在：${miss.map((m) => `\`${m}\``).join(', ')}`] : []),
        '',
        aliasHelp,
      ].join('\n');
    }
    if (arg1 === '--rm' || arg1 === 'rm' || arg1 === 'del') {
      if (!arg2 || arg3) throw new Error('用法：`agy-remote alias rm <别名>`');
      if (!Object.hasOwn(table, arg2.toLowerCase())) throw new Error(`没有别名「${arg2}」`);
      delete table[arg2.toLowerCase()];
      saveAliases(table);
      return `📁 已删除目录别名 \`${arg2.toLowerCase()}\`。`;
    }
    const name = checkName(arg1);
    if (['rm', 'del', 'edit', 'list', 'ls', 'help'].includes(name)) throw new Error(`「${name}」是保留字，换个名字`);
    let rawDir = rawArgs.trim().replace(/^alias\s+\S+\s*/i, '').trim();
    if ((rawDir.startsWith('"') && rawDir.endsWith('"')) || (rawDir.startsWith("'") && rawDir.endsWith("'"))) rawDir = rawDir.slice(1, -1);
    const cwd = process.env.AGY_SESSION_CWD || process.cwd();
    const dir = !rawDir || rawDir === '.' ? cwd : rawDir.startsWith('~') ? expandDir(rawDir) : path.resolve(cwd, rawDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在：${dir}`);
    const before = table[name];
    table[name] = tildeDir(dir);
    saveAliases(table);
    return `📁 已${before ? '更新' : '设置'} ${name} → \`${table[name]}\`\n\n手机端：\`创建会话 ${name} 消息\``;
  }
  if (sub === 'start' || sub === 'restart') {
    const res = await performStart({force: arg1 === 'force', restart: sub === 'restart'});
    return formatStartOutput({...res, action: sub === 'start' ? '启动' : '重启'});
  }
  if (sub === 'stop') {
    await stopService();
    return '⏹️ **Agy Remote 后台服务已停止**（执行 `agy-remote start` 恢复；已有终端会话不受影响）。';
  }
  return formatConfigSummary();
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  const command = process.argv[2] || 'status';
  const arg1 = process.argv[3] || '';
  const arg2 = process.argv[4] || '';
  const arg3 = process.argv[5] || '';

  try {
    if (command === '__slash') {
      const md = await runSlashCommand(process.env.AGY_SLASH_ARGS || '');
      console.log(md);
    } else if (command === 'run') {
      await import('../daemon/daemon.mjs');
    } else if (command === 'config' || command === 'edit') {
      console.log(await runSlashCommand(`${command} ${arg1}`.trim()));
    } else if (command === 'setup') {
      if (arg1 && arg2) {
        const md = await runSlashCommand(`setup ${arg1} ${arg2} ${arg3}`.trim());
        console.log(md);
        if (md.includes('企微连接失败')) process.exitCode = 1;
      } else {
        await interactiveSetup();
      }
    } else if (command === 'configure') {
      if (!arg1) throw new Error('用法：agy-remote configure <凭证.json>');
      if (await health()) throw new Error('请先运行 agy-remote stop 停止服务，再修改配置');
      const patch = parseJsonc(fs.readFileSync(arg1, 'utf8'));
      const next = {...loadConfig(), ...patch};
      saveConfig(next);
      console.log('配置已保存，运行 `agy-remote start` 启动。');
    } else if (command === 'bind') {
      const {code, state} = await performBind();
      if (state.wecom?.fatalError) {
        console.error(`❌ ${state.wecom.fatalError}\n请重新执行 \`agy-remote setup\` 核对机器人凭证。`);
        process.exitCode = 1;
      } else {
        console.log(`请在企微单聊机器人发送 6 位绑定码：${code}（10 分钟内有效，${formatWeComStatus(state.wecom)}）`);
        const result = await watchBindingInTerminal({initiallyConnected: Boolean(state.wecom?.connected)});
        if (result.status === 'error' || result.status === 'stopped') process.exitCode = 1;
      }
    } else if (command === 'name') {
      const restArg = process.argv.slice(3).join(' ').trim();
      console.log(await runSlashCommand(`name ${restArg}`.trim()));
    } else if (command === 'alias') {
      const restArg = process.argv.slice(3).join(' ').trim();
      console.log(await runSlashCommand(`alias ${restArg}`.trim()));
    } else if (command === 'install-plugin') {
      console.log(installPlugin(loadConfig().agyBin));
    } else if (command === 'start') {
      const res = await performStart({restart: false});
      console.log(formatStartOutput({...res, action: '启动'}));
      if (res.state?.wecom?.fatalError) {
        process.exitCode = 1;
      } else if (res.code && !res.ownerUserId) {
        const result = await watchBindingInTerminal({initiallyConnected: Boolean(res.state?.wecom?.connected)});
        if (result.status === 'error' || result.status === 'stopped') process.exitCode = 1;
      }
    } else if (command === 'stop') {
      await stopService();
      console.log('已停止后台服务，运行 `agy-remote start` 恢复。');
    } else if (command === 'restart') {
      const res = await performStart({force: arg1 === 'force', restart: true});
      console.log(formatStartOutput({...res, action: '重启'}));
      if (res.state?.wecom?.fatalError) process.exitCode = 1;
    } else if (command === 'uninstall') {
      const msg = await uninstallService();
      uninstallPlugin(loadConfig().agyBin);
      console.log(msg);
    } else if (command === 'status' || command === 'doctor') {
      console.log(await formatStatusMarkdown());
    } else if (command === 'usage' || command === 'quota') {
      console.log(await runSlashCommand('usage'));
    } else {
      console.log([
        '用法：agy-remote <命令>',
        '',
        `  config [edit|path]     查看或打开单一配置表 (${CONFIG_FILE})`,
        '  setup [BotID Secret]   配置 BotID / Secret、安装 Hook 插件并等待绑定完成',
        '  bind                   重新生成 6 位企微绑定码并等待绑定完成',
        '  status | doctor        查看服务健康状态与活跃会话',
        '  usage | quota          按模型分组查看当前剩余额度与重置时间',
        '  start | stop | restart 管理 macOS launchd 后台服务',
        '  name [名称|auto|off|model <id|default|show>] 会话命名与模型设置',
        '  alias [别名] [目录]    查看或修改 config.json 中的目录别名（rm <别名> 删除）',
        '  install-plugin         仅安装/更新 agy 终端 Hook 插件',
        '  uninstall              停止服务、移除自启动并卸载 agy 插件',
        '  run                    前台直接运行 daemon',
      ].join('\n'));
    }
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
  }
}
