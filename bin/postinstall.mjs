#!/usr/bin/env node
// npm postinstall：安装完成后自动预生成默认配置表 ~/.config/agy-remote-wecom/config.json 并注册 agy Hook 插件。
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ensureDefaultConfigFile, CONFIG_FILE} from '../daemon/config.mjs';

if (process.env.CI || process.env.AGY_REMOTE_SKIP_POSTINSTALL === '1') {
  process.exit(0);
}

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote.mjs');

try {
  ensureDefaultConfigFile();
  execFileSync(process.execPath, [BIN, 'install-plugin'], {
    stdio: 'ignore',
    timeout: 15_000,
  });
  const shortCfg = CONFIG_FILE.startsWith(os.homedir())
    ? '~' + CONFIG_FILE.slice(os.homedir().length)
    : CONFIG_FILE;
  console.log('\n✔ Agy Remote WeCom 已安装并注册到 Antigravity (agy)！');
  console.log('  1. 交互式配置（推荐）：运行 `agy-remote setup`');
  console.log(`  2. 或直接编辑配置表：  ${shortCfg}（填好后运行 \`agy-remote start\`）\n`);
} catch {
  // 若本机尚未安装 agy CLI 或非交互环境，静默跳过，不阻断 npm install
}
