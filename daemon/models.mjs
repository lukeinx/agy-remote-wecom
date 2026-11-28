import {execFile} from 'node:child_process';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ID_RE = /-(low|medium|high|xhigh|max)$/i;
const EFFORT_NAME_RE = /\s*\((low|medium|high|xhigh|max)\)$/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CACHE_TTL_MS = 60_000;

const catalogCache = new Map();

export function extractEffortFromModel(modelStr = '') {
  const s = String(modelStr || '').trim();
  if (!s) return '';
  const mId = EFFORT_ID_RE.exec(s);
  if (mId) return mId[1].toLowerCase();
  const mName = EFFORT_NAME_RE.exec(s);
  if (mName) return mName[1].toLowerCase();
  return '';
}

export function stripEffortSuffix(modelId = '') {
  return String(modelId || '').trim().replace(EFFORT_ID_RE, '');
}

/**
 * 根据 agy 已知模型推断上下文窗口大小（与 agy acp usage_update.size 一致）。
 * 未知模型返回 0，交由 ACP usage_update 或显示层按未知处理。
 */
export function inferModelContextWindow(modelStr = '') {
  const s = String(modelStr || '').trim().toLowerCase();
  if (!s || s === 'auto') return 0;
  if (/^gemini(?:[-_\s]|$)|^orchestrator(?:\b|[-_\s(])/.test(s)) return 1_048_576;
  if (/^claude(?:[-_\s]|$).*(?:4[-._]6|5[-._]\d)/.test(s)) return 1_000_000;
  if (/^claude(?:[-_\s]|$)/.test(s)) return 200_000;
  if (/^gpt-oss-120b\b|^gpt-oss\s+120b\b/.test(s)) return 131_072;
  return 0;
}

const ORCHESTRATOR_LABELS = {
  'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-carbon': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-neon': 'Orchestrator (Neon)',
  'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
  'gemini-pro-orchestrator-g1-pro': 'Orchestrator (Argon)',
};

export function isOrchestratorModel(modelStr = '') {
  const s = String(modelStr || '').trim().toLowerCase();
  return /^gemini-pro-orchestrator(?:$|-)|^orchestrator(?:\b|\s*\()/i.test(s);
}

export function formatModelLabel(modelStr = '', {configOptions = null, catalog = null} = {}) {
  const s = String(modelStr || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (!/^gemini-pro-orchestrator(?:$|-)/.test(low)) return s;

  if (Array.isArray(configOptions)) {
    const modelOpt = configOptions.find((o) => o?.id === 'model');
    const hit = (modelOpt?.options || []).find((o) => String(o?.value || '').trim().toLowerCase() === low);
    if (hit?.name) return String(hit.name).trim();
  }
  if (Array.isArray(catalog?.models)) {
    for (const item of catalog.models) {
      if (String(item?.value || '').trim().toLowerCase() === low && item?.name) return String(item.name).trim();
      for (const v of item?.variants || []) {
        if (String(v?.value || '').trim().toLowerCase() === low && v?.name) return String(v.name).trim();
      }
    }
  }
  const base = stripEffortSuffix(low);
  if (ORCHESTRATOR_LABELS[low]) return ORCHESTRATOR_LABELS[low];
  if (ORCHESTRATOR_LABELS[base]) return ORCHESTRATOR_LABELS[base];
  const m = /^gemini-pro-orchestrator-([a-z0-9._-]+)$/.exec(base);
  if (m) {
    const variant = m[1]
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ');
    if (variant) return `Orchestrator (${variant})`;
  }
  return 'Orchestrator';
}

export function modelMatchesCurrent(currentModel = '', optionValue = '', optionName = '') {
  const cur = String(currentModel || '').trim().toLowerCase();
  const val = String(optionValue || '').trim().toLowerCase();
  if (!cur || !val) return false;
  if (cur === val) return true;
  if (stripEffortSuffix(cur) === val) return true;
  const name = String(optionName || '').trim().toLowerCase();
  if (name && cur === name) return true;
  return false;
}

export function parseAgyModelsOutput(raw = '') {
  const entries = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const seg = rawLine.includes('\r') ? rawLine.slice(rawLine.lastIndexOf('\r') + 1) : rawLine;
    const line = seg.replace(ANSI_RE, '').trim();
    if (!line || /fetching available models/i.test(line)) continue;
    const m = /^([a-z0-9][a-z0-9._-]+)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const id = m[1].trim();
    const name = m[2].trim();
    if (!/[-.]/.test(id)) continue;
    const idEffort = EFFORT_ID_RE.exec(id)?.[1]?.toLowerCase() || '';
    const nameEffort = EFFORT_NAME_RE.exec(name)?.[1]?.toLowerCase() || '';
    const effort = idEffort && idEffort === nameEffort ? idEffort : '';
    const baseId = effort ? id.slice(0, -(effort.length + 1)) : id;
    const baseName = effort ? name.replace(EFFORT_NAME_RE, '').trim() : name;
    entries.push({id, name, baseId, baseName, effort});
  }

  const groupBuckets = new Map();
  for (const e of entries) {
    if (!e.effort) continue;
    const arr = groupBuckets.get(e.baseId) || [];
    arr.push(e);
    groupBuckets.set(e.baseId, arr);
  }

  const models = [];
  const emitted = new Set();
  for (const e of entries) {
    const group = e.effort ? groupBuckets.get(e.baseId) : null;
    if (group && group.length >= 2) {
      if (emitted.has(e.baseId)) continue;
      emitted.add(e.baseId);
      const efforts = [...new Set(group.map((g) => g.effort))].sort((a, b) => {
        const ia = EFFORT_ORDER.indexOf(a);
        const ib = EFFORT_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      models.push({
        value: e.baseId,
        name: e.baseName,
        efforts,
        variants: group.map((g) => ({value: g.id, name: g.name, effort: g.effort})),
      });
    } else {
      if (emitted.has(e.id)) continue;
      emitted.add(e.id);
      models.push({
        value: e.id,
        name: e.name,
        efforts: [],
        variants: [{value: e.id, name: e.name, effort: e.effort}],
      });
    }
  }

  return {models, rawCount: entries.length};
}

export function findModelEntry(catalog, modelOrName = '') {
  const q = String(modelOrName || '').trim().toLowerCase();
  if (!q || !Array.isArray(catalog?.models)) return null;
  for (const item of catalog.models) {
    if (item.value.toLowerCase() === q || item.name.toLowerCase() === q) return item;
    if (modelMatchesCurrent(q, item.value)) return item;
    if (item.variants?.some((v) => v.value.toLowerCase() === q || v.name.toLowerCase() === q)) return item;
  }
  return null;
}

export function resolveVariantByDisplayName(catalog, displayName = '') {
  const q = String(displayName || '').trim().toLowerCase();
  if (!q || !Array.isArray(catalog?.models)) return null;
  for (const item of catalog.models) {
    for (const v of item.variants || []) {
      if (v.name.toLowerCase() === q || v.value.toLowerCase() === q) {
        return {modelId: v.value, baseId: item.value, name: v.name, effort: v.effort || ''};
      }
    }
    if (item.name.toLowerCase() === q) {
      return {modelId: item.value, baseId: item.value, name: item.name, effort: ''};
    }
  }
  return null;
}

export function clearCliModelsCache() {
  catalogCache.clear();
}

export async function fetchCliModels({bin = 'agy', timeoutMs = 15_000, useCache = true, execFileFn = execFile} = {}) {
  const key = String(bin || 'agy');
  const now = Date.now();
  if (useCache) {
    const hit = catalogCache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS && hit.catalog.models.length) return hit.catalog;
  }
  const stdout = await new Promise((resolve, reject) => {
    execFileFn(key, ['models'], {timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024}, (err, out, serr) => {
      if (err) reject(new Error(String(serr || err.message || 'agy models 执行失败').trim().slice(0, 200)));
      else resolve(String(out || ''));
    });
  });
  const catalog = parseAgyModelsOutput(stdout);
  if (useCache && catalog.models.length) {
    catalogCache.set(key, {at: now, catalog});
  }
  return catalog;
}
