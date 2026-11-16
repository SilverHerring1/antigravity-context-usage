/**
 * Read-only telemetry aggregator for Antigravity conversation transcripts.
 *
 * Scans `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * and optional read-only metadata from `<appData>/conversation_summaries.db`
 * to build:
 *   - Active / selected session context occupancy, per-turn Total/Delta curve,
 *     tool call breakdown, file activity, context events, and compaction history.
 *   - Parent/child subagent family (`fleet`) metrics.
 *   - Cross-session daily API call series, token breakdown / main-vs-subagent bars,
 *     13-week heatmap grid, streak/peak KPIs, and top tool usage bars.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'apply_patch']);
const READ_TOOLS = new Set(['read_file', 'view_file', 'read_resource']);
const SEARCH_TOOLS = new Set([
  'grep_search',
  'find_by_name',
  'search_web',
  'search_marketplace',
  'list_dir',
]);

const fileCache = new Map();
let sqliteModulePromise = null;

async function getSqliteModule() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite').catch(() => null);
  }
  return sqliteModulePromise;
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(filePath) {
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { mtimeMs: 0, size: -1 };
  }
}

function readCached(filePath) {
  const s = statOf(filePath);
  if (s.size < 0) return { text: null, ...s };
  const key = `${s.mtimeMs}:${s.size}`;
  const hit = fileCache.get(filePath);
  if (hit && hit.key === key) return { text: hit.text, ...s };
  try {
    const text = readFileSync(filePath, 'utf-8');
    fileCache.set(filePath, { key, text });
    return { text, ...s };
  } catch {
    return { text: null, ...s };
  }
}

/**
 * Locate Antigravity appData directories containing `brain/`.
 */
export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }

  const explicit = process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (explicit && existsSync(join(explicit, 'brain'))) {
    return [explicit];
  }

  const geminiRoot = join(homedir(), '.gemini');
  return safeReaddir(geminiRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(geminiRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'brain')))
    .sort();
}

/**
 * Convert an ISO timestamp into `YYYY-MM-DD` for the given browser UTC offset
 * (`Date.prototype.getTimezoneOffset()`, e.g. `-480` for UTC+8).
 */
export function toLocalDateKey(iso, tzOffsetMinutes = new Date().getTimezoneOffset()) {
  const utcMs = Date.parse(iso);
  if (!Number.isFinite(utcMs)) return null;
  const shifted = new Date(utcMs - tzOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysToDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function weekdayMonZero(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const sunZero = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (sunZero + 6) % 7;
}

function cleanPromptSnippet(raw) {
  const cleaned = String(raw ?? '')
    .replace(/<\/?[A-Z_]+>/g, ' ')
    .replace(/\[Attachment:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 52 ? `${cleaned.slice(0, 52)}…` : cleaned;
}

function cleanArgString(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\\"/g, '"').trim();
}

function shortenPath(rawPath) {
  const norm = cleanArgString(rawPath);
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || norm;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function normalizeToolName(rawName) {
  const s = String(rawName || '').trim();
  if (!s) return 'unknown';
  return s.startsWith('default_api:') ? s.slice('default_api:'.length) : s;
}

function recordToolActivity(toolCalls, toolMap, fileMap, cmdList, turnInfo) {
  const turnTools = [];
  for (const tc of toolCalls) {
    const name = normalizeToolName(tc?.name);
    const rawArgs = tc?.args && typeof tc.args === 'object' ? tc.args
      : (tc?.arguments && typeof tc.arguments === 'object' ? tc.arguments : {});
    const args = rawArgs;
    turnTools.push(name);
    toolMap.set(name, (toolMap.get(name) || 0) + 1);

    const pathVal = args.Path || args.TargetFile || args.AbsolutePath || args.SearchPath || args.DirectoryPath || args.SearchDirectory || args.path || args.file;
    if (pathVal) {
      const fullPath = cleanArgString(String(pathVal));
      if (fullPath) {
        let entry = fileMap.get(fullPath);
        if (!entry) {
          entry = {
            path: fullPath,
            shortPath: shortenPath(fullPath),
            reads: 0,
            writes: 0,
            searches: 0,
            total: 0,
            lastStep: turnInfo.stepIndex,
          };
          fileMap.set(fullPath, entry);
        }
        if (WRITE_TOOLS.has(name)) entry.writes += 1;
        else if (SEARCH_TOOLS.has(name)) entry.searches += 1;
        else entry.reads += 1;
        entry.total += 1;
        entry.lastStep = turnInfo.stepIndex;
      }
    }

    if (name === 'run_command') {
      const cmdRaw = cleanArgString(String(args.CommandLine || args.command || ''));
      const summaryRaw = cleanArgString(String(args.toolSummary || ''));
      const head = cmdRaw.split(/\s+/)[0] || 'powershell';
      cmdList.push({
        stepIndex: turnInfo.stepIndex,
        createdAt: turnInfo.createdAt,
        program: basename(head) || head,
        summary: summaryRaw || cleanPromptSnippet(cmdRaw) || 'Shell command',
      });
    }
  }
  return turnTools;
}

const COMPOSITION_META = [
  ['tools', '工具调用与结果'],
  ['system', '系统与规则注入'],
  ['thinking', '推理思考 (Thinking)'],
  ['user', '用户消息与附件'],
  ['answer', '助手回复正文'],
];

function buildTurnComposition(totalTokens, charWeights) {
  const total = Math.max(0, Math.round(Number(totalTokens) || 0));
  if (total <= 0) {
    return { system: 0, user: 0, tools: 0, thinking: 0, answer: 0 };
  }
  const sys = Math.max(4800, charWeights.systemChars + 4800);
  const usr = Math.max(0, charWeights.userChars);
  const tls = Math.max(0, charWeights.toolChars);
  const thk = Math.max(0, charWeights.thinkingCharsTotal);
  const ans = Math.max(0, charWeights.answerCharsTotal);
  const sum = sys + usr + tls + thk + ans;
  if (sum <= 0) {
    return { system: total, user: 0, tools: 0, thinking: 0, answer: 0 };
  }
  const system = Math.round((sys / sum) * total);
  const user = Math.round((usr / sum) * total);
  const thinking = Math.round((thk / sum) * total);
  const answer = Math.round((ans / sum) * total);
  const tools = Math.max(0, total - (system + user + thinking + answer));
  return { system, user, tools, thinking, answer };
}

function buildSessionComposition(turns) {
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const prevTurn = turns.length > 1 ? turns[turns.length - 2] : null;
  const curComp = lastTurn?.turnComposition || { system: 0, user: 0, tools: 0, thinking: 0, answer: 0 };
  const prevComp = prevTurn?.turnComposition || { system: 0, user: 0, tools: 0, thinking: 0, answer: 0 };
  const denom = Math.max(
    0,
    curComp.tools + curComp.system + curComp.thinking + curComp.user + curComp.answer,
  );

  return {
    categories: COMPOSITION_META.map(([key, label]) => {
      const tokens = curComp[key] || 0;
      const prevTokens = prevComp[key] || 0;
      return {
        key,
        label,
        tokens,
        share: denom > 0 ? tokens / denom : 0,
        deltaTokens: lastTurn ? tokens - prevTokens : 0,
      };
    }),
    promptTokens: lastTurn?.promptTokens || 0,
    outputTokens: lastTurn?.outputTokens || 0,
    uncachedInputTokens: lastTurn?.inputTokens || 0,
    cacheReadTokens: lastTurn?.cacheReadTokens || 0,
  };
}

/**
 * Parse a single `transcript.jsonl` string into structured turn metrics,
 * deltas, checkpoints, tool/file/command counts, composition, step briefs, and context events.
 */
export function parseTranscript(text) {
  const turns = [];
  const checkpoints = [];
  const events = [];
  const toolMap = new Map();
  const fileMap = new Map();
  const commands = [];
  const userPrompts = [];

  let totalSteps = 0;
  let userInputs = 0;
  let errors = 0;
  let firstPrompt = '';
  let lastUserSnippet = '';
  let genericStepsSinceLastTurn = 0;
  let lastCreatedAt = '';
  let lastTurn = null;
  let pendingCheckpoint = null;

  let systemChars = 0;
  let userChars = 0;
  let toolChars = 0;
  let thinkingCharsTotal = 0;
  let answerCharsTotal = 0;

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    totalSteps += 1;

    const stepIndex = Number(row.step_index) || totalSteps;
    const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
    if (createdAt) lastCreatedAt = createdAt;

    const type = row.type;
    if (type === 'SYSTEM_MESSAGE') {
      systemChars += typeof row.content === 'string' ? row.content.length : 0;
      genericStepsSinceLastTurn += 1;
      continue;
    }

    if (type === 'GENERIC') {
      toolChars += typeof row.content === 'string' ? row.content.length : 0;
      genericStepsSinceLastTurn += 1;
      continue;
    }

    if (type === 'USER_INPUT') {
      userInputs += 1;
      userChars +=
        (typeof row.content === 'string' ? row.content.length : 0) +
        (Array.isArray(row.media) ? row.media.length * 1200 : 0);
      const snippet = row.content ? cleanPromptSnippet(row.content) : '';
      if (!firstPrompt && snippet) firstPrompt = snippet;
      if (snippet) {
        lastUserSnippet = snippet;
        userPrompts.push({ stepIndex, createdAt, snippet });
      }
      events.push({
        kind: 'user',
        stepIndex,
        createdAt,
        title: '用户输入',
        detail: snippet || '发起新一轮对话请求',
        deltaTokens: null,
      });
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      errors += 1;
      events.push({
        kind: 'error',
        stepIndex,
        createdAt,
        title: '模型/工具错误',
        detail: cleanPromptSnippet(row.error || '执行返回异常'),
        deltaTokens: null,
      });
      continue;
    }

    if (type === 'CHECKPOINT') {
      const prePromptTokens = lastTurn ? lastTurn.promptTokens : null;
      const cp = {
        index: checkpoints.length + 1,
        stepIndex,
        createdAt,
        prePromptTokens,
        postPromptTokens: null,
        savedTokens: null,
        turnsBefore: turns.length,
      };
      checkpoints.push(cp);
      pendingCheckpoint = cp;
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const inputTokens = Math.max(0, Number(row.input_tokens) || 0);
      const cacheReadTokens = Math.max(0, Number(row.cache_read_tokens) || 0);
      const outputTokens = Math.max(0, Number(row.output_tokens) || 0);
      const promptTokens = inputTokens + cacheReadTokens;
      const prevPromptTokens = lastTurn ? lastTurn.promptTokens : 0;
      const deltaPromptTokens = lastTurn ? promptTokens - prevPromptTokens : promptTokens;
      const thinkingChars = typeof row.thinking === 'string' ? row.thinking.length : 0;
      const answerChars = typeof row.content === 'string' ? row.content.length : 0;

      const rawTools = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      if (rawTools.length) {
        try {
          toolChars += JSON.stringify(rawTools).length;
        } catch {
          toolChars += rawTools.length * 160;
        }
      }
      thinkingCharsTotal += thinkingChars;
      answerCharsTotal += answerChars;

      const toolNames = recordToolActivity(rawTools, toolMap, fileMap, commands, {
        stepIndex,
        createdAt,
      });

      const compactedBefore = Boolean(pendingCheckpoint);
      if (pendingCheckpoint) {
        pendingCheckpoint.postPromptTokens = promptTokens;
        if (pendingCheckpoint.prePromptTokens !== null) {
          pendingCheckpoint.savedTokens = Math.max(0, pendingCheckpoint.prePromptTokens - promptTokens);
        }
        events.push({
          kind: 'compact',
          stepIndex: pendingCheckpoint.stepIndex,
          createdAt: pendingCheckpoint.createdAt || createdAt,
          title: `自动压缩 CP #${pendingCheckpoint.index}`,
          detail:
            pendingCheckpoint.savedTokens !== null
              ? `回收 ${pendingCheckpoint.savedTokens.toLocaleString('en-US')} tokens`
              : '上下文摘要压缩完成',
          preTokens: pendingCheckpoint.prePromptTokens,
          postTokens: promptTokens,
          deltaTokens: pendingCheckpoint.prePromptTokens !== null ? promptTokens - pendingCheckpoint.prePromptTokens : null,
        });
        pendingCheckpoint = null;
      } else if (lastTurn && deltaPromptTokens >= 15_000) {
        const uniq = [...new Set(toolNames)].slice(0, 3);
        events.push({
          kind: 'spike',
          stepIndex,
          createdAt,
          title: `第 ${turns.length + 1} 轮体积跃升`,
          detail: uniq.length ? `触发工具: ${uniq.join(', ')}` : '大段上下文注入',
          deltaTokens: deltaPromptTokens,
        });
      }

      const signedDeltaStr = `${deltaPromptTokens >= 0 ? '+' : ''}${deltaPromptTokens.toLocaleString('en-US')} tok`;
      const inSummary = compactedBefore
        ? '✂ 自动压缩回收上下文'
        : genericStepsSinceLastTurn > 0
          ? `工具结果与注入 ×${genericStepsSinceLastTurn} (${signedDeltaStr})`
          : `用户输入与上下文 (${signedDeltaStr})`;
      genericStepsSinceLastTurn = 0;

      const uniqTools = [...new Set(toolNames)].slice(0, 4);
      const responseParts = [
        thinkingChars > 0 ? `思考 ${thinkingChars.toLocaleString('en-US')} 字` : '',
        uniqTools.length ? `调用 ${uniqTools.join(', ')}` : '',
        row.content ? cleanPromptSnippet(row.content) : '',
      ].filter(Boolean);

      const totalTokens = promptTokens + outputTokens;
      const turnComposition = buildTurnComposition(totalTokens, {
        systemChars,
        userChars,
        toolChars,
        thinkingCharsTotal,
        answerCharsTotal,
      });

      const turn = {
        seq: turns.length + 1,
        stepIndex,
        createdAt,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        promptTokens,
        totalTokens,
        deltaPromptTokens,
        thinkingChars,
        toolNames,
        compactedBefore,
        stepBrief: {
          user: lastUserSnippet || '延续上一轮任务',
          inSummary,
          response: responseParts.join(' · ') || '完成本轮响应',
        },
        turnComposition,
      };
      turns.push(turn);
      lastTurn = turn;
    }
  }

  // Record a trailing checkpoint even if no subsequent PLANNER_RESPONSE arrived yet.
  if (pendingCheckpoint) {
    events.push({
      kind: 'compact',
      stepIndex: pendingCheckpoint.stepIndex,
      createdAt: pendingCheckpoint.createdAt,
      title: `自动压缩 CP #${pendingCheckpoint.index}`,
      detail: '已触发检查点，等待下一轮响应落盘',
      preTokens: pendingCheckpoint.prePromptTokens,
      postTokens: null,
      deltaTokens: null,
    });
  }

  const sumUncachedInput = turns.reduce((acc, t) => acc + t.inputTokens, 0);
  const sumCacheRead = turns.reduce((acc, t) => acc + t.cacheReadTokens, 0);
  const sumOutput = turns.reduce((acc, t) => acc + t.outputTokens, 0);
  const sumPrompt = sumUncachedInput + sumCacheRead;
  const sumTotal = sumPrompt + sumOutput;

  let lastCheckpointIdx = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].compactedBefore) {
      lastCheckpointIdx = i;
      break;
    }
  }

  const toolBreakdown = [...toolMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const totalToolCalls = toolBreakdown.reduce((acc, item) => acc + item.count, 0);

  const fileActivity = [...fileMap.values()].sort(
    (a, b) => b.total - a.total || b.writes - a.writes || a.shortPath.localeCompare(b.shortPath),
  );

  return {
    totalSteps,
    userInputs,
    userPrompts,
    errors,
    firstPrompt,
    lastCreatedAt,
    turns,
    checkpoints,
    events,
    toolBreakdown,
    totalToolCalls,
    fileActivity,
    commands,
    turnsSinceCompaction: lastCheckpointIdx >= 0 ? turns.length - lastCheckpointIdx : turns.length,
    totals: {
      apiCalls: turns.length,
      uncachedInputTokens: sumUncachedInput,
      cacheReadTokens: sumCacheRead,
      outputTokens: sumOutput,
      promptTokens: sumPrompt,
      totalTokens: sumTotal,
      cacheHitRatio: sumPrompt > 0 ? sumCacheRead / sumPrompt : 0,
      checkpointCount: checkpoints.length,
      toolCalls: totalToolCalls,
    },
    latestTurn: lastTurn,
    composition: buildSessionComposition(turns),
  };
}

/**
 * Safely read conversation titles & subagent roles from `conversation_summaries.db`.
 */
async function loadConversationMeta(appDataDirs) {
  const metaMap = new Map();
  const sqlite = await getSqliteModule();
  if (!sqlite?.DatabaseSync) return metaMap;

  for (const appData of appDataDirs) {
    const dbPath = join(appData, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          'SELECT conversation_id, title, agent_name, parent_conversation_id, last_modified_time FROM conversation_summaries',
        )
        .all();
      for (const r of rows) {
        if (!r?.conversation_id) continue;
        metaMap.set(r.conversation_id, {
          title: r.title || '',
          agentName: r.agent_name || '',
          parentId: r.parent_conversation_id || '',
          lastModifiedTime: r.last_modified_time || '',
        });
      }

      const ftsRows = db
        .prepare('SELECT DISTINCT conversation_id, title FROM conversations_fts WHERE length(title) != 0')
        .all();
      for (const r of ftsRows) {
        if (!r?.conversation_id) continue;
        const cur = metaMap.get(r.conversation_id) || {};
        if (!cur.title && r.title) {
          metaMap.set(r.conversation_id, { ...cur, title: r.title });
        }
      }

      const parentRows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
      for (const r of parentRows) {
        if (!r?.conversation_id) continue;
        const cur = metaMap.get(r.conversation_id) || {};
        if (!cur.parentId && r.parent_id) {
          metaMap.set(r.conversation_id, { ...cur, parentId: r.parent_id });
        }
      }
    } catch {
      // Ignore read errors gracefully.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  return metaMap;
}

function summarizePeaks(values) {
  if (!values.length) return { count: 0, avg: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function ensureDailyBucket(dailyMap, dateKey) {
  let bucket = dailyMap.get(dateKey);
  if (!bucket) {
    bucket = {
      date: dateKey,
      apiCalls: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      mainTokens: 0,
      subTokens: 0,
      checkpoints: 0,
      toolCalls: 0,
      userInputs: 0,
      sessionIds: new Set(),
    };
    dailyMap.set(dateKey, bucket);
  }
  return bucket;
}

function buildDailyBuckets(sessions, includeSubagents, tzOffsetMinutes) {
  const dailyMap = new Map();
  let latestDateKey = null;

  for (const s of sessions) {
    if (!includeSubagents && s.isSubagent) continue;

    for (const t of s.parsed.turns) {
      const dateKey = toLocalDateKey(t.createdAt, tzOffsetMinutes);
      if (!dateKey) continue;
      if (!latestDateKey || dateKey > latestDateKey) latestDateKey = dateKey;
      const bucket = ensureDailyBucket(dailyMap, dateKey);
      bucket.apiCalls += 1;
      bucket.uncachedInputTokens += t.inputTokens;
      bucket.cacheReadTokens += t.cacheReadTokens;
      bucket.outputTokens += t.outputTokens;
      bucket.totalTokens += t.totalTokens;
      if (s.isSubagent) bucket.subTokens += t.totalTokens;
      else bucket.mainTokens += t.totalTokens;
      bucket.toolCalls += t.toolNames.length;
      bucket.sessionIds.add(s.id);
    }

    for (const u of s.parsed.userPrompts) {
      const dateKey = toLocalDateKey(u.createdAt, tzOffsetMinutes);
      if (!dateKey) continue;
      const bucket = ensureDailyBucket(dailyMap, dateKey);
      bucket.userInputs += 1;
      bucket.sessionIds.add(s.id);
    }

    for (const cp of s.parsed.checkpoints) {
      const dateKey = toLocalDateKey(cp.createdAt, tzOffsetMinutes);
      if (!dateKey) continue;
      const bucket = ensureDailyBucket(dailyMap, dateKey);
      bucket.checkpoints += 1;
      bucket.sessionIds.add(s.id);
    }
  }

  return { dailyMap, latestDateKey };
}

function formatDayRow(dateKey, raw) {
  const prompt = (raw?.uncachedInputTokens || 0) + (raw?.cacheReadTokens || 0);
  return {
    date: dateKey,
    label: dateKey.slice(5).replace('-', '/'),
    apiCalls: raw?.apiCalls || 0,
    uncachedInputTokens: raw?.uncachedInputTokens || 0,
    cacheReadTokens: raw?.cacheReadTokens || 0,
    outputTokens: raw?.outputTokens || 0,
    totalTokens: raw?.totalTokens || 0,
    mainTokens: raw?.mainTokens || 0,
    subTokens: raw?.subTokens || 0,
    checkpoints: raw?.checkpoints || 0,
    toolCalls: raw?.toolCalls || 0,
    userInputs: raw?.userInputs || 0,
    activeSessions: raw?.sessionIds?.size || 0,
    cacheHitRatio: prompt > 0 ? (raw?.cacheReadTokens || 0) / prompt : 0,
  };
}

function computeActivityMeta(dailyMap, todayKey) {
  let activeDays = 0;
  let peakDay = null;
  for (const [dateKey, raw] of dailyMap.entries()) {
    if (raw.totalTokens > 0 || raw.apiCalls > 0) {
      activeDays += 1;
      if (!peakDay || raw.totalTokens > peakDay.totalTokens) {
        peakDay = {
          date: dateKey,
          label: dateKey.slice(5).replace('-', '/'),
          totalTokens: raw.totalTokens,
          apiCalls: raw.apiCalls,
        };
      }
    }
  }

  let streakDays = 0;
  const hasToday = (dailyMap.get(todayKey)?.apiCalls || 0) > 0;
  let cursor = hasToday ? todayKey : addDaysToDateKey(todayKey, -1);
  while (streakDays < 365) {
    const raw = dailyMap.get(cursor);
    if (!raw || raw.apiCalls <= 0) break;
    streakDays += 1;
    cursor = addDaysToDateKey(cursor, -1);
  }

  return { activeDays, streakDays, peakDay };
}

function buildDailySeries(dailyMap, rangeDays, tzOffsetMinutes) {
  const todayKey = toLocalDateKey(new Date().toISOString(), tzOffsetMinutes);
  const allKeys = [...dailyMap.keys()].sort();

  let dates = [];
  if (rangeDays === 'all') {
    if (!allKeys.length) {
      dates = [todayKey];
    } else {
      let cur = allKeys[0];
      const end = todayKey > allKeys[allKeys.length - 1] ? todayKey : allKeys[allKeys.length - 1];
      while (cur <= end && dates.length < 365) {
        dates.push(cur);
        cur = addDaysToDateKey(cur, 1);
      }
    }
  } else {
    const n = Math.max(1, Math.min(180, Number(rangeDays) || 30));
    for (let i = n - 1; i >= 0; i -= 1) {
      dates.push(addDaysToDateKey(todayKey, -i));
    }
  }

  const days = dates.map((k) => formatDayRow(k, dailyMap.get(k)));
  const totals = days.reduce(
    (acc, d) => {
      acc.apiCalls += d.apiCalls;
      acc.uncachedInputTokens += d.uncachedInputTokens;
      acc.cacheReadTokens += d.cacheReadTokens;
      acc.outputTokens += d.outputTokens;
      acc.totalTokens += d.totalTokens;
      acc.mainTokens += d.mainTokens;
      acc.subTokens += d.subTokens;
      acc.checkpoints += d.checkpoints;
      acc.toolCalls += d.toolCalls;
      acc.userInputs += d.userInputs;
      if (d.apiCalls > 0) acc.rangeActiveDays += 1;
      if (!acc.peakDay || d.totalTokens > acc.peakDay.totalTokens) {
        acc.peakDay = { date: d.date, label: d.label, totalTokens: d.totalTokens, apiCalls: d.apiCalls };
      }
      return acc;
    },
    {
      apiCalls: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      mainTokens: 0,
      subTokens: 0,
      checkpoints: 0,
      toolCalls: 0,
      userInputs: 0,
      rangeActiveDays: 0,
      peakDay: null,
    },
  );
  const promptTotal = totals.uncachedInputTokens + totals.cacheReadTokens;
  totals.cacheHitRatio = promptTotal > 0 ? totals.cacheReadTokens / promptTotal : 0;

  const activityMeta = computeActivityMeta(dailyMap, todayKey);
  return { todayKey, days, totals: { ...totals, ...activityMeta } };
}

function buildHeatmapGrid(dailyMap, todayKey, weeks = 13) {
  const todayDow = weekdayMonZero(todayKey);
  const totalSlots = (weeks - 1) * 7 + (todayDow + 1);
  const startKey = addDaysToDateKey(todayKey, -(totalSlots - 1));

  const cells = [];
  let maxTokens = 0;
  let maxCalls = 0;

  for (let i = 0; i < weeks * 7; i += 1) {
    const dateKey = addDaysToDateKey(startKey, i);
    const future = dateKey > todayKey;
    const row = formatDayRow(dateKey, future ? null : dailyMap.get(dateKey));
    if (!future) {
      if (row.totalTokens > maxTokens) maxTokens = row.totalTokens;
      if (row.apiCalls > maxCalls) maxCalls = row.apiCalls;
    }
    cells.push({
      ...row,
      weekIndex: Math.floor(i / 7),
      dayOfWeek: i % 7,
      isToday: dateKey === todayKey,
      isFuture: future,
    });
  }

  return { weeks, maxTokens, maxCalls, cells };
}

function aggregateGlobalToolsAndFiles(sessions, includeSubagents) {
  const toolCounts = new Map();
  const fileTotals = new Map();
  let mainTokens = 0;
  let subTokens = 0;

  for (const s of sessions) {
    if (!includeSubagents && s.isSubagent) continue;
    if (s.isSubagent) subTokens += s.parsed.totals.totalTokens;
    else mainTokens += s.parsed.totals.totalTokens;

    for (const tb of s.parsed.toolBreakdown) {
      toolCounts.set(tb.name, (toolCounts.get(tb.name) || 0) + tb.count);
    }
    for (const f of s.parsed.fileActivity) {
      const cur = fileTotals.get(f.path) || {
        path: f.path,
        shortPath: f.shortPath,
        reads: 0,
        writes: 0,
        searches: 0,
        total: 0,
      };
      cur.reads += f.reads;
      cur.writes += f.writes;
      cur.searches += f.searches;
      cur.total += f.total;
      fileTotals.set(f.path, cur);
    }
  }

  const tools = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const totalTools = tools.reduce((acc, t) => acc + t.count, 0);

  const files = [...fileTotals.values()]
    .sort((a, b) => b.total - a.total || b.writes - a.writes || a.shortPath.localeCompare(b.shortPath));

  return {
    tools: tools.map((t) => ({ ...t, share: totalTools > 0 ? t.count / totalTools : 0 })),
    totalToolCalls: totalTools,
    files,
    roleSplit: {
      mainTokens,
      subTokens,
      totalTokens: mainTokens + subTokens,
    },
  };
}

function summarizeSessionCompact(s) {
  return {
    id: s.id,
    shortId: s.shortId,
    title: s.title,
    agentName: s.agentName,
    parentId: s.parentId,
    isSubagent: s.isSubagent,
    isCurrentHostSession: s.isCurrentHostSession,
    lastUpdatedAt: s.lastUpdatedAt,
    totalSteps: s.parsed.totalSteps,
    apiCalls: s.parsed.totals.apiCalls,
    latestPromptTokens: s.parsed.latestTurn?.promptTokens || 0,
    latestOutputTokens: s.parsed.latestTurn?.outputTokens || 0,
    totalTokens: s.parsed.totals.totalTokens,
    cacheHitRatio: s.parsed.totals.cacheHitRatio,
    checkpointCount: s.parsed.totals.checkpointCount,
    toolCalls: s.parsed.totals.toolCalls,
    turnsSinceCompaction: s.parsed.turnsSinceCompaction,
  };
}

function buildFleetForSession(selected, sessions) {
  if (!selected) return { rootId: null, members: [], totalTokens: 0, totalApiCalls: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Walk up parent chain safely to find family root.
  let root = selected;
  const visited = new Set([root.id]);
  while (root.parentId && byId.has(root.parentId) && !visited.has(root.parentId)) {
    root = byId.get(root.parentId);
    visited.add(root.id);
  }

  // BFS all descendants under root.
  const childrenMap = new Map();
  for (const s of sessions) {
    if (!s.parentId) continue;
    const arr = childrenMap.get(s.parentId) || [];
    arr.push(s);
    childrenMap.set(s.parentId, arr);
  }

  const members = [];
  const queue = [{ node: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    members.push({ ...summarizeSessionCompact(node), depth });
    const kids = (childrenMap.get(node.id) || []).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const k of kids) queue.push({ node: k, depth: depth + 1 });
  }

  return {
    rootId: root.id,
    members,
    totalTokens: members.reduce((acc, m) => acc + m.totalTokens, 0),
    totalApiCalls: members.reduce((acc, m) => acc + m.apiCalls, 0),
  };
}

/**
 * Scan local transcripts and build a full telemetry snapshot.
 */
export async function collectSnapshot({
  appDataDirs = findAppDataDirs(),
  activeConversationId = '',
  targetConversationId = '',
  rangeDays = '30',
  scope = 'all',
  tzOffsetMinutes = new Date().getTimezoneOffset(),
  knownEtag = '',
} = {}) {
  const files = [];
  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const entry of safeReaddir(brainDir)) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const logPath = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      const s = statOf(logPath);
      if (s.size < 0) continue;
      files.push({ id: entry.name, appData, logPath, mtimeMs: s.mtimeMs, size: s.size });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const cleanActive = ID_RE.test(activeConversationId) ? activeConversationId : '';
  const cleanTarget = ID_RE.test(targetConversationId) ? targetConversationId : '';
  const signature = files.map((f) => `${f.id}:${Math.round(f.mtimeMs)}:${f.size}`).join('|');
  const etag = `v3.1|${cleanActive}|${cleanTarget}|${rangeDays}|${scope}|${tzOffsetMinutes}|${signature}`;

  if (knownEtag && knownEtag === etag) {
    return { unchanged: true, etag };
  }

  const metaMap = await loadConversationMeta(appDataDirs);

  const sessions = files.map((f) => {
    const { text } = readCached(f.logPath);
    const parsed = parseTranscript(text || '');
    const meta = metaMap.get(f.id) || {};
    const agentName = meta.agentName || '';
    const isSubagent = Boolean(agentName);
    const title = meta.title || (isSubagent ? `${agentName} 子智能体` : parsed.firstPrompt) || f.id.slice(0, 8);

    return {
      id: f.id,
      shortId: f.id.slice(0, 8),
      title,
      agentName,
      parentId: meta.parentId || '',
      isSubagent,
      isCurrentHostSession: Boolean(cleanActive && f.id === cleanActive),
      mtimeMs: f.mtimeMs,
      lastUpdatedAt: parsed.lastCreatedAt || meta.lastModifiedTime || new Date(f.mtimeMs).toISOString(),
      parsed,
    };
  });

  const mainPeaks = [];
  const subPeaks = [];
  for (const s of sessions) {
    for (const cp of s.parsed.checkpoints) {
      if (typeof cp.prePromptTokens === 'number' && cp.prePromptTokens > 0) {
        (s.isSubagent ? subPeaks : mainPeaks).push(cp.prePromptTokens);
      }
    }
  }

  const selected =
    sessions.find((s) => cleanTarget && s.id === cleanTarget) ||
    sessions.find((s) => cleanActive && s.id === cleanActive) ||
    sessions.find((s) => !s.isSubagent) ||
    sessions[0] ||
    null;

  const includeSubagents = scope !== 'main';
  const { dailyMap } = buildDailyBuckets(sessions, includeSubagents, tzOffsetMinutes);
  const { todayKey, days, totals } = buildDailySeries(dailyMap, rangeDays, tzOffsetMinutes);
  const heatmap = buildHeatmapGrid(dailyMap, todayKey, 24);
  const globalBreakdown = aggregateGlobalToolsAndFiles(sessions, includeSubagents);
  const fleet = buildFleetForSession(selected, sessions);

  const mainSummary = summarizePeaks(mainPeaks);
  const subSummary = summarizePeaks(subPeaks);
  const recommendedCompactionRef = mainSummary.avg || 256_000;

  return {
    unchanged: false,
    etag,
    generatedAt: new Date().toISOString(),
    appDataDirs,
    activeConversationId: cleanActive || null,
    selectedConversationId: selected ? selected.id : null,
    calibration: {
      mainObservedCompaction: mainSummary,
      subagentObservedCompaction: subSummary,
      recommendedRefTokens: recommendedCompactionRef,
      fallbackRefTokens: 256_000,
    },
    selectedSession: selected
      ? {
          id: selected.id,
          shortId: selected.shortId,
          title: selected.title,
          agentName: selected.agentName,
          parentId: selected.parentId,
          isSubagent: selected.isSubagent,
          isCurrentHostSession: selected.isCurrentHostSession,
          lastUpdatedAt: selected.lastUpdatedAt,
          totalSteps: selected.parsed.totalSteps,
          userInputs: selected.parsed.userInputs,
          errors: selected.parsed.errors,
          turnsSinceCompaction: selected.parsed.turnsSinceCompaction,
          totals: selected.parsed.totals,
          latestTurn: selected.parsed.latestTurn,
          composition: selected.parsed.composition,
          turns: selected.parsed.turns.slice(-90),
          checkpoints: selected.parsed.checkpoints,
          events: selected.parsed.events.slice(-60).reverse(),
          toolBreakdown: selected.parsed.toolBreakdown.slice(0, 16),
          totalToolCalls: selected.parsed.totalToolCalls,
          fileActivity: selected.parsed.fileActivity.slice(0, 30),
          commands: selected.parsed.commands.slice(-24).reverse(),
        }
      : null,
    fleet,
    usage: {
      rangeDays,
      scope,
      todayKey,
      totals,
      days,
      heatmap,
      topTools: globalBreakdown.tools.slice(0, 12),
      totalToolCalls: globalBreakdown.totalToolCalls,
      topFiles: globalBreakdown.files.slice(0, 20),
      roleSplit: globalBreakdown.roleSplit,
    },
    sessions: sessions.map(summarizeSessionCompact),
  };
}
