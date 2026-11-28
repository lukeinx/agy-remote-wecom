// agy-remote 终端交互式配置菜单（对齐 pi-remote /remote 体验，覆盖全项配置且 0 Token）。
import fs from 'node:fs';
import path from 'node:path';
import {
  VALID_TERMINALS,
  DEFAULT_TAB_TITLE,
  CONFIG_FILE,
  diskVersion,
  ensureDefaultConfigFile,
  loadConfig,
  updateConfigFile,
} from '../daemon/config.mjs';
import {loadAliases, saveAliases, checkName, tildeDir, expandDir, missingDirs} from '../daemon/aliases.mjs';
import {readNamingPref, writeNamingPref, namingStatusLabel, resolveApiKey, DEFAULT_NAMING_MODEL} from '../daemon/naming.mjs';
import {createTui, CANCELLED} from './tui.mjs';

const TERMINAL_LABELS = {
  auto: '自动探测运行中的终端',
  cmux: 'cmux',
  ghostty: 'Ghostty (≥1.3)',
  iterm: 'iTerm2',
  wezterm: 'WezTerm',
  kitty: 'kitty',
  tmux: 'tmux',
  terminal: 'Terminal.app',
  none: '仅后台会话（不开终端）',
};

const MODE_OPTIONS = [
  {value: 'default', label: 'default', detail: '读写需确认'},
  {value: 'accept-edits', label: 'accept-edits', detail: '自动允许改文件'},
  {value: 'auto', label: 'auto', detail: '自动允许编辑与安全命令'},
  {value: 'plan', label: 'plan', detail: '先规划后执行'},
];

const CONFIRM_OPTIONS = [
  {value: 'ask-then-allow', label: 'ask-then-allow', detail: '弹卡片，超时自动放行'},
  {value: 'ask', label: 'ask', detail: '弹卡片，超时拒绝'},
  {value: 'allow', label: 'allow', detail: '全部自动放行，不弹卡片'},
];

function maskId(id = '') {
  const s = String(id || '').trim();
  if (!s) return '未配置';
  return s.length <= 10 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function buildMenuStatus(state, formatWeComStatus) {
  if (!state) return '⚪ 后台服务未运行';
  const conn = formatWeComStatus(state.wecom);
  const next = diskVersion();
  const update = state.version && state.version !== next ? ` · 新版本 v${next}` : '';
  return `${conn} · 活跃会话 ${(state.targets || []).length} · v${state.version || next}${update}`;
}

export async function runInteractiveMenu(deps = {}) {
  const {
    tui = createTui(),
    health,
    formatWeComStatus,
    formatPluginStatus,
    performQuickSetup,
    performBind,
    performStart,
    stopService,
    openConfigInEditor,
    watchBindingInTerminal,
    initialAction = '',
    cwd = process.cwd(),
    stdout = process.stdout,
  } = deps;

  ensureDefaultConfigFile();
  let notice = null;
  let autoSetupTriggered = false;
  let initialActionHandled = false;

  const setNotice = (text, tone = 'ok') => { notice = text ? {text, tone} : null; };

  async function flowSetup() {
    const running = await health().catch(() => null);
    if (running?.targets?.some((t) => t.busy)) {
      setNotice('⚠️ 请先等正在运行的遥控任务结束，再修改机器人凭证。', 'warn');
      return true;
    }
    const cfg = loadConfig();
    const botId = await tui.input({
      title: '1/3 企微机器人 BotID（企微工作台 → 智能机器人 → API 模式 → 长连接）',
      defaultValue: cfg.botId || '',
      placeholder: '输入 BotID',
      validate: (v) => (v ? '' : 'BotID 不能为空'),
    });
    if (botId === CANCELLED) return false;
    if (botId === null) return true;

    const secret = await tui.input({
      title: '2/3 Bot Secret（仅存本机，不进入模型）',
      defaultValue: cfg.secret || '',
      placeholder: cfg.secret ? '回车保持现有 Secret 不变' : '输入 Secret',
      mask: true,
      validate: (v) => (v ? '' : 'Secret 不能为空'),
    });
    if (secret === CANCELLED) return false;
    if (secret === null) return true;

    const bindModes = [
      ...(cfg.ownerUserId ? [{value: 'keep', label: '保留当前绑定', detail: cfg.ownerUserId}] : []),
      {value: 'code', label: '企微发送绑定码（推荐）', detail: '无需查 userid'},
      {value: 'manual', label: '手动填写 userid', detail: '直接指定主人账号'},
    ];
    const bindMode = await tui.select({
      title: '3/3 谁可以通过企微控制这台电脑？',
      items: bindModes,
    });
    if (bindMode === CANCELLED) return false;
    if (bindMode === null) return true;

    let ownerArg = '';
    if (bindMode === 'keep') {
      ownerArg = cfg.ownerUserId;
    } else if (bindMode === 'manual') {
      const manual = await tui.input({
        title: '主人企微 userid（不是显示姓名）',
        defaultValue: cfg.ownerUserId || '',
        placeholder: '输入 userid',
        validate: (v) => (v ? '' : 'userid 不能为空'),
      });
      if (manual === CANCELLED) return false;
      if (manual === null) return true;
      ownerArg = manual;
    }

    stdout.write('正在保存配置并启动后台服务...\n');
    try {
      const res = await performQuickSetup(botId, secret, ownerArg, {forceUnbind: bindMode === 'code'});
      if (res.state?.wecom?.fatalError) {
        setNotice(`❌ 配置已保存，但企微连接失败：${res.state.wecom.fatalError}`, 'error');
        return true;
      }
      if (res.code) {
        stdout.write(`${formatPluginStatus(res.plugin)}\n`);
        stdout.write(`\n👉 请在手机企业微信单聊该机器人，发送 6 位绑定码：${res.code}（10 分钟内有效）\n\n`);
        const watch = await watchBindingInTerminal({initiallyConnected: Boolean(res.state?.wecom?.connected)});
        if (watch?.status === 'bound') {
          const nextCfg = loadConfig();
          const aliasKeys = Object.keys(loadAliases());
          const needsProjectSetup = tildeDir(nextCfg.defaultDir || '~') === '~' && (aliasKeys.length === 0 || (aliasKeys.length === 1 && aliasKeys[0] === 'home'));
          setNotice(
            needsProjectSetup
              ? `✔ 配置并绑定成功（${watch.owner}）· 可在下方顺手添加项目目录别名与默认目录，或按 q 退出`
              : `✔ 配置并绑定成功（${watch.owner}）`,
          );
        } else if (watch?.status === 'error') {
          setNotice(`❌ ${watch.error || '企微连接失败'}`, 'error');
        } else {
          setNotice(`⚠️ 绑定未完成（${watch?.status || '已退出'}），可稍后选择「重新绑定」`, 'warn');
        }
        return true;
      }
      setNotice(`✔ 配置已保存并重启服务（${formatWeComStatus(res.state?.wecom)}）`);
    } catch (e) {
      setNotice(`⚠️ ${e?.message || e}`, 'error');
    }
    return true;
  }

  async function flowNaming() {
    while (true) {
      const cfg = loadConfig();
      const pref = readNamingPref(cfg);
      const hasKey = Boolean(resolveApiKey(pref.apiKey));
      const picked = await tui.select({
        title: '🏷️ 会话命名',
        status: namingStatusLabel(cfg),
        notice,
        items: [
          {value: 'toggle', label: pref.enabled ? '关闭自动命名' : '开启自动命名', detail: pref.enabled ? '当前已开启' : '当前已关闭'},
          {value: 'model', label: '命名模型', detail: pref.model || DEFAULT_NAMING_MODEL},
          {value: 'thinking', label: '思考链开关', detail: pref.thinking === 'low' ? 'low · 低思考' : 'off · 无思考'},
          {value: 'api', label: 'API 地址与 Key', detail: hasKey ? `${pref.apiKey || '$DEEPSEEK_API_KEY'}（已就绪）` : '未配 Key（使用本地短标题提取）'},
          {value: 'reset', label: '恢复默认命名模型', detail: DEFAULT_NAMING_MODEL},
        ],
      });
      setNotice(null);
      if (picked === CANCELLED) return false;
      if (picked === null) return true;

      if (picked === 'toggle') {
        if (pref.enabled) {
          writeNamingPref({enabled: false, source: 'off'});
          setNotice('✔ 已关闭自动命名（保存即生效）');
        } else {
          writeNamingPref({enabled: true, model: pref.model || DEFAULT_NAMING_MODEL, source: 'custom'});
          setNotice('✔ 已开启自动命名（保存即生效）');
        }
      } else if (picked === 'model') {
        const nextModel = await tui.input({
          title: '命名模型 ID',
          defaultValue: pref.model || DEFAULT_NAMING_MODEL,
          placeholder: DEFAULT_NAMING_MODEL,
          validate: (v) => (v ? '' : '模型 ID 不能为空'),
        });
        if (nextModel === CANCELLED) return false;
        if (nextModel !== null) {
          writeNamingPref({enabled: true, model: nextModel, source: 'custom'});
          setNotice(`✔ 命名模型已更新为 ${nextModel}`);
        }
      } else if (picked === 'thinking') {
        const nextThink = await tui.select({
          title: '命名思考链开关',
          items: [
            {value: 'off', label: 'off · 无思考', detail: '默认，更快更省', current: pref.thinking !== 'low'},
            {value: 'low', label: 'low · 低思考', detail: '略慢，适合复杂首条输入', current: pref.thinking === 'low'},
          ],
          initialIndex: pref.thinking === 'low' ? 1 : 0,
        });
        if (nextThink === CANCELLED) return false;
        if (nextThink !== null) {
          const prevTab = cfg.tabTitle && typeof cfg.tabTitle === 'object' ? cfg.tabTitle : {...DEFAULT_TAB_TITLE};
          updateConfigFile({tabTitle: {...prevTab, thinking: nextThink}});
          setNotice(`✔ 命名思考链已设为 ${nextThink}`);
        }
      } else if (picked === 'api') {
        const prevTab = cfg.tabTitle && typeof cfg.tabTitle === 'object' ? cfg.tabTitle : {...DEFAULT_TAB_TITLE};
        const apiUrl = await tui.input({
          title: 'OpenAI 兼容 Chat Completions 地址',
          defaultValue: prevTab.apiUrl || DEFAULT_TAB_TITLE.apiUrl,
          placeholder: DEFAULT_TAB_TITLE.apiUrl,
          validate: (v) => (/^https?:\/\//i.test(v) ? '' : '请输入 http(s):// 开头的完整 URL'),
        });
        if (apiUrl === CANCELLED) return false;
        if (apiUrl === null) continue;
        const apiKey = await tui.input({
          title: 'API Key（推荐写 $环境变量名，留空则回退本地提取）',
          defaultValue: prevTab.apiKey ?? '$DEEPSEEK_API_KEY',
          placeholder: '$DEEPSEEK_API_KEY',
        });
        if (apiKey === CANCELLED) return false;
        if (apiKey === null) continue;
        updateConfigFile({tabTitle: {...prevTab, apiUrl, apiKey}});
        setNotice('✔ 命名接口配置已保存（保存即生效）');
      } else if (picked === 'reset') {
        writeNamingPref({source: 'default'});
        setNotice(`✔ 已恢复默认命名模型：${DEFAULT_NAMING_MODEL}`);
      }
    }
  }

  async function flowAliases() {
    while (true) {
      const table = loadAliases();
      const missing = new Set(missingDirs(table));
      const entries = Object.entries(table);
      const picked = await tui.select({
        title: '📁 目录别名',
        status: `${entries.length} 个`,
        notice,
        items: [
          {value: '__add__', label: '＋ 新增别名', detail: '供手机「创建会话 别名」「目录」使用'},
          ...entries.map(([name, dir]) => ({
            value: name,
            label: name,
            detail: `${tildeDir(dir)}${missing.has(name) ? ' · ⚠️ 目录不存在' : ''}`,
          })),
        ],
      });
      setNotice(null);
      if (picked === CANCELLED) return false;
      if (picked === null) return true;

      if (picked === '__add__') {
        const rawName = await tui.input({
          title: '别名名称（1–32 位字母、数字、中文或 _ . -）',
          placeholder: '例如 work / vibe',
          validate: (v) => {
            try {
              const n = checkName(v);
              if (['rm', 'del', 'edit', 'list', 'ls', 'help'].includes(n)) return `「${n}」是保留字，换个名字`;
              return '';
            } catch (e) {
              return e.message;
            }
          },
        });
        if (rawName === CANCELLED) return false;
        if (rawName === null) continue;
        const name = checkName(rawName);
        const rawDir = await tui.input({
          title: `「${name}」对应的目录路径`,
          defaultValue: tildeDir(cwd),
          placeholder: '~/Projects/...',
          validate: (v) => {
            if (!v) return '目录不能为空';
            const abs = v === '.' ? cwd : v.startsWith('~') ? expandDir(v) : path.resolve(cwd, v);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `目录不存在：${abs}`;
            return '';
          },
        });
        if (rawDir === CANCELLED) return false;
        if (rawDir === null) continue;
        const abs = rawDir === '.' ? cwd : rawDir.startsWith('~') ? expandDir(rawDir) : path.resolve(cwd, rawDir);
        table[name] = tildeDir(abs);
        saveAliases(table);
        setNotice(`✔ 已保存别名 ${name} → ${table[name]}`);
        continue;
      }

      const currentDir = table[picked];
      const act = await tui.select({
        title: `📁 别名「${picked}」`,
        status: tildeDir(currentDir),
        items: [
          {value: 'edit', label: '修改目录'},
          {value: 'default', label: '设为默认新建目录', detail: '更新 defaultDir'},
          {value: 'delete', label: '删除别名'},
        ],
      });
      if (act === CANCELLED) return false;
      if (act === null) continue;
      if (act === 'edit') {
        const rawDir = await tui.input({
          title: `修改「${picked}」的目录`,
          defaultValue: tildeDir(currentDir),
          validate: (v) => {
            if (!v) return '目录不能为空';
            const abs = v === '.' ? cwd : v.startsWith('~') ? expandDir(v) : path.resolve(cwd, v);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `目录不存在：${abs}`;
            return '';
          },
        });
        if (rawDir === CANCELLED) return false;
        if (rawDir !== null) {
          const abs = rawDir === '.' ? cwd : rawDir.startsWith('~') ? expandDir(rawDir) : path.resolve(cwd, rawDir);
          table[picked] = tildeDir(abs);
          saveAliases(table);
          setNotice(`✔ 已更新 ${picked} → ${table[picked]}`);
        }
      } else if (act === 'default') {
        updateConfigFile({defaultDir: tildeDir(currentDir)});
        setNotice(`✔ 默认新建目录已设为 ${tildeDir(currentDir)}`);
      } else if (act === 'delete') {
        const ok = await tui.confirm({title: `删除别名「${picked}」？`, message: tildeDir(currentDir), defaultYes: false});
        if (ok === CANCELLED) return false;
        if (ok) {
          delete table[picked];
          saveAliases(table);
          setNotice(`✔ 已删除别名 ${picked}`);
        }
      }
    }
  }

  async function flowPreferences() {
    while (true) {
      const cfg = loadConfig();
      const picked = await tui.select({
        title: '⚙️ 偏好设置（保存即热生效）',
        notice,
        items: [
          {value: 'terminal', label: '默认终端', detail: cfg.terminal},
          {value: 'defaultDir', label: '默认新建目录', detail: tildeDir(cfg.defaultDir || '~')},
          {value: 'defaultMode', label: '默认后台模式', detail: cfg.defaultMode},
          {value: 'remoteConfirm', label: '远程权限确认', detail: cfg.remoteConfirm},
        ],
      });
      setNotice(null);
      if (picked === CANCELLED) return false;
      if (picked === null) return true;

      if (picked === 'terminal') {
        const items = VALID_TERMINALS.map((v) => ({
          value: v,
          label: v,
          detail: TERMINAL_LABELS[v] || '',
          current: v === cfg.terminal,
        }));
        const next = await tui.select({
          title: '选择手机「创建会话」使用的终端',
          items,
          initialIndex: Math.max(0, VALID_TERMINALS.indexOf(cfg.terminal)),
        });
        if (next === CANCELLED) return false;
        if (next !== null) {
          updateConfigFile({terminal: next});
          setNotice(`✔ 默认终端已设为 ${next}`);
        }
      } else if (picked === 'defaultDir') {
        const aliases = loadAliases();
        const curDir = tildeDir(cfg.defaultDir || '~');
        const cwdShort = tildeDir(cwd);
        const aliasDirs = new Set(Object.values(aliases).map((d) => tildeDir(d)));
        const items = [
          ...(cwdShort !== '~' && !aliasDirs.has(cwdShort) && fs.existsSync(cwd)
            ? [{value: cwdShort, label: `当前目录 · ${cwdShort}`, current: cwdShort === curDir}]
            : []),
          ...Object.entries(aliases).map(([k, d]) => ({
            value: tildeDir(d),
            label: `${k} · ${tildeDir(d)}`,
            current: tildeDir(d) === curDir,
          })),
          {value: '__custom__', label: '手动输入路径…'},
        ];
        const next = await tui.select({title: '选择默认新建目录', items});
        if (next === CANCELLED) return false;
        if (next === null) continue;
        let chosen = next;
        if (next === '__custom__') {
          const typed = await tui.input({
            title: '输入默认新建目录路径',
            defaultValue: curDir,
            validate: (v) => {
              if (!v) return '目录不能为空';
              const abs = v === '.' ? cwd : v.startsWith('~') ? expandDir(v) : path.resolve(cwd, v);
              if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `目录不存在：${abs}`;
              return '';
            },
          });
          if (typed === CANCELLED) return false;
          if (typed === null) continue;
          const abs = typed === '.' ? cwd : typed.startsWith('~') ? expandDir(typed) : path.resolve(cwd, typed);
          chosen = tildeDir(abs);
        }
        updateConfigFile({defaultDir: chosen});
        setNotice(`✔ 默认新建目录已设为 ${chosen}`);
      } else if (picked === 'defaultMode') {
        const items = MODE_OPTIONS.map((o) => ({...o, current: o.value === cfg.defaultMode}));
        const next = await tui.select({
          title: '选择新建后台会话的默认权限模式',
          items,
          initialIndex: Math.max(0, MODE_OPTIONS.findIndex((o) => o.value === cfg.defaultMode)),
        });
        if (next === CANCELLED) return false;
        if (next !== null) {
          updateConfigFile({defaultMode: next});
          setNotice(`✔ 默认后台模式已设为 ${next}`);
        }
      } else if (picked === 'remoteConfirm') {
        const items = CONFIRM_OPTIONS.map((o) => ({...o, current: o.value === cfg.remoteConfirm}));
        const next = await tui.select({
          title: '选择手机端工具权限确认策略',
          items,
          initialIndex: Math.max(0, CONFIRM_OPTIONS.findIndex((o) => o.value === cfg.remoteConfirm)),
        });
        if (next === CANCELLED) return false;
        if (next !== null) {
          updateConfigFile({remoteConfirm: next});
          setNotice(`✔ 远程权限确认策略已设为 ${next}`);
        }
      }
    }
  }

  async function flowBind() {
    const cfg = loadConfig();
    if (!cfg.botId || !cfg.secret) {
      setNotice('⚠️ 尚未配置机器人凭证，请先选择「配置机器人」。', 'warn');
      return true;
    }
    if (cfg.ownerUserId) {
      const ok = await tui.confirm({
        title: '确认重新绑定？',
        message: `将解除当前绑定（${cfg.ownerUserId}）并生成新绑定码`,
        defaultYes: false,
      });
      if (ok === CANCELLED) return false;
      if (!ok) return true;
    }
    try {
      const {code, state} = await performBind();
      if (state?.wecom?.fatalError) {
        setNotice(`❌ 企微连接失败：${state.wecom.fatalError}`, 'error');
        return true;
      }
      stdout.write(`\n👉 请在手机企业微信单聊该机器人，发送 6 位绑定码：${code}（10 分钟内有效）\n\n`);
      const watch = await watchBindingInTerminal({initiallyConnected: Boolean(state?.wecom?.connected)});
      if (watch?.status === 'bound') setNotice(`✔ 绑定成功（${watch.owner}）`);
      else if (watch?.status === 'error') setNotice(`❌ ${watch.error || '企微连接失败'}`, 'error');
      else setNotice(`⚠️ 绑定未完成（${watch?.status || '已退出'}）`, 'warn');
    } catch (e) {
      setNotice(`⚠️ ${e?.message || e}`, 'error');
    }
    return true;
  }

  async function flowRestart(running) {
    let force = false;
    const busy = (running?.targets || []).filter((t) => t.busy);
    if (running && busy.length) {
      const ok = await tui.confirm({
        title: `有 ${busy.length} 个运行中任务，强制重启？`,
        message: busy.map((t) => t.label).join('、'),
        defaultYes: false,
      });
      if (ok === CANCELLED) return false;
      if (!ok) return true;
      force = true;
    }
    try {
      const res = await performStart({restart: Boolean(running), force});
      if (res.state?.wecom?.fatalError) {
        setNotice(`❌ ${res.state.wecom.fatalError}`, 'error');
        return true;
      }
      setNotice(`✔ 服务已${running ? '重启' : '启动'}（${formatWeComStatus(res.state?.wecom)}）`);
    } catch (e) {
      setNotice(`⚠️ ${e?.message || e}`, 'error');
    }
    return true;
  }

  while (true) {
    if (initialAction === 'setup' && !initialActionHandled) {
      initialActionHandled = true;
      autoSetupTriggered = true;
      const cont = await flowSetup();
      if (!cont) return;
      continue;
    }
    const cfg = loadConfig();
    const configured = Boolean(cfg.botId && cfg.secret);
    if (!configured && !autoSetupTriggered) {
      autoSetupTriggered = true;
      const cont = await flowSetup();
      if (!cont) return;
      continue;
    }
    const state = await health().catch(() => null);
    const aliases = loadAliases();
    const aliasKeys = Object.keys(aliases);
    const aliasDetail = aliasKeys.length === 0
      ? '暂无（建议添加项目目录）'
      : aliasKeys.length === 1 && aliasKeys[0] === 'home'
        ? '仅默认 home（建议添加项目目录）'
        : `${aliasKeys.length} 个`;
    const items = [
      {value: 'setup', label: '配置机器人', detail: configured ? maskId(cfg.botId) : '未配置'},
      {value: 'name', label: '会话命名', detail: namingStatusLabel(cfg)},
      {value: 'alias', label: '目录别名', detail: aliasDetail},
      {value: 'prefs', label: '偏好设置', detail: `${cfg.terminal} · ${cfg.defaultMode} · ${cfg.remoteConfirm}`},
      {value: 'bind', label: '重新绑定', detail: cfg.ownerUserId ? cfg.ownerUserId : '待绑定'},
      {value: 'restart', label: state ? '重启服务' : '启动服务', detail: state ? '重新加载 daemon' : '启动后台守护进程'},
      ...(state ? [{value: 'stop', label: '停止服务', detail: '已有终端会话保留'}] : []),
      {value: 'edit', label: '编辑 config.json', detail: tildeDir(CONFIG_FILE)},
      {value: 'exit', label: '退出'},
    ];

    const action = await tui.select({
      title: '📱 Agy Remote',
      status: buildMenuStatus(state, formatWeComStatus),
      notice,
      items,
      backLabel: 'Esc / q 退出',
    });
    setNotice(null);
    if (action === null || action === CANCELLED || action === 'exit') return;

    let cont = true;
    if (action === 'setup') cont = await flowSetup();
    else if (action === 'name') cont = await flowNaming();
    else if (action === 'alias') cont = await flowAliases();
    else if (action === 'prefs') cont = await flowPreferences();
    else if (action === 'bind') cont = await flowBind();
    else if (action === 'restart') cont = await flowRestart(state);
    else if (action === 'stop') {
      await stopService();
      setNotice('✔ 后台服务已停止');
    } else if (action === 'edit') {
      const msg = openConfigInEditor();
      setNotice(msg, msg.startsWith('⚠️') ? 'warn' : 'ok');
    }
    if (!cont) return;
  }
}
