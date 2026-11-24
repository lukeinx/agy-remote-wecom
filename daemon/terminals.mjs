// 创建会话的终端适配层：在电脑上开一个新终端标签页（或窗口/pane），在指定目录里跑 agy。
//
// 每个适配器只需要把四件事做到：
//   ① 工作目录 = cwd
//   ② 环境变量 AGY_REMOTE_TAB=<nonce>（agy hook 上报时回带，daemon 靠它精确认领这个会话）
//   ③ 初始命令 = agy [-i 首条消息]
//   ④ agy 退出后标签页最好留在 shell（可选）
// 认领只看 nonce，与终端无关 —— 所以新增一个终端只要写一个 open()。
//
// ⚠️ 不要用「模拟按键 / 剪贴板粘贴」实现任何适配器：按键的目标由「此刻焦点在哪」决定，
// 任何一步没到位就会把命令打进用户正在用的那个标签页（避免命令误投递）。
// 只用终端自己的 API（AppleScript 字典 / CLI / socket）。

import { execFile } from "node:child_process";

const run = (bin, args, timeout = 20_000) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout }, (e, so, se) =>
      e ? reject(new Error(String(se || e.message).trim().slice(0, 200))) : resolve(String(so).trim()),
    ),
  );
export const screenLocked = () => process.platform !== 'darwin' ? Promise.resolve(false)
  : run('ioreg', ['-n', 'Root', '-d1', '-r'], 5000).then((out) => /"IOConsoleLocked"\s*=\s*Yes/.test(out), () => false);
const ok = (bin, args) => run(bin, args, 3_000).then(() => true, () => false);
// 按 bundle id 判断 GUI 应用是否在运行：不会顺手把它启动起来，也不受进程名/路径差异影响
// （pgrep -x ghostty 在 macOS 上匹配不到 /Applications/Ghostty.app/.../ghostty）。
const running = (bundleId) =>
  process.platform !== "darwin"
    ? Promise.resolve(false)
    : run("osascript", ["-e", `application id "${bundleId}" is running`], 3_000).then((o) => o === "true", () => false);

/** POSIX shell 单引号转义 */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** 在 shell 里执行的一行命令：cd + 带 nonce 的 agy。用 env 而不是 VAR=x 前缀，fish 也能跑。 */
// agyCmd is an internally shell-quoted launcher command, not raw config.agyCmd.
const shellLine = ({ cwd, nonce, agyCmd }) => `cd ${sq(cwd)} && env AGY_REMOTE_TAB=${nonce} ${agyCmd}`;

const osascript = (script, argv) => run("osascript", ["-e", script, ...argv]);

export const ADAPTERS = {
  ghostty: {
    label: "Ghostty",
    gui: true,
    hint: "需要 Ghostty ≥1.3，并在 系统设置 › 隐私与安全性 › 自动化 中允许",
    detect: () => running("com.mitchellh.ghostty"),
    // Ghostty 1.3+ 原生 AppleScript：目录 / 环境变量 / 初始输入都作为新 surface 的配置传入，
    // 只作用于新建的那个终端。initial input 而非 command：agy 退出后回到 shell。
    open: ({ cwd, nonce, agyCmd }) =>
      osascript(
        `on run argv
          set {theCwd, theEnv, theInput} to argv
          tell application "Ghostty"
            set cfg to new surface configuration
            set initial working directory of cfg to theCwd
            set environment variables of cfg to {theEnv}
            set initial input of cfg to theInput
            if (count of windows) > 0 then
              set t to new tab in front window with configuration cfg
            else
              set w to new window with configuration cfg
              set t to selected tab of w
            end if
            activate
            return id of t
          end tell
        end run`,
        [cwd, `AGY_REMOTE_TAB=${nonce}`, `${agyCmd}\n`],
      ),
  },

  cmux: {
    label: "cmux",
    gui: true,
    hint: "需要 cmux 正在运行（cmux ping 能通）",
    detect: () => ok("cmux", ["ping"]),
    open: ({ cwd, nonce, agyCmd }) =>
      run("cmux", [
        "new-workspace",
        "--cwd", cwd,
        "--env", `AGY_REMOTE_TAB=${nonce}`,
        // env 前缀是双保险：--env 是否传进初始命令取决于 cmux 版本
        "--command", `env AGY_REMOTE_TAB=${nonce} ${agyCmd}`,
        "--focus", "true",
      ]),
  },

  iterm: {
    label: "iTerm2",
    gui: true,
    hint: "需要 iTerm2，并在 系统设置 › 隐私与安全性 › 自动化 中允许",
    detect: () => running("com.googlecode.iterm2"),
    open: (o) =>
      osascript(
        `on run argv
          set theCmd to item 1 of argv
          tell application "iTerm2"
            if (count of windows) = 0 then
              set w to (create window with default profile command theCmd)
            else
              set w to current window
              tell w to create tab with default profile command theCmd
            end if
            activate
            return id of w
          end tell
        end run`,
        [`/bin/sh -c ${sq(`${shellLine(o)}; exec ${sq(process.env.SHELL || "/bin/sh")} -l`)}`],
      ),
  },

  wezterm: {
    label: "WezTerm",
    gui: true,
    hint: "需要 WezTerm 正在运行（wezterm cli list 能通）",
    detect: () => ok("wezterm", ["cli", "list"]),
    // 用登录 shell 包一层：agy 退出后留在 shell，且 PATH 与手开的标签页一致
    open: ({ cwd, nonce, agyCmd }) =>
      run("wezterm", [
        "cli", "spawn", "--cwd", cwd, "--",
        "sh", "-c", `env AGY_REMOTE_TAB=${nonce} ${agyCmd}; exec "\${SHELL:-/bin/sh}" -l`,
      ]),
  },

  kitty: {
    label: "kitty",
    gui: true,
    hint: "需要 kitty 开启 allow_remote_control=socket-only 与 listen_on，并配置 kittySocket",
    detect: (cfg = {}) => ok("kitty", ["@", ...(cfg.kittySocket ? ["--to", cfg.kittySocket] : []), "ls"]),
    open: ({ cwd, nonce, agyCmd, kittySocket }) =>
      run("kitty", [
        "@", ...(kittySocket ? ["--to", kittySocket] : []), "launch", "--type=tab", "--cwd", cwd, "--env", `AGY_REMOTE_TAB=${nonce}`,
        "sh", "-c", `${agyCmd}; exec "\${SHELL:-/bin/sh}" -l`,
      ]),
  },

  tmux: {
    label: "tmux",
    gui: false, // 不依赖图形界面：锁屏下照样能开
    hint: "需要 tmux ≥3.0",
    detect: () => ok("tmux", ["list-sessions"]),
    open: async ({ cwd, nonce, agyCmd, tmuxSession }) => {
      const cmd = `env AGY_REMOTE_TAB=${nonce} ${agyCmd}; exec "\${SHELL:-/bin/sh}" -l`;
      const has = await ok("tmux", ["has-session", "-t", tmuxSession]);
      const args = has
        ? ["new-window", "-t", `${tmuxSession}:`, "-c", cwd, "-P", "-F", "#{session_name}:#{window_index}", cmd]
        : ["new-session", "-d", "-s", tmuxSession, "-c", cwd, "-P", "-F", "#{session_name}:#{window_index}", cmd];
      return run("tmux", args);
    },
  },

  terminal: {
    label: "Terminal.app",
    gui: true,
    hint: "需要在 系统设置 › 隐私与安全性 › 自动化 中允许控制「终端」",
    detect: () => running("com.apple.Terminal"),
    open: (o) =>
      osascript(
        `on run argv
          tell application "Terminal"
            do script (item 1 of argv)
            activate
          end tell
          return "window"
        end run`,
        [shellLine(o)],
      ),
  },
};

// auto 模式的探测顺序：先专门的，最后才是系统自带
const AUTO_ORDER = ["cmux", "ghostty", "iterm", "wezterm", "kitty", "tmux", "terminal"];

/** 按配置选适配器；返回 { name, ...adapter } 或 null（= 没有可用终端，调用方降级为后台会话）。 */
export async function resolveTerminal(cfg) {
  const want = String(cfg.terminal || "auto").toLowerCase();
  if (want === "none") return null;
  if (want !== "auto") {
    const a = ADAPTERS[want];
    if (!a) throw new Error(`未知终端 "${want}"，可选：auto / ${Object.keys(ADAPTERS).join(" / ")} / none`);
    return { name: want, ...a };
  }
  for (const name of AUTO_ORDER) {
    if (await ADAPTERS[name].detect(cfg)) return { name, ...ADAPTERS[name] };
  }
  return null;
}

// ───────────────────────── 向已打开的 agy 终端会话投递输入 ─────────────────────────
// agy 没有 Pi 那样的进程内扩展 API，手机消息只能「打字」进 TUI。
// 与上面的约束一致：只用终端自己按 ID 定位的 API（tmux pane / WezTerm pane / kitty window /
// Ghostty、iTerm2 按 tty 找 surface），绝不依赖前台焦点。
// loc 来自 hook 上报：{ tty, tmuxPane, tmuxSocket, weztermPane, kittyWindow, kittySocket, termProgram, cmuxSurface }

/** 该终端位置能否被定位投递；返回适配器名或 null */
export function injectKind(loc = {}) {
  if (loc.tmuxPane) return "tmux";
  if (loc.weztermPane) return "wezterm";
  if (loc.kittyWindow) return "kitty";
  if (loc.cmuxSurface) return "cmux";
  const tp = String(loc.termProgram || "").toLowerCase();
  if (loc.tty && tp === "ghostty") return "ghostty";
  if (loc.tty && (tp === "iterm.app" || tp === "iterm2")) return "iterm";
  return null;
}
const tmuxBase = (loc) => (loc.tmuxSocket ? ["-S", loc.tmuxSocket] : []);
const kittyBase = (loc) => ["@", ...(loc.kittySocket ? ["--to", loc.kittySocket] : [])];
const ghosttyFind = `on findTerm(theTty)
    tell application "Ghostty"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in terminals of t
            if tty of s is theTty then return s
          end repeat
        end repeat
      end repeat
    end tell
    error "未找到 tty 对应的 Ghostty 终端"
  end findTerm`;
const ghosttyFindTab = `on findTab(theTty)
    tell application "Ghostty"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in terminals of t
            if tty of s is theTty then return {t, s}
          end repeat
        end repeat
      end repeat
    end tell
    error "未找到 tty 对应的 Ghostty 标签页"
  end findTab`;
const itermFind = `on findSess(theTty)
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is theTty then return s
          end repeat
        end repeat
      end repeat
    end tell
    error "未找到 tty 对应的 iTerm2 会话"
  end findSess`;

/** 把一段文字作为一次输入提交（粘贴 + 回车）。失败抛错，调用方降级。 */
export async function injectText(loc, text) {
  const kind = injectKind(loc);
  const body = String(text).replace(/\r\n?/g, "\n");
  if (kind === "tmux") {
    await run("tmux", [...tmuxBase(loc), "send-keys", "-t", loc.tmuxPane, "-l", body]);
    await new Promise((r) => setTimeout(r, 150));
    return run("tmux", [...tmuxBase(loc), "send-keys", "-t", loc.tmuxPane, "Enter"]);
  }
  if (kind === "wezterm") {
    await run("wezterm", ["cli", "send-text", "--pane-id", String(loc.weztermPane), body]);
    await new Promise((r) => setTimeout(r, 150));
    return run("wezterm", ["cli", "send-text", "--pane-id", String(loc.weztermPane), "--no-paste", "\r"]);
  }
  if (kind === "kitty") {
    await run("kitty", [...kittyBase(loc), "send-text", "--bracketed-paste", "enable", "--match", `id:${loc.kittyWindow}`, body]);
    await new Promise((r) => setTimeout(r, 150));
    return run("kitty", [...kittyBase(loc), "send-text", "--match", `id:${loc.kittyWindow}`, "\r"]);
  }
  if (kind === "cmux") {
    await run("cmux", ["send", "--surface", String(loc.cmuxSurface), body]);
    await new Promise((r) => setTimeout(r, 150));
    return run("cmux", ["send-key", "--surface", String(loc.cmuxSurface), "Enter"]);
  }
  if (kind === "ghostty") {
    return osascript(`${ghosttyFind}
  on run argv
    set {theTty, theText} to argv
    set s to my findTerm(theTty)
    tell application "Ghostty"
      input text theText to s
      delay 0.15
      send key "enter" to s
      send key "enter" action release to s
    end tell
    return "ok"
  end run`, [loc.tty, body]);
  }
  if (kind === "iterm") {
    return osascript(`${itermFind}
  on run argv
    set {theTty, theText} to argv
    set s to my findSess(theTty)
    tell application "iTerm2" to tell s to write text theText
    return "ok"
  end run`, [loc.tty, body]);
  }
  throw new Error("该终端不支持远程输入");
}

/** 发送 Esc：中断 agy 当前轮次 */
export async function injectEscape(loc) {
  const kind = injectKind(loc);
  if (kind === "tmux") return run("tmux", [...tmuxBase(loc), "send-keys", "-t", loc.tmuxPane, "Escape"]);
  if (kind === "wezterm") return run("wezterm", ["cli", "send-text", "--pane-id", String(loc.weztermPane), "--no-paste", "\x1b"]);
  if (kind === "kitty") return run("kitty", [...kittyBase(loc), "send-text", "--match", `id:${loc.kittyWindow}`, "\x1b"]);
  if (kind === "cmux") return run("cmux", ["send-key", "--surface", String(loc.cmuxSurface), "Escape"]);
  if (kind === "ghostty") return osascript(`${ghosttyFind}
  on run argv
    set s to my findTerm(item 1 of argv)
    tell application "Ghostty"
      send key "escape" to s
      send key "escape" action release to s
    end tell
    return "ok"
  end run`, [loc.tty]);
  if (kind === "iterm") return osascript(`${itermFind}
  on run argv
    set s to my findSess(item 1 of argv)
    tell application "iTerm2" to tell s to write text (ASCII character 27) newline NO
    return "ok"
  end run`, [loc.tty]);
  throw new Error("该终端不支持远程按键");
}

/**
 * 设置终端标签页标题（对齐 pi-remote 的 tab-title：支持动态状态图标 + 中文短标题）。
 * 优先使用各终端的原生 API（如 Ghostty 的 name override，不会被 TUI 自己的 OSC 标题刷掉），
 * 并同时向 tty 写入 OSC 0 序列作为通用双保险。
 */
export async function setTabTitle(loc = {}, title = "", { oscOnly = false } = {}) {
  const clean = String(title || "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const kind = injectKind(loc);
  if (loc.tty && loc.tty.startsWith("/dev/")) {
    try {
      const fs = await import("node:fs");
      fs.writeFileSync(loc.tty, `\x1b]0;${clean}\x07`);
    } catch {}
  }
  if (oscOnly) return;
  try {
    if (kind === "ghostty") {
      await osascript(`${ghosttyFindTab}
  on run argv
    set {theTty, theTitle} to argv
    set {t, s} to my findTab(theTty)
    tell application "Ghostty"
      set name override of t to theTitle
      set name override of s to theTitle
    end tell
    return "ok"
  end run`, [loc.tty, clean]);
    } else if (kind === "cmux" && loc.cmuxSurface) {
      await run("cmux", ["rename-tab", "--surface", String(loc.cmuxSurface), clean || "agy"], 3000);
    } else if (kind === "tmux" && loc.tmuxPane) {
      await run("tmux", [...tmuxBase(loc), "rename-window", "-t", loc.tmuxPane, clean || "agy"], 3000);
    } else if (kind === "wezterm" && loc.weztermPane) {
      await run("wezterm", ["cli", "set-tab-title", "--pane-id", String(loc.weztermPane), clean || "agy"], 3000);
    } else if (kind === "kitty" && loc.kittyWindow) {
      await run("kitty", [...kittyBase(loc), "set-tab-title", "--match", `id:${loc.kittyWindow}`, clean || "agy"], 3000);
    } else if (kind === "iterm" && loc.tty) {
      await osascript(`${itermFind}
  on run argv
    set {theTty, theTitle} to argv
    set s to my findSess(theTty)
    tell application "iTerm2" to tell s to set name to theTitle
    return "ok"
  end run`, [loc.tty, clean]);
    }
  } catch {}
}

// CLI 自检：`node terminals.mjs` 列出探测结果；`node terminals.mjs open <name> <dir>` 实际开一个
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , sub, name, dir] = process.argv;
  if (sub === "open") {
    const a = ADAPTERS[name];
    if (!a) throw new Error(`未知终端 ${name}`);
    const id = await a.open({ cwd: dir || process.cwd(), nonce: `test${Date.now().toString(36)}`, agyCmd: "agy", tmuxSession: "agy" });
    console.log(`opened ${name}: ${id}`);
  } else {
    for (const n of AUTO_ORDER) console.log(`${(await ADAPTERS[n].detect()) ? "✓" : "·"} ${n}`);
  }
}
