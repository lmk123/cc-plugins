// 找出源码里"独立成段的长注释块"和带信号词的注释行，供 check.mjs 和 comment-hook.mjs 共用。
// 只认独立成行的注释，行尾注释、/*! license 块，以及各语言的 API 文档注释一律跳过：
// JSDoc/TSDoc（/**）、Rust/C#/Swift/Dart 的 /// 和 //!，Go / Ruby 紧贴在声明前的行注释。

import path from 'node:path';

const SLASH = { line: ['//'], block: true, html: false };
const HASH = { line: ['#'], block: false, html: false };
const DASH = { line: ['--'], block: false, html: false };
const MARKUP = { line: ['//'], block: true, html: true };
// strings：能跨行的字符串分隔符，字符串里以 // 或 # 开头的行不是注释
const JS = { ...SLASH, strings: ['`'] };
const TEXT_BLOCK = { ...SLASH, strings: ['"""'] };
const DART = { ...SLASH, strings: ['"""', "'''"] };
const PY = { ...HASH, strings: ['"""', "'''"] };
// Go 和 Ruby 没有专门的文档注释语法，紧贴在声明前的行注释就是文档
const GO = { ...SLASH, strings: ['`'], docBefore: /^(package|func|type|var|const)\b/ };
const RUBY = { ...HASH, docBefore: /^(def|class|module|attr_(reader|writer|accessor))\b|^[A-Z]\w*\s*=[^=]/ };

const LANGS = {
  js: JS, jsx: JS, mjs: JS, cjs: JS, ts: JS, tsx: JS, mts: JS, cts: JS,
  java: TEXT_BLOCK, kt: TEXT_BLOCK, kts: TEXT_BLOCK, scala: TEXT_BLOCK, groovy: TEXT_BLOCK, gradle: SLASH,
  c: SLASH, h: SLASH, cc: SLASH, cpp: SLASH, cxx: SLASH, hpp: SLASH, m: SLASH, mm: SLASH,
  cs: SLASH, go: GO, rs: SLASH, swift: TEXT_BLOCK, dart: DART, php: SLASH, zig: SLASH,
  scss: SLASH, less: SLASH, css: { line: [], block: true, html: false },
  py: PY, rb: RUBY, sh: HASH, bash: HASH, zsh: HASH, fish: HASH, pl: HASH, r: HASH,
  yaml: HASH, yml: HASH, toml: HASH, ex: HASH, exs: HASH, nim: HASH, cr: HASH, tf: HASH,
  sql: DASH, lua: DASH, hs: DASH,
  vue: MARKUP, svelte: MARKUP, astro: MARKUP,
  html: { line: [], block: false, html: true }, htm: { line: [], block: false, html: true },
  xml: { line: [], block: false, html: true },
};
const BASENAMES = { Dockerfile: HASH, Makefile: HASH, Rakefile: RUBY, Gemfile: RUBY };

export const MIN_BLOCK_LINES = 5;

export const SIGNAL_RE = /(为什么|以前|曾经|原本|历史|改成|不要改|注意|坑|性能|快了|基准|价格|旧版|\bwhy\b|\bnote\b|\bhack\b|\bbecause\b|\bpreviously\b|used to|\blegacy\b|\bworkaround\b|\bbenchmark|\bfaster\b|\bslower\b|do not change|don't change|[0-9]+ ?(毫秒|秒|分钟|小时|天|ms|s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|days?)(?![A-Za-z]))/i;

export function langFor(file) {
  const base = path.basename(file);
  if (BASENAMES[base]) return BASENAMES[base];
  const ext = path.extname(file).slice(1).toLowerCase();
  return LANGS[ext] || null;
}

function isLicense(text) {
  return /\b(license|copyright|spdx-license-identifier)\b/i.test(text);
}

function isDirective(body) {
  return /^(eslint|@ts-|prettier-ignore|biome-ignore|istanbul|c8 |type:|noqa|pylint:|mypy:|fmt:|region|endregion|#region|#endregion|-\*-)/i.test(body.trim());
}

// t 是去掉缩进的一行。以某个注释前缀开头、且是普通注释时返回前缀后的正文，否则返回 null。
// 第一行的 shebang 不是注释；/// 和 //! 是文档注释。
function commentBody(t, prefixes, idx) {
  for (const p of prefixes) {
    if (!t.startsWith(p)) continue;
    if (p === '#' && idx === 0 && t.startsWith('#!')) return null;
    if (p === '//' && /^\/\/[/!]/.test(t)) return null;
    return t.slice(p.length);
  }
  return null;
}

// 落在跨行字符串（Python 三引号、JS 模板字符串、Go 原始字符串等）里的行下标。
// 只按分隔符粗略配对：整行是注释的行不参与配对，反斜杠转义下一个字符。
function stringLines(lines, lang) {
  const inside = new Set();
  if (!lang.strings) return inside;
  let open = null;
  lines.forEach((l, k) => {
    if (open) inside.add(k);
    else if (commentBody(l.trimStart(), lang.line, k) !== null) return;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '\\') { i++; continue; }
      const d = open ? (l.startsWith(open, i) ? open : null) : lang.strings.find((x) => l.startsWith(x, i));
      if (!d) continue;
      open = open ? null : d;
      i += d.length - 1;
    }
  });
  return inside;
}

// 连续的独立行注释，允许中间夹一个空行。返回 [{ items: [{ k, body }], doc }]，k 为 0 起的行下标。
// 紧贴声明（docBefore）的那一段（不跨空行）单独成一段，标为 doc。str 为 stringLines 的结果。
function lineRuns(lines, lang, str) {
  const runs = [];
  if (!lang.line.length) return runs;
  const body = (k) => (str.has(k) ? null : commentBody(lines[k].trimStart(), lang.line, k));
  let i = 0;
  while (i < lines.length) {
    if (body(i) === null) { i++; continue; }
    const items = [];
    let seg = i; // 最后一段（不跨空行）的起点
    let j = i;
    while (j < lines.length) {
      const b = body(j);
      if (b !== null) { items.push({ k: j, body: b }); j++; }
      else if (lines[j].trim() === '' && j + 1 < lines.length && body(j + 1) !== null) { j++; seg = j; }
      else break;
    }
    const end = items[items.length - 1].k;
    const next = lines[end + 1];
    const docFrom = lang.docBefore && next !== undefined && lang.docBefore.test(next.trimStart()) ? seg : end + 1;
    const plain = items.filter((x) => x.k < docFrom);
    const doc = items.filter((x) => x.k >= docFrom);
    if (plain.length) runs.push({ items: plain, doc: false });
    if (doc.length) runs.push({ items: doc, doc: true });
    i = end + 1;
  }
  return runs;
}

// 返回 [{ start, end, lines, text, kind }]，start/end 为 1 起的行号（相对 text）
export function findCommentBlocks(text, file, minLines = MIN_BLOCK_LINES) {
  const lang = langFor(file);
  if (!lang) return [];
  const lines = text.split(/\r?\n/);
  const str = stringLines(lines, lang);
  const blocks = [];

  // 1. 连续的独立行注释
  for (const run of lineRuns(lines, lang, str)) {
    if (run.doc) continue;
    const bodies = run.items.map((x) => x.body);
    const start = run.items[0].k;
    const end = run.items[run.items.length - 1].k;
    const textBody = bodies.join('\n');
    if (bodies.length >= minLines && !bodies.every(isDirective) && !(start <= 2 && isLicense(textBody))) {
      blocks.push({ start: start + 1, end: end + 1, lines: bodies.length, text: textBody, kind: 'line' });
    }
  }

  // 2. /* */ 块注释和 <!-- --> 注释：必须从行首开始（前面只有空白）。
  // 行数只算正文：单独占一行的开头 /* 和结尾 */ 不算，和行注释的口径一致
  const scan = (open, close, kind, skip) => {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trimStart();
      if (str.has(i) || !t.startsWith(open)) continue;
      if (skip && skip(t)) continue;
      let j = i;
      let closed = lines[i].indexOf(close, lines[i].indexOf(open) + open.length) !== -1;
      while (!closed && j + 1 < lines.length) {
        j++;
        closed = lines[j].includes(close);
      }
      let count = j - i + 1;
      if (t.trim() === open) count--;
      if (j > i && lines[j].trim() === close) count--;
      const body = lines.slice(i, j + 1).join('\n');
      if (closed && count >= minLines && !(i <= 2 && isLicense(body)) && !isLicense(body.split('\n').slice(0, 3).join('\n'))) {
        blocks.push({ start: i + 1, end: j + 1, lines: count, text: body, kind });
      }
      i = j;
    }
  };
  if (lang.block) scan('/*', '*/', 'block', (t) => t.startsWith('/**') || t.startsWith('/*!'));
  if (lang.html) scan('<!--', '-->', 'html', null);

  return blocks.sort((a, b) => a.start - b.start);
}

// 带信号词的独立注释行（不含行尾注释），返回 [{ line, text }]
export function findSignalComments(text, file) {
  const lang = langFor(file);
  if (!lang) return [];
  const lines = text.split(/\r?\n/);
  const str = stringLines(lines, lang);
  const docLines = new Set(lineRuns(lines, lang, str).filter((r) => r.doc).flatMap((r) => r.items.map((x) => x.k)));
  const prefixes = [...lang.line];
  if (lang.block) prefixes.push('/*');
  if (lang.html) prefixes.push('<!--');
  const out = [];
  const hit = (idx, t, body) => {
    if (SIGNAL_RE.test(body)) out.push({ line: idx + 1, text: t.slice(0, 120) });
  };
  // 跟踪是否在多行注释里：JSDoc（/**）和 /*! 整块跳过；`* ` 开头的行只在块注释内才算注释
  let block = null; // null | 'doc' | 'plain' | 'html'
  lines.forEach((l, idx) => {
    const t = l.trimStart();
    if (str.has(idx)) return;
    if (block === 'html') {
      if (t.includes('-->')) block = null;
      hit(idx, t, t);
      return;
    }
    if (block) {
      const inDoc = block === 'doc';
      if (t.includes('*/')) block = null;
      if (inDoc) return;
      if (/^\*(\s|$)/.test(t) || !t.startsWith('*')) hit(idx, t, t.replace(/^\*/, ''));
      return;
    }
    if (lang.block && t.startsWith('/*')) {
      const isDoc = t.startsWith('/**') || t.startsWith('/*!');
      if (!t.includes('*/', 2)) block = isDoc ? 'doc' : 'plain';
      if (isDoc) return;
    }
    if (lang.html && t.startsWith('<!--') && !t.includes('-->', 4)) block = 'html';
    if (docLines.has(idx)) return;
    const body = commentBody(t, prefixes, idx);
    if (body !== null) hit(idx, t, body);
  });
  return out;
}
