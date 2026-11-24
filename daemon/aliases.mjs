// 目录别名管理：统一存储在 config.json 的 `aliases` 字段中（保存即生效，无需重启 daemon），
// 同时兼容读取旧版独立 aliases.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RUN_DIR, CONFIG_FILE, loadConfig, updateConfigFile} from './config.mjs';

export const ALIASES_FILE = CONFIG_FILE;
const LEGACY_ALIASES_FILE = path.join(RUN_DIR, 'aliases.json');
const HOME = os.homedir();
const NAME = /^[\p{L}\p{N}_.-]{1,32}$/u;

export function expandDir(p) {
  if (!p || p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.isAbsolute(p) ? p : path.join(HOME, p);
}
export function tildeDir(p) {
  const abs = path.resolve(expandDir(p));
  return abs === HOME ? '~' : abs.startsWith(HOME + path.sep) ? '~' + abs.slice(HOME.length) : abs;
}
export function checkName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME.test(n)) throw new Error(`别名「${name}」无效：1–32 位字母、数字、中文或 _ . -，不含空格`);
  return n;
}

/** @returns {Record<string, string>} */
function normalize(table, where) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`${where} 应为 {"别名": "目录"}`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}：别名「${k}」的目录必须是非空字符串`);
    const name = checkName(k);
    if (name in out) throw new Error(`${where}：别名「${name}」重复（不区分大小写）`);
    out[name] = v.trim();
  }
  return out;
}

/** @returns {Record<string, string>} */
export function parseAliases(text, where = 'config.json aliases') {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`${where} 不是合法 JSON：${e.message}`); }
  return normalize(data, where);
}

/**
 * 优先读取 config.json 的 `aliases`（及 `dirAliases`）；若存在旧版独立 aliases.json 则合并。
 * @returns {Record<string, string>}
 */
export function loadAliases() {
  const cfg = loadConfig();
  const fromConfig = normalize(cfg.aliases || cfg.dirAliases || {home: '~'}, 'config.json aliases');
  try {
    const legacy = parseAliases(fs.readFileSync(LEGACY_ALIASES_FILE, 'utf8'), 'aliases.json');
    return {...fromConfig, ...legacy};
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return fromConfig;
}

/**
 * 保存别名表到 config.json 的 `aliases` 字段，并移除旧版独立 aliases.json。
 * @returns {Record<string, string>}
 */
export function saveAliases(table) {
  const clean = normalize(table, '别名表');
  const sorted = Object.fromEntries(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)));
  updateConfigFile({aliases: sorted});
  try { fs.rmSync(LEGACY_ALIASES_FILE, {force: true}); } catch {}
  return sorted;
}

/** Returns alias names whose directory does not exist (warning only, not an error). */
export function missingDirs(table) {
  return Object.entries(table).filter(([, d]) => !fs.existsSync(expandDir(d))).map(([n]) => n);
}
