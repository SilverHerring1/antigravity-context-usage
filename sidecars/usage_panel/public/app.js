/**
 * Context & Usage dashboard frontend.
 * Grid-free stacked composition, interactive turn Step Briefs, and cross-session telemetry.
 */

const POLL_MS = 2500;
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const TAB_LABELS = {
  home: '主页',
  context: '上下文',
  usage: '趋势',
  tools: '编队与工具',
};

const COMP_COLORS = {
  tools: { color: 'var(--blue)', label: '工具调用与结果' },
  system: { color: 'var(--purple)', label: '系统与规则注入' },
  thinking: { color: 'var(--yellow)', label: '推理思考 (Thinking)' },
  user: { color: 'var(--bar-teal)', label: '用户消息与附件' },
  answer: { color: 'var(--orange)', label: '助手回复正文' },
};

const TOOL_TONES = [
  'var(--bar-teal)',
  'var(--orange)',
  'var(--blue)',
  'var(--purple)',
  'var(--yellow)',
];

const state = {
  tab: 'home',
  heroMode: 'window',       // 'window' | 'total'
  refMode: 'observed',      // 'observed' | '200k' | '1m'
  turnMode: 'total',        // 'total' | 'delta'
  pinnedTurnSeq: null,
  eventFilter: 'all',       // 'all' | 'compact' | 'spike' | 'user' | 'error'
  fileFilter: 'all',        // 'all' | 'read' | 'write' | 'search'
  rangeDays: '30',          // '1' | '7' | '14' | '30' | '90' | 'all'
  usageScope: 'all',        // 'all' | 'main'
  tokSplit: 'composition',  // 'composition' | 'role'
  tokStyle: 'bar',          // 'bar' | 'line'
  selectedTargetId: '',
  selectedHeatDate: '',
  displayedHeroValue: null,
  heroRafId: 0,
  homeMetersReady: false,
  animatePending: true,
  fadeOnRender: false,
  bootUiVersion: '',
  etag: '',
  snap: null,
  fetching: false,
  queuedForce: false,
};

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const params = new URLSearchParams(location.search);
const tzOffsetMinutes = new Date().getTimezoneOffset();

function hostConversationId() {
  return window.sidecar?.conversationId || params.get('conversationId') || '';
}

async function fetchSnapshot(force = false) {
  const qs = new URLSearchParams({
    conversationId: hostConversationId(),
    target: state.selectedTargetId,
    range: state.rangeDays,
    scope: state.usageScope,
    tzOffset: String(tzOffsetMinutes),
  });
  if (!force && state.etag) {
    qs.set('etag', state.etag);
  }
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await f(`/api/snapshot?${qs.toString()}`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Theme Synchronization ----------
const THEME_STORAGE_KEY = 'context_usage_theme';
let themeOverriddenByUser = false;

function getCurrentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function syncThemeButton(mode) {
  const btn = $('themeToggleBtn');
  if (!btn) return;
  const isDark = mode === 'dark';
  const nextLabel = isDark ? '切换到浅色模式' : '切换到深色模式';
  btn.setAttribute('aria-label', nextLabel);
  btn.setAttribute('title', nextLabel);
  btn.setAttribute('aria-pressed', String(!isDark));

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (isDark) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '4');
    svg.appendChild(circle);
    for (const [x1, y1, x2, y2] of [
      [12, 2, 12, 4.5],
      [12, 19.5, 12, 22],
      [4.93, 4.93, 6.7, 6.7],
      [17.3, 17.3, 19.07, 19.07],
      [2, 12, 4.5, 12],
      [19.5, 12, 22, 12],
      [4.93, 19.07, 6.7, 17.3],
      [17.3, 6.7, 19.07, 4.93],
    ]) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      svg.appendChild(line);
    }
  } else {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
    svg.appendChild(path);
  }
  btn.replaceChildren(svg);
}

function applyTheme(mode) {
  const resolved = mode === 'light' ? 'light' : 'dark';
  if (document.documentElement.dataset.theme !== resolved) {
    document.documentElement.dataset.theme = resolved;
  }
  if (document.documentElement.style.colorScheme !== resolved) {
    document.documentElement.style.colorScheme = resolved;
  }
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta && schemeMeta.content !== resolved) {
    schemeMeta.content = resolved;
  }
  syncThemeButton(resolved);
}

function toggleTheme() {
  themeOverriddenByUser = true;
  const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Ignore storage unavailability
  }
  const root = document.documentElement;
  root.classList.add('is-theme-switching');
  applyTheme(next);
  void root.offsetHeight;
  root.classList.remove('is-theme-switching');
  requestAnimationFrame(updateAllGliders);
}

function syncScheme() {
  const explicitTheme = params.get('theme');
  if (!themeOverriddenByUser && (explicitTheme === 'dark' || explicitTheme === 'light')) {
    applyTheme(explicitTheme);
    return;
  }

  let savedTheme = '';
  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || '';
  } catch {
    savedTheme = '';
  }
  if (savedTheme === 'dark' || savedTheme === 'light') {
    applyTheme(savedTheme);
    return;
  }
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #14171c)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();

  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length >= 3) {
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const detected = lum < 0.5 ? 'dark' : 'light';
    if (!document.documentElement.style.getPropertyValue('--background') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
      return;
    }
    applyTheme(detected);
    return;
  }
  applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

syncScheme();
new MutationObserver(() => syncScheme()).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style'],
});

// ---------- Safe DOM & Format Helpers ----------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, String(v));
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.appendChild(child);
  }
  return node;
}

function fmtCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toLocaleString('en-US');
}

function fmtExact(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtPct(ratio) {
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  return `${pct >= 99.95 ? '100' : pct.toFixed(1)}%`;
}

function fmtRelTime(iso) {
  if (!iso) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(diffSec)) return '—';
  if (diffSec < 60) return `${diffSec}秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

function fmtShortClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function buildSmoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

const MORPH_SAMPLES = 72;
const MORPH_DURATION_MS = 420;

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function evalSmoothCurveAt(pts, tNorm) {
  if (!pts.length) return { x: 0, y: 0 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  const u = Math.max(0, Math.min(1, tNorm)) * (pts.length - 1);
  const seg = Math.min(pts.length - 2, Math.floor(u));
  const t = u - seg;
  const p0 = pts[Math.max(0, seg - 1)];
  const p1 = pts[seg];
  const p2 = pts[seg + 1];
  const p3 = pts[Math.min(pts.length - 1, seg + 2)];
  const cp1x = p1.x + (p2.x - p0.x) / 6;
  const cp1y = p1.y + (p2.y - p0.y) / 6;
  const cp2x = p2.x - (p3.x - p1.x) / 6;
  const cp2y = p2.y - (p3.y - p1.y) / 6;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p1.x + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t2 * t * p2.x,
    y: mt2 * mt * p1.y + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t2 * t * p2.y,
  };
}

function sampleCurvePoints(pts, baselineY, xMin, xMax, count = MORPH_SAMPLES) {
  const out = new Array(count);
  if (pts.length === 1) {
    const y = Math.min(baselineY, pts[0].y);
    for (let i = 0; i < count; i += 1) {
      const x = xMin + (count === 1 ? 0.5 : i / (count - 1)) * (xMax - xMin);
      out[i] = { x, y };
    }
    return out;
  }
  for (let i = 0; i < count; i += 1) {
    const p = evalSmoothCurveAt(pts, count === 1 ? 0 : i / (count - 1));
    out[i] = { x: p.x, y: Math.min(baselineY, p.y) };
  }
  return out;
}

function buildPolylinePath(pts) {
  if (!pts.length) return '';
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i += 1) {
    d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  return d;
}

function buildClosedArea(lineD, pts, baselineY) {
  if (!lineD || !pts.length) return '';
  return `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${baselineY.toFixed(1)} L ${pts[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`;
}

function flatBaselineSamples(xMin, xMax, baselineY, count = MORPH_SAMPLES) {
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = { x: xMin + (count === 1 ? 0.5 : i / (count - 1)) * (xMax - xMin), y: baselineY };
  }
  return out;
}

function renderMorphLineSvg(box, cfg) {
  const { chartId, w, h, xMin, xMax, baselineY, ariaLabel, buildDefs, buildGridNodes, series, animate } = cfg;
  let meta = box._morphState;
  const canReuse = Boolean(
    meta &&
      meta.kind === 'line' &&
      meta.chartId === chartId &&
      meta.svg?.isConnected &&
      meta.seriesKeys.length === series.length &&
      series.every((s, idx) => meta.seriesKeys[idx] === s.key),
  );

  if (meta?.rafId) {
    cancelAnimationFrame(meta.rafId);
    meta.rafId = 0;
  }

  let svg;
  let gridG;
  let seriesG;
  const prevSamplesMap = {};

  if (canReuse) {
    svg = meta.svg;
    gridG = meta.gridG;
    seriesG = meta.seriesG;
    if (ariaLabel) svg.setAttribute('aria-label', ariaLabel);
    for (const s of series) {
      prevSamplesMap[s.key] = meta.currentSamples[s.key] || flatBaselineSamples(xMin, xMax, baselineY);
    }
  } else {
    svg = svgEl('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${w} ${h}`,
      role: ariaLabel ? 'img' : null,
      'aria-label': ariaLabel || null,
    });
    if (buildDefs) svg.appendChild(buildDefs());
    gridG = svgEl('g', { 'data-layer': 'grid' });
    seriesG = svgEl('g', { 'data-layer': 'series' });
    svg.appendChild(gridG);
    svg.appendChild(seriesG);

    for (const s of series) {
      if (s.fill) {
        seriesG.appendChild(svgEl('path', { fill: s.fill, 'data-morph-area': s.key }));
      }
      seriesG.appendChild(
        svgEl('path', {
          fill: 'none',
          stroke: s.stroke,
          'stroke-width': String(s.strokeWidth ?? 2),
          'stroke-linecap': 'round',
          'data-morph-line': s.key,
        }),
      );
      prevSamplesMap[s.key] = flatBaselineSamples(xMin, xMax, baselineY);
    }
    box.replaceChildren(svg);
  }

  gridG.replaceChildren(...buildGridNodes());

  const targetSamplesMap = {};
  const exactPathsMap = {};
  for (const s of series) {
    const normalizedRaw =
      s.pts.length === 1
        ? [
            { x: xMin, y: s.pts[0].y },
            { x: xMax, y: s.pts[0].y },
          ]
        : s.pts;
    targetSamplesMap[s.key] = sampleCurvePoints(normalizedRaw, baselineY, xMin, xMax);
    const lineD = buildSmoothPath(normalizedRaw);
    exactPathsMap[s.key] = {
      lineD,
      areaD: s.fill ? buildClosedArea(lineD, normalizedRaw, baselineY) : '',
    };
  }

  const nextMeta = {
    kind: 'line',
    chartId,
    svg,
    gridG,
    seriesG,
    seriesKeys: series.map((s) => s.key),
    currentSamples: {},
    rafId: 0,
  };
  box._morphState = nextMeta;

  const commitFinal = () => {
    for (const s of series) {
      const lineEl = seriesG.querySelector(`[data-morph-line="${s.key}"]`);
      const areaEl = s.fill ? seriesG.querySelector(`[data-morph-area="${s.key}"]`) : null;
      if (lineEl) lineEl.setAttribute('d', exactPathsMap[s.key].lineD);
      if (areaEl) areaEl.setAttribute('d', exactPathsMap[s.key].areaD);
      nextMeta.currentSamples[s.key] = targetSamplesMap[s.key];
    }
  };

  if (!animate || prefersReducedMotion()) {
    commitFinal();
    return;
  }

  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / MORPH_DURATION_MS));
    const k = easeOutCubic(t);
    for (const s of series) {
      const fromPts = prevSamplesMap[s.key];
      const toPts = targetSamplesMap[s.key];
      const cur = new Array(toPts.length);
      for (let i = 0; i < toPts.length; i += 1) {
        const f = fromPts[i] || toPts[i];
        cur[i] = {
          x: f.x + (toPts[i].x - f.x) * k,
          y: Math.min(baselineY, f.y + (toPts[i].y - f.y) * k),
        };
      }
      nextMeta.currentSamples[s.key] = cur;
      const lineD = buildPolylinePath(cur);
      const lineEl = seriesG.querySelector(`[data-morph-line="${s.key}"]`);
      const areaEl = s.fill ? seriesG.querySelector(`[data-morph-area="${s.key}"]`) : null;
      if (lineEl) lineEl.setAttribute('d', lineD);
      if (areaEl) areaEl.setAttribute('d', buildClosedArea(lineD, cur, baselineY));
    }

    if (t < 1) {
      nextMeta.rafId = requestAnimationFrame(step);
    } else {
      nextMeta.rafId = 0;
      commitFinal();
    }
  };
  nextMeta.rafId = requestAnimationFrame(step);
}

function renderMorphBarsSvg(box, cfg) {
  const { chartId, w, h, baselineY, ariaLabel, buildGridNodes, buildOverlayNodes, items, animate } = cfg;
  let meta = box._morphState;
  const canReuse = Boolean(
    meta && meta.kind === 'bars' && meta.chartId === chartId && meta.svg?.isConnected,
  );

  if (meta?.rafId) {
    cancelAnimationFrame(meta.rafId);
    meta.rafId = 0;
  }

  let svg;
  let gridG;
  let seriesG;
  let overlayG;
  const prevRects = canReuse ? new Map(meta.currentRects) : new Map();

  if (canReuse) {
    svg = meta.svg;
    gridG = meta.gridG;
    seriesG = meta.seriesG;
    overlayG = meta.overlayG;
    if (ariaLabel) svg.setAttribute('aria-label', ariaLabel);
  } else {
    svg = svgEl('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${w} ${h}`,
      role: ariaLabel ? 'img' : null,
      'aria-label': ariaLabel || null,
    });
    gridG = svgEl('g', { 'data-layer': 'grid' });
    seriesG = svgEl('g', { 'data-layer': 'series' });
    overlayG = svgEl('g', { 'data-layer': 'overlays' });
    svg.appendChild(gridG);
    svg.appendChild(seriesG);
    svg.appendChild(overlayG);
    box.replaceChildren(svg);
  }

  gridG.replaceChildren(...buildGridNodes());
  overlayG.replaceChildren(...(buildOverlayNodes ? buildOverlayNodes() : []));

  const existingNodes = new Map();
  seriesG.querySelectorAll('rect[data-bar-key]').forEach((node) => {
    existingNodes.set(node.getAttribute('data-bar-key'), node);
  });

  const nextKeys = new Set(items.map((it) => it.key));
  const exiting = [];
  for (const [k, node] of existingNodes.entries()) {
    if (!nextKeys.has(k)) {
      if (animate && !prefersReducedMotion() && prevRects.has(k)) {
        node.style.pointerEvents = 'none';
        exiting.push({ key: k, node, from: prevRects.get(k) });
      } else {
        node.remove();
      }
      existingNodes.delete(k);
    }
  }

  const entries = items.map((item) => {
    let rect = existingNodes.get(item.key);
    const prev = prevRects.get(item.key);
    const originY = item.originY ?? baselineY;
    const from = prev || { x: item.x, y: originY, width: item.width, height: 0, opacity: 0.25 };

    if (!rect) {
      rect = svgEl('rect', { 'data-bar-key': item.key });
      seriesG.appendChild(rect);
    }
    rect.setAttribute('class', item.className || '');
    if (item.neg !== undefined) rect.setAttribute('data-neg', item.neg ? '1' : '0');
    else rect.removeAttribute('data-neg');
    rect.setAttribute('rx', String(item.rx ?? 2.5));
    rect.setAttribute('fill', item.fill);
    rect.setAttribute('stroke', item.stroke || 'none');
    rect.setAttribute('stroke-width', String(item.strokeWidth ?? 0));
    rect.onclick = item.onClick || null;

    let titleEl = rect.querySelector('title');
    if (item.title) {
      if (!titleEl) {
        titleEl = svgEl('title');
        rect.appendChild(titleEl);
      }
      titleEl.textContent = item.title;
    } else if (titleEl) {
      titleEl.remove();
    }

    return { item, rect, from };
  });

  const nextMeta = {
    kind: 'bars',
    chartId,
    svg,
    gridG,
    seriesG,
    overlayG,
    currentRects: new Map(),
    rafId: 0,
  };
  box._morphState = nextMeta;

  const commitFinal = () => {
    for (const ex of exiting) ex.node.remove();
    for (const { item, rect } of entries) {
      rect.setAttribute('x', item.x.toFixed(1));
      rect.setAttribute('y', item.y.toFixed(1));
      rect.setAttribute('width', item.width.toFixed(1));
      rect.setAttribute('height', item.height.toFixed(1));
      rect.setAttribute('opacity', String(item.opacity ?? 1));
      nextMeta.currentRects.set(item.key, {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        opacity: item.opacity ?? 1,
      });
    }
  };

  if (!animate || prefersReducedMotion()) {
    commitFinal();
    return;
  }

  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / MORPH_DURATION_MS));
    const k = easeOutCubic(t);

    for (const { item, rect, from } of entries) {
      const targetOp = item.opacity ?? 1;
      const fromOp = from.opacity ?? targetOp;
      const cur = {
        x: from.x + (item.x - from.x) * k,
        y: from.y + (item.y - from.y) * k,
        width: Math.max(0.5, from.width + (item.width - from.width) * k),
        height: Math.max(0, from.height + (item.height - from.height) * k),
        opacity: fromOp + (targetOp - fromOp) * k,
      };
      rect.setAttribute('x', cur.x.toFixed(1));
      rect.setAttribute('y', cur.y.toFixed(1));
      rect.setAttribute('width', cur.width.toFixed(1));
      rect.setAttribute('height', cur.height.toFixed(1));
      rect.setAttribute('opacity', cur.opacity.toFixed(3));
      nextMeta.currentRects.set(item.key, cur);
    }

    for (const ex of exiting) {
      const curH = Math.max(0, ex.from.height * (1 - k));
      const curY = ex.from.y + (ex.from.height - curH);
      ex.node.setAttribute('y', curY.toFixed(1));
      ex.node.setAttribute('height', curH.toFixed(1));
      ex.node.setAttribute('opacity', (1 - k).toFixed(3));
    }

    if (t < 1) {
      nextMeta.rafId = requestAnimationFrame(step);
    } else {
      nextMeta.rafId = 0;
      commitFinal();
    }
  };
  nextMeta.rafId = requestAnimationFrame(step);
}

function tweenProgressBar(bar, targetRatio) {
  const clamped = Math.max(0.01, Math.min(1, Number(targetRatio) || 0));
  if (bar._progAnim?.rafId) {
    cancelAnimationFrame(bar._progAnim.rafId);
    bar._progAnim.rafId = 0;
  }
  const hasPrev = typeof bar._progVal === 'number';
  const fromVal = hasPrev ? bar._progVal : clamped;
  if (!hasPrev || Math.abs(clamped - fromVal) < 0.0005 || prefersReducedMotion()) {
    bar._progVal = clamped;
    bar.value = clamped;
    return;
  }

  const t0 = performance.now();
  const animState = { rafId: 0 };
  bar._progAnim = animState;
  const step = (now) => {
    const t = Math.min(1, (now - t0) / MORPH_DURATION_MS);
    const k = easeOutCubic(t);
    const val = fromVal + (clamped - fromVal) * k;
    bar._progVal = val;
    bar.value = val;
    if (t < 1) {
      animState.rafId = requestAnimationFrame(step);
    } else {
      animState.rafId = 0;
      bar._progVal = clamped;
      bar.value = clamped;
    }
  };
  animState.rafId = requestAnimationFrame(step);
}

function niceCeil(maxVal) {
  if (!maxVal || maxVal <= 0) return 10;
  const exp = Math.floor(Math.log10(maxVal));
  const base = 10 ** exp;
  const f = maxVal / base;
  if (f <= 1.2) return 1.2 * base;
  if (f <= 1.5) return 1.5 * base;
  if (f <= 2) return 2 * base;
  if (f <= 3) return 3 * base;
  if (f <= 5) return 5 * base;
  if (f <= 8) return 8 * base;
  return 10 * base;
}

function resolveRefTokens(snap, session) {
  if (state.refMode === '200k') return { refTokens: 200_000, label: '200K 标准窗口' };
  if (state.refMode === '1m') return { refTokens: 1_000_000, label: '1M 扩展窗口' };

  const cal = snap?.calibration;
  const subAvg = cal?.subagentObservedCompaction?.avg;
  const mainAvg = cal?.mainObservedCompaction?.avg;
  if (session?.isSubagent && subAvg) {
    return { refTokens: subAvg, label: `子智能体实测压缩 (${fmtCompact(subAvg)})` };
  }
  if (mainAvg) {
    return { refTokens: mainAvg, label: `实测平均压缩线 (${fmtCompact(mainAvg)})` };
  }
  const fallback = cal?.recommendedRefTokens || cal?.fallbackRefTokens || 256_000;
  return { refTokens: fallback, label: `基准参考线 (${fmtCompact(fallback)})` };
}

function getEffectiveComposition(session) {
  if (session?.composition?.categories?.length) {
    return session.composition;
  }
  const latest = session?.latestTurn;
  const prompt = latest?.promptTokens || 0;
  const out = latest?.outputTokens || 0;
  const total = Math.max(0, prompt + out);
  const uncached = latest?.inputTokens || 0;
  const cached = latest?.cacheReadTokens || 0;

  // Fallback synthesis when older host process lacks v3 composition field
  const tools = Math.round(total * 0.68);
  const thinking = Math.round(total * 0.15);
  const system = Math.round(total * 0.08);
  const user = Math.round(total * 0.05);
  const answer = Math.max(0, total - (tools + thinking + system + user));

  return {
    categories: [
      { key: 'tools', label: COMP_COLORS.tools.label, tokens: tools, share: total > 0 ? tools / total : 0, deltaTokens: 0 },
      { key: 'system', label: COMP_COLORS.system.label, tokens: system, share: total > 0 ? system / total : 0, deltaTokens: 0 },
      { key: 'thinking', label: COMP_COLORS.thinking.label, tokens: thinking, share: total > 0 ? thinking / total : 0, deltaTokens: 0 },
      { key: 'user', label: COMP_COLORS.user.label, tokens: user, share: total > 0 ? user / total : 0, deltaTokens: 0 },
      { key: 'answer', label: COMP_COLORS.answer.label, tokens: answer, share: total > 0 ? answer / total : 0, deltaTokens: 0 },
    ],
    promptTokens: prompt,
    outputTokens: out,
    uncachedInputTokens: uncached,
    cacheReadTokens: cached,
  };
}

// ---------- Popovers & Tabs ----------
function closePopover(id) {
  const pop = $(id);
  if (!pop) return;
  if (typeof pop.hidePopover === 'function') {
    try {
      if (pop.matches(':popover-open')) pop.hidePopover();
    } catch {
      pop.hidden = true;
    }
  } else {
    pop.hidden = true;
  }
}

function wirePopovers() {
  const supportsPopover = Object.hasOwn(HTMLElement.prototype, 'popover');
  const supportsCommand = 'commandForElement' in HTMLButtonElement.prototype;
  const pairs = [
    ['sessionPickerBtn', 'sessionPopover'],
    ['dockNavBtn', 'dockNavPopover'],
  ];

  for (const [btnId, popId] of pairs) {
    const btn = $(btnId);
    const pop = $(popId);
    if (!btn || !pop) continue;

    if (!supportsPopover) {
      pop.removeAttribute('popover');
      pop.hidden = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.hidden = !pop.hidden;
      });
      document.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) {
          pop.hidden = true;
        }
      });
    } else if (!supportsCommand) {
      btn.addEventListener('click', () => {
        if (typeof pop.togglePopover === 'function') pop.togglePopover();
      });
    }
  }
}

function updateGroupGlider(groupEl) {
  if (!groupEl) return;
  const activeBtn = groupEl.querySelector('.is-active');
  if (!activeBtn || activeBtn.offsetWidth <= 0) return;

  let glider = groupEl.querySelector(':scope > .pill-glider');
  if (!glider) {
    glider = el('span', { className: 'pill-glider', 'aria-hidden': 'true' });
    groupEl.prepend(glider);
    groupEl.classList.add('has-glider');
    // Snap initial placement before enabling CSS spring transition on future clicks
    glider.style.transition = 'none';
    glider.style.width = `${activeBtn.offsetWidth}px`;
    glider.style.height = `${activeBtn.offsetHeight}px`;
    glider.style.transform = `translate3d(${activeBtn.offsetLeft}px, ${activeBtn.offsetTop}px, 0)`;
    void glider.offsetWidth;
    glider.style.transition = '';
    return;
  }

  glider.style.opacity = '1';
  glider.style.width = `${activeBtn.offsetWidth}px`;
  glider.style.height = `${activeBtn.offsetHeight}px`;
  glider.style.transform = `translate3d(${activeBtn.offsetLeft}px, ${activeBtn.offsetTop}px, 0)`;
}

function updateAllGliders() {
  document.querySelectorAll('.period-tabs, .capsule-group').forEach(updateGroupGlider);
}

function animateSoftFade(node) {
  if (!node || prefersReducedMotion() || typeof node.animate !== 'function') return;
  node._softAnim?.cancel();
  node._softAnim = node.animate(
    [
      { opacity: 0.45, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

function animatePanelEnter(panelEl) {
  if (!panelEl || prefersReducedMotion() || typeof panelEl.animate !== 'function') return;
  panelEl._panelAnim?.cancel();
  panelEl._panelAnim = panelEl.animate(
    [
      { opacity: 0, transform: 'translateY(8px) scale(0.992)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 230, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );

  panelEl.querySelectorAll(':scope > .shell-section').forEach((sec, idx) => {
    if (idx > 4) return;
    sec._secAnim?.cancel();
    sec._secAnim = sec.animate(
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      {
        duration: 220,
        delay: idx * 22,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'backwards',
      },
    );
  });
}

function animateHeroNumber(targetValue) {
  const elNum = $('heroMainNumber');
  if (!elNum) return;
  const target = Math.max(0, Math.round(Number(targetValue) || 0));

  if (state.heroRafId) {
    cancelAnimationFrame(state.heroRafId);
    state.heroRafId = 0;
  }

  const from = state.displayedHeroValue;
  if (from === null || from === target || prefersReducedMotion()) {
    state.displayedHeroValue = target;
    elNum.textContent = fmtExact(target);
    return;
  }

  const start = performance.now();
  const duration = 260;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    const cur = Math.round(from + (target - from) * eased);
    state.displayedHeroValue = cur;
    elNum.textContent = fmtExact(cur);
    if (t < 1) {
      state.heroRafId = requestAnimationFrame(step);
    } else {
      state.heroRafId = 0;
      state.displayedHeroValue = target;
      elNum.textContent = fmtExact(target);
    }
  };
  state.heroRafId = requestAnimationFrame(step);
}

function switchTab(nextTab) {
  if (!TAB_LABELS[nextTab]) return;
  const changed = nextTab !== state.tab;
  state.tab = nextTab;

  let activePanel = null;
  document.querySelectorAll('.view-panel').forEach((panel) => {
    const isTarget = panel.id === `panel-${nextTab}`;
    panel.hidden = !isTarget;
    if (isTarget) activePanel = panel;
  });

  const navLabel = $('dockNavLabel');
  if (navLabel) navLabel.textContent = TAB_LABELS[nextTab];

  document.querySelectorAll('.dock-nav-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.jumpTab === nextTab);
  });

  if (changed) state.animatePending = true;
  render();
  if (changed) {
    const scroller = document.querySelector('.shell-scroll');
    if (scroller) scroller.scrollTop = 0;
    if (activePanel) animatePanelEnter(activePanel);
  }
  requestAnimationFrame(updateAllGliders);
}

function syncGroupActive(selector, propName, activeValue) {
  document.querySelectorAll(selector).forEach((item) => {
    item.classList.toggle('is-active', item.dataset[propName] === activeValue);
  });
  requestAnimationFrame(updateAllGliders);
}

function wireInteractions() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.dataset.period) {
      state.rangeDays = btn.dataset.period;
      state.heroMode = btn.dataset.period === '1' ? 'window' : 'total';
      syncGroupActive('[data-period]', 'period', state.rangeDays);
      syncGroupActive('[data-range]', 'range', state.rangeDays);
      syncGroupActive('[data-hero-mode]', 'heroMode', state.heroMode);
      state.animatePending = true;
      refreshNow(true);
      return;
    }
    if (btn.dataset.heroMode) {
      state.heroMode = btn.dataset.heroMode;
      syncGroupActive('[data-hero-mode]', 'heroMode', state.heroMode);
      renderHomeTab();
      animateSoftFade($('heroSubRow')?.parentElement);
      return;
    }
    if (btn.dataset.ref) {
      state.refMode = btn.dataset.ref;
      syncGroupActive('[data-ref]', 'ref', state.refMode);
      if (state.tab === 'home') {
        renderHomeTab();
      } else if (state.tab === 'context') {
        renderContextTab();
      }
      return;
    }
    if (btn.dataset.turnMode) {
      state.turnMode = btn.dataset.turnMode;
      syncGroupActive('[data-turn-mode]', 'turnMode', state.turnMode);
      state.animatePending = true;
      renderTurnChart();
      state.animatePending = false;
      return;
    }
    if (btn.dataset.evFilter) {
      state.eventFilter = btn.dataset.evFilter;
      syncGroupActive('[data-ev-filter]', 'evFilter', state.eventFilter);
      renderContextEvents();
      animateSoftFade($('contextEventsList'));
      return;
    }
    if (btn.dataset.fileFilter) {
      state.fileFilter = btn.dataset.fileFilter;
      syncGroupActive('[data-file-filter]', 'fileFilter', state.fileFilter);
      renderToolsTab();
      animateSoftFade($('fileActivityList'));
      return;
    }
    if (btn.dataset.range) {
      state.rangeDays = btn.dataset.range;
      syncGroupActive('[data-range]', 'range', state.rangeDays);
      syncGroupActive('[data-period]', 'period', state.rangeDays);
      state.animatePending = true;
      refreshNow(true);
      return;
    }
    if (btn.dataset.scope) {
      state.usageScope = btn.dataset.scope;
      syncGroupActive('[data-scope]', 'scope', state.usageScope);
      state.animatePending = true;
      refreshNow(true);
      return;
    }
    if (btn.dataset.tokSplit) {
      state.tokSplit = btn.dataset.tokSplit;
      syncGroupActive('[data-tok-split]', 'tokSplit', state.tokSplit);
      state.animatePending = true;
      renderTokensChart();
      state.animatePending = false;
      return;
    }
    if (btn.dataset.tokStyle) {
      state.tokStyle = btn.dataset.tokStyle;
      syncGroupActive('[data-tok-style]', 'tokStyle', state.tokStyle);
      state.animatePending = true;
      renderTokensChart();
      state.animatePending = false;
      return;
    }
    if (btn.dataset.jumpTab) {
      switchTab(btn.dataset.jumpTab);
      closePopover('dockNavPopover');
    }
  });
}

// ---------- Shared Components ----------
function renderCompositionBar(container, composition, refTokens) {
  const cats = composition?.categories || [];
  const cap = Math.max(1, refTokens);
  const occupied = cats.reduce((acc, c) => acc + (c.tokens || 0), 0);
  const denom = Math.max(cap, occupied);
  const freeRaw = Math.max(0, cap - occupied);
  const bufferTokens = occupied > 0 ? Math.min(freeRaw, Math.round(cap * 0.04)) : 0;
  const freeTokens = Math.max(0, freeRaw - bufferTokens);

  const specs = [];
  for (const c of cats) {
    if (!c.tokens || c.tokens <= 0) continue;
    const pct = (c.tokens / denom) * 100;
    specs.push({
      key: c.key,
      className: `comp-seg tone-${c.key}`,
      width: `${pct.toFixed(2)}%`,
      title: `${c.label}: ${fmtExact(c.tokens)} tokens (${pct.toFixed(1)}%)`,
    });
  }
  if (bufferTokens > 0) {
    specs.push({
      key: 'buffer',
      className: 'comp-seg tone-buffer',
      width: `${((bufferTokens / denom) * 100).toFixed(2)}%`,
      title: `自动压缩安全缓冲: ~${fmtExact(bufferTokens)} tokens`,
    });
  }
  if (freeTokens > 0 || occupied === 0) {
    specs.push({
      key: 'free',
      className: 'comp-seg tone-free',
      width: null,
      title: `剩余可用窗口: ${fmtExact(freeTokens)} tokens`,
    });
  }

  const existingByKey = new Map();
  for (const child of Array.from(container.children)) {
    const k = child.dataset?.segKey;
    if (k) existingByKey.set(k, child);
  }

  const targetKeys = new Set(specs.map((s) => s.key));
  const reduced = prefersReducedMotion();
  for (const [k, node] of existingByKey.entries()) {
    if (targetKeys.has(k)) continue;
    if (k === 'free' || reduced) {
      node.remove();
      existingByKey.delete(k);
    } else if (!node.classList.contains('is-exiting')) {
      node.classList.add('is-exiting');
      node.style.width = '0%';
      node._exitTimer = setTimeout(() => {
        if (node.classList.contains('is-exiting')) node.remove();
      }, 370);
    }
  }

  const firstPaint = !container._compInit;
  container._compInit = true;
  const newlyCreated = [];
  let cursor = null;
  for (const s of specs) {
    let node = existingByKey.get(s.key);
    const isNew = !node;
    if (!node) {
      node = el('div', {
        className: s.className,
        'data-seg-key': s.key,
        title: s.title,
      });
      if (!firstPaint && !reduced && s.width) node.style.width = '0%';
      else if (s.width) node.style.width = s.width;
    } else {
      if (node._exitTimer) {
        clearTimeout(node._exitTimer);
        node._exitTimer = 0;
      }
      node.className = s.className;
      node.title = s.title;
    }

    const expectedNext = cursor ? cursor.nextSibling : container.firstChild;
    if (node !== expectedNext) {
      container.insertBefore(node, expectedNext);
    }
    cursor = node;

    if (isNew && !firstPaint && !reduced && s.width) {
      newlyCreated.push([node, s.width]);
    } else if (!isNew) {
      if (s.width) node.style.width = s.width;
      else node.style.removeProperty('width');
    }
  }

  if (newlyCreated.length) {
    void container.offsetWidth;
    for (const [node, w] of newlyCreated) {
      node.style.width = w;
    }
  }
}

function renderProgressBars(container, badgeEl, items, totalOverride) {
  const total = typeof totalOverride === 'number'
    ? totalOverride
    : items.reduce((acc, item) => acc + (item.count || 0), 0);
  if (badgeEl) badgeEl.textContent = `${fmtExact(total)} 次`;

  if (!items.length || total <= 0) {
    container.replaceChildren(el('div', { className: 'empty-state', textContent: '暂无工具调用记录' }));
    return;
  }

  const existingByKey = new Map();
  for (const row of Array.from(container.children)) {
    const k = row.dataset?.itemKey;
    if (k) existingByKey.set(k, row);
    else row.remove();
  }

  const keepKeys = new Set(items.map((item) => item.name));
  for (const [k, row] of existingByKey.entries()) {
    if (!keepKeys.has(k)) {
      row.remove();
      existingByKey.delete(k);
    }
  }

  let cursor = null;
  items.forEach((item, idx) => {
    const ratio = typeof item.share === 'number' ? item.share : item.count / total;
    const clamped = Math.max(0.01, Math.min(1, ratio));
    const tone = TOOL_TONES[idx % TOOL_TONES.length];
    let row = existingByKey.get(item.name);

    if (!row) {
      const bar = el('progress', {
        className: 'ios-progress',
        max: '1',
        value: clamped.toFixed(4),
        'aria-label': `${item.name} 占比 ${(ratio * 100).toFixed(1)}%`,
      });
      bar.style.setProperty('--tone-color', tone);
      bar._progVal = clamped;
      row = el('div', { className: 'progress-row', 'data-item-key': item.name }, [
        el('span', { className: 'progress-name', textContent: item.name, title: item.name }),
        bar,
        el('div', { className: 'progress-stats' }, [
          el('span', { 'data-stat-count': '1', textContent: fmtExact(item.count) }),
          el('span', { className: 'progress-pct', 'data-stat-pct': '1', textContent: `${(ratio * 100).toFixed(1)}%` }),
        ]),
      ]);
    } else {
      const bar = row.querySelector('progress.ios-progress');
      const countEl = row.querySelector('[data-stat-count]');
      const pctEl = row.querySelector('[data-stat-pct]');
      if (bar) {
        bar.style.setProperty('--tone-color', tone);
        bar.setAttribute('aria-label', `${item.name} 占比 ${(ratio * 100).toFixed(1)}%`);
        tweenProgressBar(bar, clamped);
      }
      if (countEl) countEl.textContent = fmtExact(item.count);
      if (pctEl) pctEl.textContent = `${(ratio * 100).toFixed(1)}%`;
    }

    const expectedNext = cursor ? cursor.nextSibling : container.firstChild;
    if (row !== expectedNext) container.insertBefore(row, expectedNext);
    cursor = row;
  });
}

function formatHeatDetail(c) {
  if (!c) return '';
  if (c.isFuture) return `${c.date} (未来日期)`;
  return `${c.date} · ${fmtCompact(c.totalTokens)} tok · ${c.apiCalls} 请求 · 命中 ${fmtPct(c.cacheHitRatio)}`;
}

function syncHeatSelectionUI(selectedDate, cellsByDate, infoEl) {
  document.querySelectorAll('.heat-cell[data-date]').forEach((btn) => {
    const isSel = Boolean(selectedDate && btn.dataset.date === selectedDate);
    btn.classList.toggle('is-selected', isSel);
    btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
  });
  if (infoEl) {
    const picked = selectedDate ? cellsByDate.get(selectedDate) : null;
    infoEl.textContent = picked ? formatHeatDetail(picked) : (infoEl.dataset.defaultText || '点击或悬停日期格查看详情');
  }
}

function renderHeatmapInto(box, infoEl, compact = false) {
  const heatmap = state.snap?.usage?.heatmap;
  if (!heatmap || !Array.isArray(heatmap.cells) || !heatmap.cells.length) {
    box._heatSignature = '';
    box._heatBtns = null;
    box.replaceChildren(el('div', { className: 'empty-state', textContent: '暂无活动热力图数据' }));
    return;
  }

  if (infoEl && !infoEl.dataset.defaultText) {
    infoEl.dataset.defaultText = infoEl.textContent || '点击或悬停日期格查看详情';
  }

  const weeks = heatmap.weeks || 24;
  const maxVal = Math.max(1, heatmap.maxTokens);
  const sig = `${compact ? '1' : '0'}|${weeks}|${heatmap.cells[0]?.date}|${heatmap.cells[heatmap.cells.length - 1]?.date}`;
  const computeLvl = (c) => {
    if (c.isFuture || c.totalTokens <= 0) return 0;
    const ratio = c.totalTokens / maxVal;
    if (ratio >= 0.88) return 5;
    if (ratio >= 0.62) return 4;
    if (ratio >= 0.36) return 3;
    if (ratio >= 0.14) return 2;
    return 1;
  };

  if (box._heatSignature === sig && box._heatBtns && box.firstElementChild) {
    const cellsByDate = new Map();
    for (const c of heatmap.cells) {
      cellsByDate.set(c.date, c);
      const cellBtn = box._heatBtns.get(c.date);
      if (!cellBtn) continue;
      cellBtn._heatCell = c;
      const lvl = computeLvl(c);
      const isSelected = !c.isFuture && state.selectedHeatDate === c.date;
      cellBtn.setAttribute('data-level', String(lvl));
      cellBtn.classList.toggle('is-selected', isSelected);
      cellBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      cellBtn.title = c.isFuture ? c.date : `${c.date}: ${fmtCompact(c.totalTokens)} tok · ${c.apiCalls} 请求`;
      cellBtn.setAttribute('aria-label', `${c.date}: ${fmtCompact(c.totalTokens)} tokens, ${c.apiCalls} API calls`);
    }
    box._heatCellsByDate = cellsByDate;
    if (infoEl) {
      const picked = state.selectedHeatDate ? cellsByDate.get(state.selectedHeatDate) : null;
      infoEl.textContent = picked ? formatHeatDetail(picked) : infoEl.dataset.defaultText;
    }
    return;
  }

  box.replaceChildren();
  box.style.setProperty('--heat-weeks', String(weeks));

  const monthRow = el('div', { className: 'heatmap-months' }, [el('span')]);
  let lastMonth = '';
  let lastWeekIdx = -4;
  for (let w = 0; w < weeks; w += 1) {
    const firstCell = heatmap.cells[w * 7];
    const m = firstCell ? `${Number(firstCell.date.slice(5, 7))}月` : '';
    const show = m && m !== lastMonth && w - lastWeekIdx >= 3 ? m : '';
    if (show) {
      lastMonth = m;
      lastWeekIdx = w;
    }
    monthRow.appendChild(el('span', { textContent: show }));
  }

  const dayNames = compact ? ['', '', '三', '', '', '', '日'] : ['一', '', '三', '', '五', '', '日'];
  const weekdaysCol = el(
    'div',
    { className: 'heatmap-weekdays' },
    dayNames.map((n) => el('span', { textContent: n })),
  );

  const cols = el('div', { className: 'heatmap-cols' });
  const colsByWeek = Array.from({ length: weeks }, () => el('div', { className: 'heatmap-week' }));
  const cellsByDate = new Map();
  const btnsByDate = new Map();

  for (const c of heatmap.cells) {
    cellsByDate.set(c.date, c);
    const lvl = computeLvl(c);
    const isSelected = !c.isFuture && state.selectedHeatDate === c.date;
    const cellBtn = el('button', {
      type: 'button',
      className: `heat-cell${c.isToday ? ' is-today' : ''}${c.isFuture ? ' is-future' : ''}${isSelected ? ' is-selected' : ''}`,
      'data-level': lvl,
      'data-date': c.date,
      'aria-pressed': isSelected ? 'true' : 'false',
      title: c.isFuture ? c.date : `${c.date}: ${fmtCompact(c.totalTokens)} tok · ${c.apiCalls} 请求`,
      'aria-label': `${c.date}: ${fmtCompact(c.totalTokens)} tokens, ${c.apiCalls} API calls`,
    });
    cellBtn._heatCell = c;
    btnsByDate.set(c.date, cellBtn);

    if (infoEl) {
      cellBtn.addEventListener('mouseenter', () => {
        infoEl.textContent = formatHeatDetail(cellBtn._heatCell);
      });
    }
    if (!c.isFuture) {
      cellBtn.addEventListener('click', () => {
        state.selectedHeatDate = state.selectedHeatDate === c.date ? '' : c.date;
        syncHeatSelectionUI(state.selectedHeatDate, box._heatCellsByDate || cellsByDate, infoEl);
      });
    }

    const wIdx = Math.max(0, Math.min(weeks - 1, c.weekIndex));
    colsByWeek[wIdx].appendChild(cellBtn);
  }

  box._heatSignature = sig;
  box._heatBtns = btnsByDate;
  box._heatCellsByDate = cellsByDate;

  if (infoEl) {
    cols.addEventListener('mouseleave', () => {
      const map = box._heatCellsByDate || cellsByDate;
      const picked = state.selectedHeatDate ? map.get(state.selectedHeatDate) : null;
      infoEl.textContent = picked ? formatHeatDetail(picked) : infoEl.dataset.defaultText;
    });
    const initialPicked = state.selectedHeatDate ? cellsByDate.get(state.selectedHeatDate) : null;
    if (initialPicked) {
      infoEl.textContent = formatHeatDetail(initialPicked);
    } else {
      infoEl.textContent = infoEl.dataset.defaultText;
    }
  }

  colsByWeek.forEach((col) => cols.appendChild(col));
  box.appendChild(
    el('div', { className: 'heatmap-wrap' }, [
      monthRow,
      el('div', { className: 'heatmap-body' }, [weekdaysCol, cols]),
    ]),
  );
}

// ---------- Header & Popovers ----------
function renderHeaderAndPopovers() {
  const snap = state.snap;
  const sessions = snap?.sessions || [];
  const selected = snap?.selectedSession;
  const activeId = snap?.activeConversationId;

  const liveDot = $('liveDot');
  const liveBadge = $('liveCountChip');
  if (liveDot) liveDot.classList.remove('is-error');
  if (liveBadge) liveBadge.textContent = sessions.length ? `· ${sessions.length} 会话` : '· 就绪';

  const labelEl = $('sessionPickerLabel');
  if (labelEl) {
    const titleOverride = params.get('title');
    labelEl.textContent = titleOverride || (selected ? `${selected.title || selected.shortId}` : '选择对话会话');
  }

  const jumpBtn = $('jumpActiveBtn');
  if (jumpBtn) {
    jumpBtn.hidden = !Boolean(activeId && selected && selected.id !== activeId);
  }

  $('popoverSessionCount').textContent = `${sessions.length} 个`;
  const popList = $('sessionPopoverList');
  popList.replaceChildren();

  if (!sessions.length) {
    popList.appendChild(el('div', { className: 'empty-state', textContent: '暂无本地会话' }));
    return;
  }

  for (const s of sessions.slice(0, 18)) {
    const isSel = selected && s.id === selected.id;
    const badgeCls = s.isSubagent ? 'tag-chip is-sub' : 'tag-chip is-main';
    const badgeLabel = s.isCurrentHostSession ? '当前' : (s.isSubagent ? (s.agentName || '子智能体') : '主对话');

    const rowBtn = el(
      'button',
      { type: 'button', className: `list-row-btn${isSel ? ' is-selected' : ''}` },
      [
        el('div', { className: 'list-row' }, [
          el('div', { className: 'row-main' }, [
            el('div', { className: 'row-title-wrap' }, [
              el('span', { className: badgeCls, textContent: badgeLabel }),
              el('span', { className: 'row-title', textContent: s.title || s.shortId }),
            ]),
            el('span', {
              className: 'row-detail',
              textContent: `累计 ${fmtCompact(s.totalTokens)} · ${fmtRelTime(s.lastUpdatedAt)}`,
            }),
          ]),
          el('div', { className: 'row-side' }, [
            el('span', { textContent: fmtCompact(s.latestPromptTokens) }),
            el('span', { className: 'mono-muted', textContent: `${s.apiCalls} 轮` }),
          ]),
        ]),
      ],
    );

    rowBtn.addEventListener('click', () => {
      state.selectedTargetId = s.id;
      state.pinnedTurnSeq = null;
      state.animatePending = true;
      state.fadeOnRender = true;
      closePopover('sessionPopover');
      refreshNow(true);
    });
    popList.appendChild(rowBtn);
  }
}

// ---------- Tab 1: Home (Unified Single-Sheet View) ----------
function renderHomeTab() {
  const snap = state.snap;
  const s = snap?.selectedSession;
  const usage = snap?.usage;
  if (!s) return;

  const { refTokens, label } = resolveRefTokens(snap, s);
  const latest = s.latestTurn;
  const promptTokens = latest?.promptTokens || 0;
  const ratio = refTokens > 0 ? promptTokens / refTokens : 0;
  const pct = ratio * 100;
  const remaining = Math.max(0, refTokens - promptTokens);
  const cacheRatio = s.totals?.cacheHitRatio || 0;

  if (state.heroMode === 'total') {
    $('heroEyebrow').textContent = 'SESSION TOTAL TOKENS · 本会话累计';
    animateHeroNumber(s.totals?.totalTokens || 0);
    $('heroSubRow').textContent = `${s.totals?.apiCalls || 0} 轮调用 · 全工作区 ${fmtCompact(usage?.totals?.totalTokens || 0)} · 更新于 ${fmtRelTime(s.lastUpdatedAt)}`;
  } else {
    $('heroEyebrow').textContent = `CURRENT PROMPT · ${label}`;
    animateHeroNumber(promptTokens);
    $('heroSubRow').textContent = `缓存命中 ${fmtPct(cacheRatio)} · ${s.totals?.apiCalls || 0} 轮 · ${promptTokens > refTokens ? `超出 ${fmtCompact(promptTokens - refTokens)}` : `剩余 ${fmtCompact(remaining)}`}`;
  }

  const pctBadge = $('homePctBadge');
  pctBadge.textContent = `${pct.toFixed(1)}%`;
  pctBadge.classList.toggle('is-warn', pct >= 70 && pct < 88);
  pctBadge.classList.toggle('is-high', pct >= 88);

  // Glossy quota meters (Image 3 vibe)
  const qFill = $('homeQuotaFill');
  const cFill = $('homeCacheFill');
  const snapInit = !state.homeMetersReady;
  if (snapInit) {
    qFill?.classList.add('no-trans');
    cFill?.classList.add('no-trans');
  }
  $('homeQuotaRight').textContent = `${fmtCompact(promptTokens)} / ${fmtCompact(refTokens)}`;
  if (qFill) qFill.style.width = `${Math.min(100, Math.max(2, pct)).toFixed(1)}%`;
  $('homeQuotaMetaL').textContent = `距上次压缩 ${s.turnsSinceCompaction ?? 0} 轮 · 已压缩 ${s.totals?.checkpointCount || 0} 次`;
  $('homeQuotaMetaR').textContent = `剩余 ${(Math.max(0, 100 - pct)).toFixed(1)}%`;

  $('homeCacheRight').textContent = fmtPct(cacheRatio);
  if (cFill) cFill.style.width = `${Math.min(100, cacheRatio * 100).toFixed(1)}%`;
  if (snapInit) {
    void qFill?.offsetWidth;
    qFill?.classList.remove('no-trans');
    cFill?.classList.remove('no-trans');
    state.homeMetersReady = true;
  }

  // Composition bar + compact rows
  const comp = getEffectiveComposition(s);
  renderCompositionBar($('homeCompBar'), comp, refTokens);
  const miniList = $('homeCompList');
  miniList.replaceChildren();
  const totalOcc = Math.max(1, comp.categories.reduce((acc, c) => acc + c.tokens, 0));
  for (const c of comp.categories) {
    const sharePct = (c.tokens / totalOcc) * 100;
    const tone = COMP_COLORS[c.key]?.color || 'var(--blue)';
    miniList.appendChild(
      el('div', { className: 'comp-detail-row' }, [
        el('span', { className: 'comp-dot', style: { background: tone } }),
        el('span', { textContent: c.label }),
        el('span', { className: 'mono-num', textContent: `${fmtCompact(c.tokens)} · ${sharePct.toFixed(1)}%` }),
      ]),
    );
  }

  // Top 5 Tools
  renderProgressBars(
    $('homeToolsList'),
    $('homeToolsMeta'),
    (usage?.topTools || []).slice(0, 5),
    usage?.totalToolCalls,
  );

  // Compact Heatmap + Bottom Sparkline
  const totals = usage?.totals || {};
  $('homeActiveDaysText').textContent = `活跃 ${totals.activeDays ?? 0} 天`;
  renderHeatmapInto($('homeHeatmapBox'), $('homeHeatmapInfo'), true);

  $('homePeakText').textContent = totals.peakDay ? `峰值 ${fmtCompact(totals.peakDay.totalTokens)}` : '峰值 —';
  renderHomeSparkline($('homeSparklineBox'), usage?.days || []);
}

function renderHomeSparkline(box, days) {
  if (!days.length) {
    box._morphState = null;
    box.replaceChildren(el('div', { className: 'empty-state', textContent: '暂无近期趋势数据' }));
    return;
  }
  const w = 440;
  const h = 72;
  const padX = 6;
  const padY = 8;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const maxY = Math.max(1, ...days.map((d) => d.totalTokens || 0));

  const pts = days.map((d, i) => ({
    x: padX + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW),
    y: padY + innerH * (1 - (d.totalTokens || 0) / maxY),
  }));

  renderMorphLineSvg(box, {
    chartId: 'home-sparkline',
    w,
    h,
    xMin: padX,
    xMax: padX + innerW,
    baselineY: h - padY,
    buildDefs: () => {
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: 'homeSparkGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'var(--blue)', 'stop-opacity': '0.32' }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'var(--blue)', 'stop-opacity': '0.01' }));
      defs.appendChild(grad);
      return defs;
    },
    buildGridNodes: () => [],
    series: [{ key: 'tok', pts, stroke: 'var(--blue)', strokeWidth: 2, fill: 'url(#homeSparkGrad)' }],
    animate: state.animatePending,
  });
}

// ---------- Tab 2: Context (Grid-Free Layout) ----------
function renderContextTab() {
  const snap = state.snap;
  const s = snap?.selectedSession;
  if (!s) return;

  const fleet = snap?.fleet;
  $('ctxTurnsVal').textContent = fmtExact(s.totals?.apiCalls || 0);
  $('ctxStepsVal').textContent = fmtExact(s.totalSteps || 0);
  $('ctxCacheVal').textContent = fmtPct(s.totals?.cacheHitRatio || 0);
  $('ctxSinceCpVal').textContent = `${s.turnsSinceCompaction ?? 0} 轮`;
  $('ctxCpCountVal').textContent = `${s.totals?.checkpointCount || 0} 次`;
  $('ctxFleetVal').textContent = `${fleet?.members?.length || 1}`;

  const { refTokens, label } = resolveRefTokens(snap, s);
  const comp = getEffectiveComposition(s);
  const promptTokens = comp.promptTokens || 0;
  const remaining = Math.max(0, refTokens - promptTokens);

  $('ctxCompSub').textContent = `${label} · 无网格比例视图`;
  $('ctxBudgetUsed').textContent = `当前窗口 ${fmtExact(promptTokens)} / ${fmtCompact(refTokens)} (${((promptTokens / Math.max(1, refTokens)) * 100).toFixed(1)}%)`;
  $('ctxBudgetRemain').textContent = promptTokens > refTokens
    ? `超出基准 ${fmtExact(promptTokens - refTokens)}`
    : `预留与可用 ${fmtExact(remaining)}`;

  renderCompositionBar($('ctxStackedBar'), comp, refTokens);

  const list = $('ctxCompRows');
  const totalCatTokens = Math.max(1, comp.categories.reduce((acc, c) => acc + c.tokens, 0));
  const existingRows = new Map();
  for (const row of Array.from(list.children)) {
    const k = row.dataset?.catKey;
    if (k) existingRows.set(k, row);
    else row.remove();
  }

  let cursor = null;
  for (const c of comp.categories) {
    const tone = COMP_COLORS[c.key]?.color || 'var(--blue)';
    const share = c.tokens / totalCatTokens;
    const clamped = Math.max(0.01, Math.min(1, share));
    const delta = Number(c.deltaTokens) || 0;
    const deltaCls = delta > 0 ? 'comp-delta-chip is-up' : delta < 0 ? 'comp-delta-chip is-down' : 'comp-delta-chip';
    const deltaTxt = delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${fmtCompact(delta)}`;
    const statTxt = `${fmtExact(c.tokens)} (${(share * 100).toFixed(1)}%)`;

    let row = existingRows.get(c.key);
    if (!row) {
      const bar = el('progress', {
        className: 'ios-progress',
        max: '1',
        value: clamped.toFixed(4),
        'aria-label': `${c.label} 占比 ${(share * 100).toFixed(1)}%`,
      });
      bar.style.setProperty('--tone-color', tone);
      bar._progVal = clamped;

      row = el('div', { className: 'comp-detail-row', 'data-cat-key': c.key }, [
        el('span', { className: 'comp-dot', style: { background: tone } }),
        el('div', { className: 'comp-detail-main' }, [
          el('div', { className: 'comp-detail-top' }, [
            el('span', { textContent: c.label }),
            el('span', { className: 'mono-num', 'data-cat-stat': '1', textContent: statTxt }),
          ]),
          bar,
        ]),
        el('span', { className: deltaCls, 'data-cat-delta': '1', textContent: deltaTxt, title: '相比上一轮净变化' }),
      ]);
    } else {
      const bar = row.querySelector('progress.ios-progress');
      const statEl = row.querySelector('[data-cat-stat]');
      const deltaEl = row.querySelector('[data-cat-delta]');
      if (bar) {
        bar.style.setProperty('--tone-color', tone);
        bar.setAttribute('aria-label', `${c.label} 占比 ${(share * 100).toFixed(1)}%`);
        tweenProgressBar(bar, clamped);
      }
      if (statEl) statEl.textContent = statTxt;
      if (deltaEl) {
        deltaEl.className = deltaCls;
        deltaEl.textContent = deltaTxt;
      }
    }

    const expectedNext = cursor ? cursor.nextSibling : list.firstChild;
    if (row !== expectedNext) list.insertBefore(row, expectedNext);
    cursor = row;
  }

  renderTurnChart();
  renderContextEvents();
}

function renderStepBriefForTurn(turn) {
  if (!turn) {
    $('briefTurnTitle').textContent = '轮次摘要';
    $('briefTurnMeta').textContent = '暂无调用';
    $('briefUser').textContent = '—';
    $('briefIn').textContent = '—';
    $('briefResp').textContent = '—';
    return;
  }

  const brief = turn.stepBrief || {
    user: '延续当前对话',
    inSummary: `Prompt ${fmtCompact(turn.promptTokens)} tokens`,
    response: turn.toolNames?.length ? `调用 ${turn.toolNames.slice(0, 3).join(', ')}` : '模型回复',
  };

  $('briefTurnTitle').textContent = `第 #${turn.seq} 轮摘要${turn.compactedBefore ? ' · ✂ 已压缩' : ''}`;
  $('briefTurnMeta').textContent = `Prompt ${fmtCompact(turn.promptTokens)} · Out ${fmtCompact(turn.outputTokens)} · ${fmtShortClock(turn.createdAt)}`;
  $('briefUser').textContent = brief.user;
  $('briefIn').textContent = brief.inSummary;
  $('briefResp').textContent = brief.response;
}

function renderTurnChart() {
  const s = state.snap?.selectedSession;
  const box = $('turnChartBox');

  if (!s || !Array.isArray(s.turns) || !s.turns.length) {
    box._morphState = null;
    box.replaceChildren(el('div', { className: 'empty-state', textContent: '当前会话尚无 API 调用记录' }));
    renderStepBriefForTurn(null);
    return;
  }

  const turns = s.turns;
  const activeTurn = turns.find((t) => t.seq === state.pinnedTurnSeq) || turns[turns.length - 1];
  renderStepBriefForTurn(activeTurn);

  const w = 520;
  const h = 152;
  const padL = 42;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const isDelta = state.turnMode === 'delta';
  const stepW = innerW / turns.length;

  let baselineY = padT + innerH;
  const items = [];
  const overlayNodes = [];

  if (isDelta) {
    $('turnChartSubtitle').textContent = 'Delta 模式 · 正值为新增上下文，负值绿色代表压缩回收';
    const deltas = turns.map((t) => (typeof t.deltaPromptTokens === 'number' ? t.deltaPromptTokens : t.promptTokens));
    const maxAbs = niceCeil(Math.max(5000, ...deltas.map((v) => Math.abs(v))));
    const hasNeg = deltas.some((v) => v < 0);
    baselineY = hasNeg ? padT + innerH * 0.68 : padT + innerH;
    const posScale = baselineY - padT;
    const negScale = padT + innerH - baselineY;
    const barW = Math.max(2.5, Math.min(14, stepW * 0.72));

    turns.forEach((t, idx) => {
      const d = deltas[idx];
      const cx = padL + (idx + 0.5) * stepW;
      const bh = Math.max(2, Math.min(1, Math.abs(d) / maxAbs) * (d >= 0 ? posScale : Math.max(10, negScale)));
      const y = d >= 0 ? baselineY - bh : baselineY;
      const isSelected = Boolean(activeTurn && activeTurn.seq === t.seq);
      const fill = d < 0 ? 'var(--ok)' : d >= 15_000 ? 'var(--orange)' : 'var(--bar-teal)';
      items.push({
        key: `turn:${t.seq}`,
        className: `trend-bar-btn${isSelected ? ' is-selected' : ''}`,
        neg: d < 0,
        x: cx - barW / 2,
        y,
        width: barW,
        height: bh,
        originY: baselineY,
        rx: 2.5,
        fill,
        opacity: 1,
        stroke: isSelected ? 'var(--text)' : 'none',
        strokeWidth: isSelected ? 1.2 : 0,
        title: `#${t.seq} · ${d >= 0 ? '+' : ''}${fmtCompact(d)}`,
        onClick: () => {
          state.pinnedTurnSeq = t.seq;
          renderTurnChart();
        },
      });
    });

    renderMorphBarsSvg(box, {
      chartId: 'ctx-turns',
      w,
      h,
      baselineY,
      ariaLabel: '单轮上下文增量趋势',
      buildGridNodes: () => {
        const nodes = [
          svgEl('line', { class: 'chart-grid-line', x1: padL, y1: baselineY, x2: w - padR, y2: baselineY }),
          svgEl('text', { class: 'chart-axis-text', x: padL - 5, y: padT + 6, 'text-anchor': 'end' }, [
            document.createTextNode(`+${fmtCompact(maxAbs)}`),
          ]),
          svgEl('text', { class: 'chart-axis-text', x: padL, y: h - 4 }, [document.createTextNode(`#${turns[0].seq}`)]),
        ];
        if (turns.length > 1) {
          nodes.push(
            svgEl('text', { class: 'chart-axis-text', x: w - padR, y: h - 4, 'text-anchor': 'end' }, [
              document.createTextNode(`#${turns[turns.length - 1].seq} 轮`),
            ]),
          );
        }
        return nodes;
      },
      buildOverlayNodes: () => overlayNodes,
      items,
      animate: state.animatePending,
    });
    return;
  }

  $('turnChartSubtitle').textContent = 'Total 模式 · 点击任意柱查看该轮 User / In / Response 摘要';
  const maxY = niceCeil(Math.max(10_000, ...turns.map((t) => t.promptTokens)));
  const barW = Math.max(2.5, Math.min(12, stepW * 0.72));

  turns.forEach((t, idx) => {
    const cx = padL + (idx + 0.5) * stepW;
    const bh = Math.max(2, (t.promptTokens / maxY) * innerH);
    const y = padT + innerH - bh;
    const isSelected = Boolean(activeTurn && activeTurn.seq === t.seq);

    items.push({
      key: `turn:${t.seq}`,
      className: `trend-bar-btn${isSelected ? ' is-selected' : ''}`,
      neg: false,
      x: cx - barW / 2,
      y,
      width: barW,
      height: bh,
      originY: baselineY,
      rx: 2.5,
      fill: isSelected ? 'var(--accent)' : 'var(--blue)',
      opacity: isSelected ? 1 : 0.84,
      stroke: 'none',
      strokeWidth: 0,
      title: `#${t.seq} · ${fmtCompact(t.promptTokens)}`,
      onClick: () => {
        state.pinnedTurnSeq = t.seq;
        renderTurnChart();
      },
    });

    if (t.compactedBefore) {
      overlayNodes.push(
        svgEl('line', {
          x1: cx.toFixed(1),
          y1: padT,
          x2: cx.toFixed(1),
          y2: padT + innerH,
          stroke: 'var(--ok)',
          'stroke-width': '1',
          'stroke-dasharray': '3 3',
        }),
        svgEl('text', { class: 'chart-axis-text', x: cx.toFixed(1), y: padT + 8, 'text-anchor': 'middle' }, [
          document.createTextNode('✂'),
        ]),
      );
    }
  });

  renderMorphBarsSvg(box, {
    chartId: 'ctx-turns',
    w,
    h,
    baselineY,
    ariaLabel: '逐轮上下文堆叠趋势',
    buildGridNodes: () => {
      const nodes = [];
      [0, 0.5, 1].forEach((f) => {
        const y = padT + innerH * (1 - f);
        nodes.push(
          svgEl('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: w - padR, y2: y }),
          svgEl('text', { class: 'chart-axis-text', x: padL - 5, y: y + 3, 'text-anchor': 'end' }, [
            document.createTextNode(f === 0 ? '0' : fmtCompact(maxY * f)),
          ]),
        );
      });
      nodes.push(svgEl('text', { class: 'chart-axis-text', x: padL, y: h - 4 }, [document.createTextNode(`#${turns[0].seq}`)]));
      if (turns.length > 1) {
        nodes.push(
          svgEl('text', { class: 'chart-axis-text', x: w - padR, y: h - 4, 'text-anchor': 'end' }, [
            document.createTextNode(`#${turns[turns.length - 1].seq} 轮`),
          ]),
        );
      }
      return nodes;
    },
    buildOverlayNodes: () => overlayNodes,
    items,
    animate: state.animatePending,
  });
}

function renderContextEvents() {
  const s = state.snap?.selectedSession;
  const list = $('contextEventsList');
  list.replaceChildren();
  if (!s) return;

  const events = Array.isArray(s.events) ? s.events : [];
  const filtered = state.eventFilter === 'all' ? events : events.filter((ev) => ev.kind === state.eventFilter);

  if (!filtered.length) {
    list.appendChild(el('div', { className: 'empty-state', textContent: '当前筛选下暂无事件记录' }));
    return;
  }

  const kindMap = {
    compact: ['压缩', 'is-compact'],
    spike: ['跃升', 'is-spike'],
    error: ['异常', 'is-error'],
    user: ['输入', ''],
  };

  for (const ev of filtered.slice(0, 24)) {
    const [kLabel, kCls] = kindMap[ev.kind] || ['事件', ''];
    const sideText =
      typeof ev.deltaTokens === 'number'
        ? `${ev.deltaTokens >= 0 ? '+' : ''}${fmtCompact(ev.deltaTokens)}`
        : fmtShortClock(ev.createdAt);

    list.appendChild(
      el('div', { className: 'list-row' }, [
        el('div', { className: 'row-main' }, [
          el('div', { className: 'row-title-wrap' }, [
            el('span', { className: `tag-chip ${kCls}`, textContent: kLabel }),
            el('span', { className: 'row-title', textContent: ev.title }),
          ]),
          el('span', { className: 'row-detail', textContent: ev.detail }),
        ]),
        el('div', { className: 'row-side' }, [
          el('span', { textContent: sideText }),
          el('span', { className: 'mono-muted', textContent: `Step ${ev.stepIndex}` }),
        ]),
      ]),
    );
  }
}

// ---------- Tab 3: Usage Trends ----------
function renderUsageTab() {
  const usage = state.snap?.usage;
  if (!usage) return;

  const totals = usage.totals || {};
  $('kpiTotalTokens').textContent = fmtCompact(totals.totalTokens || 0);
  $('kpiApiCalls').textContent = fmtExact(totals.apiCalls || 0);
  $('kpiActiveDays').textContent = `${totals.activeDays ?? 0} 天`;
  $('kpiStreakDays').textContent = `${totals.streakDays ?? 0} 天`;
  $('kpiPeakDay').textContent = totals.peakDay ? fmtCompact(totals.peakDay.totalTokens) : '—';
  $('kpiCacheHit').textContent = fmtPct(totals.cacheHitRatio || 0);
  $('kpiToolCalls').textContent = fmtExact(totals.toolCalls || 0);
  $('kpiCheckpoints').textContent = `${totals.checkpoints || 0} 次`;

  $('heatmapSubtitle').textContent = `总活跃 ${totals.activeDays ?? 0} 天 · 连续 ${totals.streakDays ?? 0} 天 · 点击格子查看详情`;
  renderHeatmapInto($('heatmapBox'), $('heatmapHoverInfo'), false);
  renderTokensChart();
  renderCallsChart();
  renderProgressBars($('globalToolsList'), $('globalToolsTotal'), usage.topTools || [], usage.totalToolCalls);
  renderDailyTable(usage.days || []);
}

function buildChartDateTickNodes(days, padL, innerW, yPos) {
  if (!days.length) return [];
  const picks = days.length === 1 ? [0] : days.length < 5 ? [0, days.length - 1] : [0, Math.floor(days.length / 2), days.length - 1];
  return picks.map((idx, posIdx) => {
    const x = padL + (days.length === 1 ? innerW / 2 : (idx / (days.length - 1)) * innerW);
    const anchor = posIdx === 0 ? 'start' : posIdx === picks.length - 1 ? 'end' : 'middle';
    return svgEl('text', { class: 'chart-axis-text', x: x.toFixed(1), y: yPos, 'text-anchor': anchor }, [
      document.createTextNode(days[idx].label || days[idx].date.slice(5)),
    ]);
  });
}

function renderCallsChart() {
  const days = state.snap?.usage?.days || [];
  const totals = state.snap?.usage?.totals || {};
  $('callsChartSum').textContent = `区间累计 ${fmtExact(totals.apiCalls || 0)} 次`;

  const box = $('callsChartBox');
  if (!days.length) {
    box._morphState = null;
    box.replaceChildren(el('div', { className: 'empty-state', textContent: '当前区间暂无请求记录' }));
    return;
  }

  const w = 440;
  const h = 152;
  const padL = 38;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxY = niceCeil(Math.max(4, ...days.map((d) => d.apiCalls)));

  const pts = days.map((d, i) => ({
    x: padL + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW),
    y: padT + innerH * (1 - d.apiCalls / maxY),
  }));

  renderMorphLineSvg(box, {
    chartId: 'usage-calls',
    w,
    h,
    xMin: padL,
    xMax: padL + innerW,
    baselineY: padT + innerH,
    ariaLabel: '每日 API 请求趋势',
    buildDefs: () => {
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: 'callsAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'var(--blue)', 'stop-opacity': '0.35' }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'var(--blue)', 'stop-opacity': '0.02' }));
      defs.appendChild(grad);
      return defs;
    },
    buildGridNodes: () => {
      const nodes = [];
      [0, 0.5, 1].forEach((f) => {
        const y = padT + innerH * (1 - f);
        nodes.push(
          svgEl('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: w - padR, y2: y }),
          svgEl('text', { class: 'chart-axis-text', x: padL - 5, y: y + 3, 'text-anchor': 'end' }, [
            document.createTextNode(f === 0 ? '0' : fmtCompact(Math.round(maxY * f))),
          ]),
        );
      });
      nodes.push(...buildChartDateTickNodes(days, padL, innerW, h - 4));
      return nodes;
    },
    series: [{ key: 'calls', pts, stroke: 'var(--blue)', strokeWidth: 2, fill: 'url(#callsAreaGrad)' }],
    animate: state.animatePending,
  });
}

function renderTokensChart() {
  const days = state.snap?.usage?.days || [];
  const totals = state.snap?.usage?.totals || {};
  $('tokensChartSum').textContent = `区间累计 ${fmtCompact(totals.totalTokens || 0)} Tokens`;

  const box = $('tokensChartBox');
  const legend = $('tokensChartLegend');
  legend.replaceChildren();

  if (!days.length) {
    box._morphState = null;
    box.replaceChildren(el('div', { className: 'empty-state', textContent: '当前区间暂无 Token 记录' }));
    return;
  }

  const isRole = state.tokSplit === 'role';
  const labelA = isRole ? '主对话' : '缓存读取';
  const labelB = isRole ? '子智能体' : '新输入 + 输出';
  const getAB = (d) =>
    isRole
      ? [d.mainTokens || 0, d.subTokens || 0]
      : [d.cacheReadTokens || 0, (d.uncachedInputTokens || 0) + (d.outputTokens || 0)];

  let sumA = 0;
  let sumB = 0;
  for (const d of days) {
    const [a, b] = getAB(d);
    sumA += a;
    sumB += b;
  }
  const sumAB = Math.max(1, sumA + sumB);

  [
    [labelA, 'var(--bar-teal)', sumA],
    [labelB, 'var(--bar-coral)', sumB],
  ].forEach(([lbl, col, val]) => {
    legend.appendChild(
      el('div', { className: 'dash-legend-row' }, [
        el('span', { className: 'dash-legend-name' }, [
          el('span', { className: 'dash-legend-swatch', style: { background: col } }),
          el('span', { textContent: lbl }),
        ]),
        el('span', { className: 'dash-legend-val', textContent: fmtCompact(val) }),
        el('span', { className: 'dash-legend-pct', textContent: `${((val / sumAB) * 100).toFixed(1)}%` }),
      ]),
    );
  });

  const w = 440;
  const h = 152;
  const padL = 46;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxY = niceCeil(Math.max(10_000, ...days.map((d) => d.totalTokens || 0)));

  const buildGridNodes = () => {
    const nodes = [];
    [0, 0.5, 1].forEach((f) => {
      const y = padT + innerH * (1 - f);
      nodes.push(
        svgEl('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: w - padR, y2: y }),
        svgEl('text', { class: 'chart-axis-text', x: padL - 5, y: y + 3, 'text-anchor': 'end' }, [
          document.createTextNode(f === 0 ? '0' : fmtCompact(maxY * f)),
        ]),
      );
    });
    nodes.push(...buildChartDateTickNodes(days, padL, innerW, h - 4));
    return nodes;
  };

  if (state.tokStyle === 'line') {
    const ptsA = days.map((d, i) => {
      const [a] = getAB(d);
      return {
        x: padL + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW),
        y: padT + innerH * (1 - a / maxY),
      };
    });
    const ptsB = days.map((d, i) => {
      const [, b] = getAB(d);
      return {
        x: padL + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW),
        y: padT + innerH * (1 - b / maxY),
      };
    });
    renderMorphLineSvg(box, {
      chartId: 'usage-tokens',
      w,
      h,
      xMin: padL,
      xMax: padL + innerW,
      baselineY: padT + innerH,
      ariaLabel: '每日 Token 折线趋势',
      buildGridNodes,
      series: [
        { key: 'a', pts: ptsA, stroke: 'var(--bar-teal)', strokeWidth: 2, fill: null },
        { key: 'b', pts: ptsB, stroke: 'var(--bar-coral)', strokeWidth: 2, fill: null },
      ],
      animate: state.animatePending,
    });
    return;
  }

  const slotW = innerW / days.length;
  const barW = Math.max(2.5, Math.min(14, slotW * 0.68));
  const baselineY = padT + innerH;
  const items = [];

  days.forEach((d, i) => {
    const [a, b] = getAB(d);
    const total = a + b;
    if (total <= 0) return;

    const x = padL + (i + 0.5) * slotW - barW / 2;
    const hTotal = Math.max(2, (total / maxY) * innerH);
    const yTop = baselineY - hTotal;
    const hB = (b / total) * hTotal;
    const hA = Math.max(0, hTotal - hB);
    const tip = `${d.date}\n${labelA}: ${fmtCompact(a)}\n${labelB}: ${fmtCompact(b)}`;

    if (hA > 0) {
      items.push({
        key: `a:${d.date}`,
        x,
        y: yTop + hB,
        width: barW,
        height: hA,
        originY: baselineY,
        rx: hB <= 0.5 ? 3 : 1.5,
        fill: 'var(--bar-teal)',
        opacity: 1,
        title: tip,
      });
    }
    if (hB > 0) {
      items.push({
        key: `b:${d.date}`,
        x,
        y: yTop,
        width: barW,
        height: hB,
        originY: baselineY,
        rx: 3,
        fill: 'var(--bar-coral)',
        opacity: 1,
        title: tip,
      });
    }
  });

  renderMorphBarsSvg(box, {
    chartId: 'usage-tokens',
    w,
    h,
    baselineY,
    ariaLabel: '每日 Token 柱状构成',
    buildGridNodes,
    items,
    animate: state.animatePending,
  });
}

function renderDailyTable(days) {
  const tbody = $('dailyTableBody');
  tbody.replaceChildren();
  const nonEmpty = days.filter((d) => d.totalTokens > 0 || d.apiCalls > 0);
  const rows = (nonEmpty.length ? nonEmpty : days).slice(-30).reverse();

  if (!rows.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: '6', textContent: '暂无统计明细' })]));
    return;
  }

  for (const d of rows) {
    const active = (d.uncachedInputTokens || 0) + (d.outputTokens || 0);
    tbody.appendChild(
      el('tr', {}, [
        el('td', { textContent: d.date }),
        el('td', { textContent: fmtExact(d.totalTokens || 0) }),
        el('td', { textContent: fmtExact(d.cacheReadTokens || 0) }),
        el('td', { textContent: fmtExact(active) }),
        el('td', { textContent: fmtExact(d.apiCalls || 0) }),
        el('td', { textContent: String(d.checkpoints || 0) }),
      ]),
    );
  }
}

// ---------- Tab 4: Agent Fleet & Files ----------
function renderToolsTab() {
  const snap = state.snap;
  const s = snap?.selectedSession;
  const fleet = snap?.fleet;

  const fleetList = $('fleetList');
  fleetList.replaceChildren();
  const members = fleet?.members || (s ? [{ ...s, depth: 0, apiCalls: s.totals?.apiCalls || 0, latestPromptTokens: s.latestTurn?.promptTokens || 0, totalTokens: s.totals?.totalTokens || 0 }] : []);
  $('fleetCountBadge').textContent = `${members.length} 个节点`;
  $('fleetSummary').textContent = `家族总消耗 ${fmtCompact(fleet?.totalTokens || s?.totals?.totalTokens || 0)} · 点击可切换详情`;

  if (!members.length) {
    fleetList.appendChild(el('div', { className: 'empty-state', textContent: '暂无编队记录' }));
  } else {
    for (const m of members) {
      const isSelected = s && m.id === s.id;
      const prefix = m.depth > 0 ? `${'· '.repeat(Math.min(4, m.depth))}↳ ` : '';
      const roleCls = m.isSubagent ? 'tag-chip is-sub' : 'tag-chip is-main';
      const roleText = m.isSubagent ? (m.agentName || '子智能体') : '根对话';

      const btn = el(
        'button',
        { type: 'button', className: `list-row-btn${isSelected ? ' is-selected' : ''}` },
        [
          el('div', { className: 'list-row' }, [
            el('div', { className: 'row-main' }, [
              el('div', { className: 'row-title-wrap' }, [
                prefix ? el('span', { className: 'fleet-indent', textContent: prefix }) : null,
                el('span', { className: roleCls, textContent: roleText }),
                el('span', { className: 'row-title', textContent: m.title || m.shortId }),
              ]),
              el('span', {
                className: 'row-detail',
                textContent: `累计 ${fmtCompact(m.totalTokens)} · ${fmtRelTime(m.lastUpdatedAt)}`,
              }),
            ]),
            el('div', { className: 'row-side' }, [
              el('span', { textContent: fmtCompact(m.latestPromptTokens) }),
              el('span', { className: 'mono-muted', textContent: `${m.apiCalls} 轮` }),
            ]),
          ]),
        ],
      );
      btn.addEventListener('click', () => {
        state.selectedTargetId = m.id;
        state.pinnedTurnSeq = null;
        refreshNow(true);
      });
      fleetList.appendChild(btn);
    }
  }

  renderProgressBars(
    $('sessionToolsList'),
    $('sessionToolsTotal'),
    s?.toolBreakdown || [],
    s?.totalToolCalls ?? s?.totals?.toolCalls,
  );

  // File Activity with filter
  const allFiles = s?.fileActivity || [];
  const filteredFiles = allFiles.filter((f) => {
    if (state.fileFilter === 'read') return f.reads > 0;
    if (state.fileFilter === 'write') return f.writes > 0;
    if (state.fileFilter === 'search') return f.searches > 0;
    return true;
  });

  $('fileCountBadge').textContent = `${filteredFiles.length} 个`;
  const fileList = $('fileActivityList');
  fileList.replaceChildren();

  if (!filteredFiles.length) {
    fileList.appendChild(el('div', { className: 'empty-state', textContent: '当前筛选下暂无文件活动' }));
  } else {
    for (const f of filteredFiles.slice(0, 20)) {
      fileList.appendChild(
        el('div', { className: 'list-row' }, [
          el('div', { className: 'row-main' }, [
            el('span', { className: 'row-title', textContent: f.shortPath || f.path, title: f.path }),
            el('span', { className: 'row-detail', textContent: f.path }),
          ]),
          el('div', { className: 'rw-badges' }, [
            f.reads ? el('span', { className: 'tag-chip', textContent: `读 ${f.reads}` }) : null,
            f.writes ? el('span', { className: 'tag-chip is-spike', textContent: `写 ${f.writes}` }) : null,
            f.searches ? el('span', { className: 'tag-chip is-main', textContent: `搜 ${f.searches}` }) : null,
          ]),
        ]),
      );
    }
  }

  const cmdList = $('commandsList');
  cmdList.replaceChildren();
  const cmds = s?.commands || [];
  $('cmdCountBadge').textContent = `${cmds.length} 条`;

  if (!cmds.length) {
    cmdList.appendChild(el('div', { className: 'empty-state', textContent: '本会话暂未执行终端命令' }));
  } else {
    for (const c of cmds) {
      cmdList.appendChild(
        el('div', { className: 'list-row' }, [
          el('div', { className: 'row-main' }, [
            el('div', { className: 'row-title-wrap' }, [
              el('span', { className: 'tag-chip', textContent: c.program || 'shell' }),
              el('span', { className: 'row-title', textContent: c.summary }),
            ]),
            el('span', { className: 'row-detail', textContent: `Step ${c.stepIndex}` }),
          ]),
          el('span', { className: 'row-side', textContent: fmtShortClock(c.createdAt) }),
        ]),
      );
    }
  }
}

function render() {
  const snap = state.snap;
  if (!snap) return;

  const hasSessions = Array.isArray(snap.sessions) && snap.sessions.length > 0;
  $('emptyNotice').hidden = hasSessions;

  renderHeaderAndPopovers();
  if (state.tab === 'home') renderHomeTab();
  else if (state.tab === 'context') renderContextTab();
  else if (state.tab === 'usage') renderUsageTab();
  else if (state.tab === 'tools') renderToolsTab();

  if (state.fadeOnRender && !prefersReducedMotion() && typeof Element.prototype.animate === 'function') {
    const panel = $(`panel-${state.tab}`);
    panel?.querySelectorAll(':scope > .shell-section').forEach((sec, idx) => {
      if (idx > 4) return;
      sec._secAnim?.cancel();
      sec._secAnim = sec.animate(
        [
          { opacity: 0.72, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 220, delay: idx * 24, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
      );
    });
  }
  state.fadeOnRender = false;
  state.animatePending = false;
  requestAnimationFrame(updateAllGliders);
}

// ---------- Poll Loop ----------
async function refreshNow(force = false) {
  if (state.fetching) {
    if (force) state.queuedForce = true;
    return;
  }
  state.fetching = true;
  const refreshBtn = $('refreshBtn');
  if (force && refreshBtn) refreshBtn.classList.add('is-spinning');

  try {
    const data = await fetchSnapshot(force);
    if (data.uiVersion) {
      if (!state.bootUiVersion) state.bootUiVersion = data.uiVersion;
      else if (force && data.uiVersion !== state.bootUiVersion) {
        location.reload();
        return;
      }
    }
    state.etag = data.etag || state.etag;
    if (!state.queuedForce) {
      if (!data.unchanged) {
        state.snap = data;
        render();
      } else if (state.animatePending || state.fadeOnRender) {
        if (state.snap) {
          render();
        } else {
          state.animatePending = false;
          state.fadeOnRender = false;
        }
      }
    }
  } catch (err) {
    state.animatePending = false;
    state.fadeOnRender = false;
    const liveDot = $('liveDot');
    const liveBadge = $('liveCountChip');
    if (liveDot) liveDot.classList.add('is-error');
    if (liveBadge) liveBadge.textContent = '连接中断';
    console.error('[context-usage] snapshot error:', err);
  } finally {
    state.fetching = false;
    if (refreshBtn) refreshBtn.classList.remove('is-spinning');
    if (state.queuedForce) {
      state.queuedForce = false;
      refreshNow(true);
    }
  }
}

function boot() {
  wirePopovers();
  wireInteractions();
  window.addEventListener('resize', () => requestAnimationFrame(updateAllGliders));

  syncThemeButton(getCurrentTheme());
  $('themeToggleBtn')?.addEventListener('click', toggleTheme);
  $('refreshBtn')?.addEventListener('click', () => refreshNow(true));
  $('jumpActiveBtn')?.addEventListener('click', () => {
    state.selectedTargetId = '';
    state.pinnedTurnSeq = null;
    state.animatePending = true;
    state.fadeOnRender = true;
    switchTab('home');
    refreshNow(true);
  });
  $('dockHomeBtn')?.addEventListener('click', () => {
    if (state.tab !== 'home') {
      switchTab('home');
      return;
    }
    const scroller = document.querySelector('.shell-scroll');
    if (scroller && scroller.scrollTop > 40) {
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    $('dockNavPopover')?.togglePopover?.();
  });

  refreshNow(true);
  setInterval(() => refreshNow(false), POLL_MS);
}

boot();
