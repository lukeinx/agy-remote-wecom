import {execFile} from 'node:child_process';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MODELS_PREFIX_RE = /^Models within this group:\s*(.+)$/i;
const WINDOW_ORDER = {'5h': 0, daily: 1, weekly: 2};
const USAGE_CACHE_TTL_MS = 30_000;

const usageCache = new Map();
const usageInflight = new Map();

export function clearCliUsageCache() {
  usageCache.clear();
  usageInflight.clear();
}

const pad2 = (n) => String(n).padStart(2, '0');

function normalizeWindow(bucket = {}) {
  const raw = String(bucket.window || '').trim().toLowerCase();
  if (raw === '5h' || raw === 'weekly' || raw === 'daily') return raw;
  const hay = `${raw} ${bucket.id || ''} ${bucket.name || ''}`;
  if (/(?:^|[-_\s])5h(?:$|[-_\s])|five[-_\s]?hour/i.test(hay)) return '5h';
  if (/(?:^|[-_\s])(daily|24h|1d)(?:$|[-_\s])/i.test(hay)) return 'daily';
  if (/(?:^|[-_\s])(weekly|7d)(?:$|[-_\s])/i.test(hay)) return 'weekly';
  return raw;
}

function clampFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function extractGroupModels(description = '') {
  const m = MODELS_PREFIX_RE.exec(String(description || '').trim());
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function sortBuckets(buckets = []) {
  return buckets
    .map((b, idx) => ({b, idx}))
    .sort((a, b) => {
      const wa = WINDOW_ORDER[a.b.window] ?? 99;
      const wb = WINDOW_ORDER[b.b.window] ?? 99;
      return wa !== wb ? wa - wb : a.idx - b.idx;
    })
    .map((x) => x.b);
}

function parseJsonPayload(raw = '') {
  const cleaned = String(raw || '').replace(ANSI_RE, '').trim();
  if (!cleaned) throw new Error('agy /usage 未返回内容');
  try {
    return JSON.parse(cleaned);
  } catch {}

  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const seg = lines[i].includes('\r') ? lines[i].slice(lines[i].lastIndexOf('\r') + 1).trim() : lines[i];
    if (!seg.startsWith('{')) continue;
    try {
      return JSON.parse(seg);
    } catch {}
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  throw new Error('无法解析 agy /usage 返回的 JSON');
}

function parseTsvFallback(response = '') {
  const map = new Map();
  for (const rawLine of String(response || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes('\t')) continue;
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 3) continue;
    const [groupName, bucketName, pctRaw, resetTime = ''] = cols;
    const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(pctRaw);
    if (!groupName || !pctMatch) continue;
    const group = map.get(groupName) || {name: groupName, description: '', models: [], buckets: []};
    group.buckets.push({
      id: '',
      name: bucketName,
      description: '',
      window: normalizeWindow({name: bucketName}),
      remainingFraction: clampFraction(Number(pctMatch[1]) / 100),
      resetTime,
    });
    map.set(groupName, group);
  }
  return [...map.values()].map((g) => ({...g, buckets: sortBuckets(g.buckets)}));
}

export function parseAgyUsageOutput(raw = '') {
  const payload = parseJsonPayload(raw);
  if (payload?.status && String(payload.status).toUpperCase() !== 'SUCCESS') {
    const detail = String(payload.error || payload.response || payload.status).replace(ANSI_RE, '').trim();
    throw new Error(detail.slice(0, 200) || 'agy /usage 返回失败状态');
  }

  const rawGroups = Array.isArray(payload?.command?.data?.groups) ? payload.command.data.groups : [];
  let groups = [];
  if (rawGroups.length) {
    groups = rawGroups
      .filter((g) => g && typeof g === 'object' && String(g.name || '').trim())
      .map((g) => {
        const name = String(g.name).trim();
        const description = String(g.description || '').trim();
        const models = extractGroupModels(description);
        const buckets = sortBuckets(
          (Array.isArray(g.buckets) ? g.buckets : [])
            .filter((b) => b && typeof b === 'object')
            .map((b) => ({
              id: String(b.id || '').trim(),
              name: String(b.name || '').trim(),
              description: String(b.description || '').trim(),
              window: normalizeWindow(b),
              remainingFraction: clampFraction(b.remaining_fraction),
              resetTime: b.reset_time ? String(b.reset_time).trim() : '',
            })),
        );
        return {name, description, models, buckets};
      })
      .filter((g) => g.buckets.length > 0);
  } else if (typeof payload?.response === 'string' && payload.response.trim()) {
    groups = parseTsvFallback(payload.response);
  }

  return {
    groups,
    description: String(payload?.command?.data?.description || '').trim(),
  };
}

export function windowLabel(bucket = {}) {
  if (bucket.window === '5h') return '5小时';
  if (bucket.window === 'daily') return '每日';
  if (bucket.window === 'weekly') return '每周';
  return bucket.name || bucket.window || bucket.id || '额度';
}

export function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return '未知';
  return `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
}

export function formatResetDuration(ms) {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '1分钟内';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? `${d}天${h}h` : `${d}天`;
  if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

export function formatLocalResetClock(date, nowDate = new Date()) {
  const hhmm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const sameYear = date.getFullYear() === nowDate.getFullYear();
  const sameDay = sameYear && date.getMonth() === nowDate.getMonth() && date.getDate() === nowDate.getDate();
  if (sameDay) return hhmm;
  const mmdd = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (sameYear) return `${mmdd} ${hhmm}`;
  return `${date.getFullYear()}-${mmdd} ${hhmm}`;
}

export function formatUsageClock(now = Date.now()) {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatResetLabel(bucket = {}, now = Date.now()) {
  if (Number.isFinite(bucket.remainingFraction) && bucket.remainingFraction >= 1 && !bucket.description) {
    return '';
  }
  if (!bucket.resetTime) return '';
  const resetMs = Date.parse(bucket.resetTime);
  if (!Number.isFinite(resetMs)) return '';
  const diff = resetMs - now;
  if (diff <= 0) return '即将重置';
  const rel = formatResetDuration(diff);
  if (rel === '1分钟内') return '1分钟内';
  const abs = formatLocalResetClock(new Date(resetMs), new Date(now));
  return `${rel} · ${abs}`;
}

const MODEL_EFFORT_SUFFIX_RE = /(?:\s*\((?:low|medium|high|xhigh|max)\)|-(?:low|medium|high|xhigh|max))$/i;

function normalizeModelTokens(value = '') {
  return String(value || '')
    .trim()
    .replace(MODEL_EFFORT_SUFFIX_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function groupMatchesModel(group = {}, currentModel = '') {
  const cur = normalizeModelTokens(currentModel);
  if (!cur) return false;
  const candidates = group.models?.length ? group.models : [group.name];
  return candidates.some((name) => {
    const norm = normalizeModelTokens(name);
    return Boolean(norm) && (cur === norm || cur.startsWith(`${norm} `) || norm.startsWith(`${cur} `));
  });
}

export function formatGroupModels(models = []) {
  const list = (Array.isArray(models) ? models : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return '';

  const parsed = list.map((raw) => {
    const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(raw);
    if (paren) return {raw, key: `p:${paren[1].trim()}`, base: paren[1].trim(), variant: paren[2].trim()};
    const ver = /^([A-Za-z][A-Za-z0-9-]*\s+\d+(?:\.\d+)*)\s+(.+)$/.exec(raw);
    if (ver) return {raw, key: `v:${ver[1].trim()}`, base: ver[1].trim(), variant: ver[2].trim()};
    return {raw, key: '', base: '', variant: ''};
  });

  const groups = new Map();
  for (const item of parsed) {
    if (!item.key) continue;
    const arr = groups.get(item.key) || [];
    arr.push(item);
    groups.set(item.key, arr);
  }

  const emitted = new Set();
  const out = [];
  for (const item of parsed) {
    const bucket = item.key ? groups.get(item.key) : null;
    if (bucket && bucket.length >= 2) {
      if (emitted.has(item.key)) continue;
      emitted.add(item.key);
      out.push(`${item.base} (${bucket.map((x) => x.variant).join(' / ')})`);
    } else {
      out.push(item.raw);
    }
  }
  return out.join(' · ');
}

const escapeCell = (s) => String(s || '').replace(/\|/g, '\\|');

export function formatUsageBody(groups = [], {now = Date.now(), currentModel = ''} = {}) {
  return groups
    .map((group) => {
      const tag = groupMatchesModel(group, currentModel) ? ' `当前`' : '';
      const lines = [
        `**${group.name}**${tag}`,
        '',
        '| 窗口 | 剩余 | 重置 |',
        '|---|---|---|',
      ];
      for (const bucket of group.buckets || []) {
        const win = escapeCell(windowLabel(bucket));
        const pct = formatPercent(bucket.remainingFraction);
        const reset = escapeCell(formatResetLabel(bucket, now) || '—');
        lines.push(`| ${win} | **${pct}** | ${reset} |`);
      }
      const modelsLine = formatGroupModels(group.models);
      if (modelsLine) lines.push('', `> ${modelsLine}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export async function fetchCliUsage({
  bin = 'agy',
  timeoutMs = 20_000,
  useCache = true,
  cacheTtlMs = USAGE_CACHE_TTL_MS,
  execFileFn = execFile,
} = {}) {
  const key = String(bin || 'agy');
  const now = Date.now();
  if (useCache && cacheTtlMs > 0) {
    const hit = usageCache.get(key);
    if (hit && now - hit.at < cacheTtlMs && hit.data.groups.length) {
      return {...hit.data, cached: true};
    }
    const inflight = usageInflight.get(key);
    if (inflight) return inflight;
  }

  const printTimeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000) - 2);
  const work = (async () => {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFileFn(
          key,
          ['-p', '/usage', '--output-format', 'json', '--print-timeout', `${printTimeoutSec}s`],
          {
            timeout: timeoutMs,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            env: {...process.env, AGY_REMOTE_ACP: '1'},
          },
          (err, out, serr) => {
            if (err) {
              const detail = String(serr || out || err.message || 'agy /usage 执行失败').replace(ANSI_RE, '').trim();
              reject(new Error(detail.slice(0, 200)));
            } else {
              resolve(String(out || ''));
            }
          },
        );
      });
      const parsed = parseAgyUsageOutput(stdout);
      const result = {...parsed, fetchedAt: Date.now(), cached: false};
      if (cacheTtlMs > 0) {
        if (result.groups.length) usageCache.set(key, {at: result.fetchedAt, data: result});
        else usageCache.delete(key);
      }
      return result;
    } finally {
      if (usageInflight.get(key) === work) usageInflight.delete(key);
    }
  })();

  if (useCache && cacheTtlMs > 0) {
    usageInflight.set(key, work);
  }
  return work;
}
