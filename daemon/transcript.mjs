// 读 agy 会话 transcript（ACP 会话与终端会话共用同一份）：回顾、最终回复、产物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const brainDir = (dataDir, id) => path.join(dataDir, 'brain', id);
export const transcriptCompactFile = (dataDir, id) => path.join(brainDir(dataDir, id), '.system_generated', 'logs', 'transcript.jsonl');
export const transcriptFile = (dataDir, id) => path.join(brainDir(dataDir, id), '.system_generated', 'logs', 'transcript_full.jsonl');

function resolveTranscriptUsageFile(dataDir, id, explicitPath = '') {
  const candidates = [];
  if (explicitPath) {
    const dir = path.dirname(explicitPath);
    if (path.basename(explicitPath) === 'transcript_full.jsonl') {
      candidates.push(path.join(dir, 'transcript.jsonl'));
    }
    candidates.push(explicitPath);
  }
  if (dataDir && id) {
    candidates.push(transcriptCompactFile(dataDir, id));
    candidates.push(transcriptFile(dataDir, id));
  }
  const seen = new Set();
  for (const file of candidates) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) return {file, stat};
    } catch {}
  }
  return null;
}

/**
 * 从 agy transcript 读取最新上下文占用 token 数与最近模型名。
 * 公式与 agy acp usage_update.used 对齐：最新一条含 token 字段的 PLANNER_RESPONSE 的
 * input_tokens + cache_read_tokens + output_tokens。
 * 若最新为 CHECKPOINT（刚压缩且尚未产生新的 PLANNER_RESPONSE），返回 afterCheckpoint=true、usedTokens=null。
 */
export function readContextUsage(dataDir, id, {transcriptPath = '', cache = null} = {}) {
  const hit = resolveTranscriptUsageFile(dataDir, id, transcriptPath);
  if (!hit) {
    return {
      found: false,
      file: '',
      mtimeMs: 0,
      statKey: '',
      hasSteps: false,
      hasTurns: false,
      afterCheckpoint: false,
      usedTokens: null,
      model: '',
    };
  }
  const statKey = `${hit.file}:${hit.stat.mtimeMs}:${hit.stat.size}`;
  if (cache && cache.statKey === statKey && cache.result) return cache.result;

  const steps = readSteps(hit.file);
  let hasTurns = false;
  let afterCheckpoint = false;
  let usedTokens = null;
  let model = '';

  for (const st of steps) {
    if (!st || typeof st !== 'object') continue;
    if (typeof st.model === 'string' && st.model.trim()) {
      model = st.model.trim();
    }
    if (st.type === 'USER_INPUT') {
      hasTurns = true;
      continue;
    }
    if (st.type === 'CHECKPOINT') {
      afterCheckpoint = true;
      usedTokens = null;
      continue;
    }
    if (st.type === 'PLANNER_RESPONSE') {
      hasTurns = true;
      const hasTok = ['input_tokens', 'cache_read_tokens', 'output_tokens']
        .some((k) => typeof st[k] === 'number' && Number.isFinite(st[k]));
      if (hasTok) {
        usedTokens = (Number(st.input_tokens) || 0)
          + (Number(st.cache_read_tokens) || 0)
          + (Number(st.output_tokens) || 0);
        afterCheckpoint = false;
      }
    }
  }

  if (!hasTurns && !afterCheckpoint && usedTokens == null) {
    usedTokens = 0;
  }

  const result = {
    found: true,
    file: hit.file,
    mtimeMs: hit.stat.mtimeMs,
    statKey,
    hasSteps: steps.length > 0,
    hasTurns,
    afterCheckpoint,
    usedTokens,
    model,
  };
  if (cache) {
    cache.statKey = statKey;
    cache.result = result;
  }
  return result;
}

export function readSteps(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** 取 <USER_REQUEST> 里的正文；没有标签就原样返回 */
export function userText(content) {
  const s = String(content || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m ? m[1] : s).trim();
}

/** 拆成轮次：[{question, answer, steps}] */
export function turns(steps) {
  const out = [];
  let cur = null;
  for (const st of steps) {
    if (st.type === 'USER_INPUT') {
      cur = {question: userText(st.content), answer: '', steps: [st]};
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.steps.push(st);
    if (st.type === 'PLANNER_RESPONSE' && typeof st.content === 'string' && st.content.trim()) cur.answer = st.content.trim();
  }
  return out;
}

/** 最近一轮的最终回复（最后一段非空 PLANNER_RESPONSE 文本） */
export function lastAnswer(steps) {
  const t = turns(steps);
  return t.length ? t[t.length - 1] : null;
}

const ART_EXT = new Set(['.html', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.svg']);
const WRITE_TOOLS = /^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|create_file)$/;
const PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'path', 'file_path'];

function gitTracked(file) {
  try {
    execFileSync('git', ['-C', path.dirname(file), 'ls-files', '--error-unmatch', path.basename(file)], {stdio: 'ignore', timeout: 3000});
    return true;
  } catch { return false; }
}

/**
 * 本会话产物：write/edit 写过的文件 + 回复里 file:// 链接过且本会话碰过的文件 + brain 产物目录下的文件。
 * 过滤：限定扩展名、存在、非 git 跟踪、非隐藏目录（agy 产物目录除外）、非临时目录。
 */
export function artifacts(steps, {artifactDir = '', home = os.homedir()} = {}) {
  const touched = new Set();
  const linked = new Set();
  for (const st of steps) {
    for (const call of st.tool_calls || []) {
      const args = call?.args || {};
      for (const k of PATH_KEYS) if (typeof args[k] === 'string' && args[k].startsWith('/')) {
        if (WRITE_TOOLS.test(call.name)) touched.add(args[k]);
        else linked.add(args[k]);
      }
    }
    if (st.type === 'PLANNER_RESPONSE' && typeof st.content === 'string') {
      for (const m of st.content.matchAll(/file:\/\/(\/[^)\s#>"']+)/g)) {
        try { linked.add(decodeURIComponent(m[1])); } catch {}
      }
    }
  }
  const cand = new Set(touched);
  // 链接给出的文件：本会话碰过（写过或其它工具引用过）才算
  for (const f of linked) if (touched.has(f) || stepsMention(steps, f)) cand.add(f);
  if (artifactDir) {
    try {
      for (const name of fs.readdirSync(artifactDir)) {
        const f = path.join(artifactDir, name);
        if (fs.statSync(f).isFile()) cand.add(f);
      }
    } catch {}
  }
  const out = [];
  for (const f of cand) {
    if (!ART_EXT.has(path.extname(f).toLowerCase())) continue;
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    const inArtDir = artifactDir && f.startsWith(artifactDir + path.sep) && !f.slice(artifactDir.length + 1).includes(path.sep);
    if (!inArtDir) {
      if (/^\/(tmp|private\/var|var\/folders)\//.test(f)) continue;
      const rel = f.startsWith(home + path.sep) ? f.slice(home.length + 1) : f;
      if (rel.split(path.sep).slice(0, -1).some((seg) => seg.startsWith('.'))) continue;
      if (gitTracked(f)) continue;
    }
    out.push({file: f, name: path.basename(f), bytes: st.size, mtimeMs: st.mtimeMs});
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function stepsMention(steps, f) {
  return steps.some((st) => (st.tool_calls || []).some((c) => JSON.stringify(c.args || {}).includes(f)));
}
