// 源码注释的识别，供 check.mjs 和 comment-hook.mjs 共用：各语言的注释语法（langFor）、
// "独立成段的长注释块"和带信号词的注释行，以及一行是不是注释（commentLines、trailingCommentBefore）。
// 找长注释块和信号词时只认独立成行的注释，行尾注释、/*! license 块，以及各语言的 API 文档注释一律跳过：
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
// docstring：行首的三引号字符串是文档，算注释
const PY = { ...HASH, strings: ['"""', "'''"], docstring: true };
// Go 和 Ruby 没有专门的文档注释语法，紧贴在声明前的行注释就是文档
const GO = { ...SLASH, strings: ['`'], docBefore: /^(package|func|type|var|const)\b/ };
const SEMI = { line: [';'], block: false, html: false };
const HASH_SEMI = { line: ['#', ';'], block: false, html: false };
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
  // 不是编程语言、但能写注释的常见格式：这些文件里的长注释也要扫
  proto: SLASH, prisma: SLASH, sol: SLASH, jsonc: SLASH, json5: SLASH,
  graphql: { ...HASH, strings: ['"""'] }, gql: { ...HASH, strings: ['"""'] },
  hcl: { line: ['#', '//'], block: true, html: false },
  ini: HASH_SEMI, cfg: HASH_SEMI, conf: HASH_SEMI, properties: HASH,
  cmake: HASH, mk: HASH, ps1: HASH, jl: HASH, nix: HASH,
  clj: SEMI, cljs: SEMI, cljc: SEMI, el: SEMI, lisp: SEMI, scm: SEMI,
  erl: { line: ['%'], block: false, html: false },
  vue: MARKUP, svelte: MARKUP, astro: MARKUP,
  html: { line: [], block: false, html: true }, htm: { line: [], block: false, html: true },
  xml: { line: [], block: false, html: true },
};
const BASENAMES = { Dockerfile: HASH, Makefile: HASH, Rakefile: RUBY, Gemfile: RUBY, 'CMakeLists.txt': HASH, Jenkinsfile: SLASH, Justfile: HASH, justfile: HASH };

// 规范里注释最多 3 行，超过就该拆
export const MIN_BLOCK_LINES = 4;

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
// 只按分隔符粗略配对：整行是注释的行不参与配对，反斜杠转义下一个字符；
// 跨行字符串外的单行字符串（'…'、"…"）整段跳过，碰到行尾注释就不再看这一行，
// 连续两个以上的单字符分隔符（'```' 这类 Markdown 围栏）不算分隔符，免得把后面整份文件都当成字符串。
function stringLines(lines, lang) {
  const inside = new Set();
  if (!lang.strings) return inside;
  let open = null;
  lines.forEach((l, k) => {
    if (open) inside.add(k);
    else if (commentBody(l.trimStart(), lang.line, k) !== null) return;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '\\') { i++; continue; }
      if (open) {
        if (l.startsWith(open, i)) { i += open.length - 1; open = null; }
        continue;
      }
      if (lang.line.some((p) => l.startsWith(p, i))) break;
      const d = lang.strings.find((x) => l.startsWith(x, i));
      if (d) {
        let j = i;
        if (d.length === 1) while (l[j] === d) j++;
        if (j - i >= 2) { i = j - 1; continue; }
        open = d;
        i += d.length - 1;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < l.length && l[j] !== c) j += l[j] === '\\' ? 2 : 1;
        i = j;
      }
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

// 一份文本只切一次行、只算一次字符串范围和行注释分段，长注释块和信号词共用
function prepare(text, file) {
  const lang = langFor(file);
  if (!lang) return null;
  const lines = text.split(/\r?\n/);
  const str = stringLines(lines, lang);
  return { lang, lines, str, runs: lineRuns(lines, lang, str) };
}

// 返回 [{ start, end, lines, text, kind }]，start/end 为 1 起的行号（相对 text）
export function findCommentBlocks(text, file, minLines = MIN_BLOCK_LINES) {
  const ctx = prepare(text, file);
  return ctx ? blocksOf(ctx, minLines) : [];
}

// 长注释块和带信号词的独立注释行（不含行尾注释）一起找，只分析一遍
export function analyzeComments(text, file) {
  const ctx = prepare(text, file);
  return ctx ? { blocks: blocksOf(ctx, MIN_BLOCK_LINES), signals: signalsOf(ctx) } : { blocks: [], signals: [] };
}

// ---------- 一行是不是注释 ----------
// check.mjs 用来分清旧版文档的路径是写在注释里（写给人看的指针）还是写在可执行的行里（命令参数、字符串、配置值）。
// 按 lang（langFor 的结果）的注释语法认：`--exclude x`、`**/x` 这类行在不拿 `--`、`*` 当注释符的语言里不是注释。
// 扩展名表里没有的文件（.env.example、Caddyfile、各种 ignore 文件）只认独立成行或行尾的 `#`、`//`

const UNKNOWN_LANG = { line: ['#', '//'], block: false, html: false };
const BLOCK_OPEN_RE = /^(?:\{\s*)?(\/\*|<!--)/; // JSX 的 `{/* … */}` 也认
const CLOSE = { '/*': '*/', '<!--': '-->', '"""': '"""', "'''": "'''" };

// 源码每一行是不是注释：独立成行的行注释、块注释和 docstring 的每一行。返回和 lines 等长的布尔数组。
// 块注释、docstring 要找到收尾才算，免得把后面整份文件当成注释；赋值给变量的三引号字符串不是注释，
// 但要整段跳过，否则收尾的那一行三引号会被当成新的开头
export function commentLines(lines, lang) {
  const { line: prefixes, block, html, docstring } = lang || UNKNOWN_LANG;
  const comment = new Array(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].trim();
    if (prefixes.some((p) => t.startsWith(p))) { comment[k] = true; continue; }
    let open = null;
    let at = 0;
    let isComment = true;
    const m = t.match(BLOCK_OPEN_RE);
    if (m && (m[1] === '/*' ? block : html)) {
      open = m[1];
      at = m[0].length;
    } else if (docstring) {
      const q = t.search(/"""|'''/);
      if (q === -1) continue;
      open = t.slice(q, q + 3);
      at = q + 3;
      isComment = /^[rRuUbBfF]{0,2}$/.test(t.slice(0, q));
    } else continue;
    let end = t.indexOf(CLOSE[open], at) !== -1 ? k : -1;
    for (let j = k + 1; end === -1 && j < lines.length; j++) if (lines[j].includes(CLOSE[open])) end = j;
    if (end === -1) continue;
    if (isComment) for (let j = k; j <= end; j++) comment[j] = true;
    k = end;
  }
  return comment;
}

// 一行源码里，位置 at 落在行尾注释里：at 之前有注释符，注释符前面是空白（`https://` 不算），而且不在字符串里。
// 字符串只按引号粗略配对；at 之前有没配上对的引号时当作 at 在字符串里
export function trailingCommentBefore(line, at, lang) {
  const { line: prefixes, block, html } = lang || UNKNOWN_LANG;
  const marks = [...prefixes, ...(block ? ['/*'] : []), ...(html ? ['<!--'] : [])];
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < at && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      if (j >= at) return false;
      i = j;
      continue;
    }
    if ((i === 0 || /\s/.test(line[i - 1])) && marks.some((p) => line.startsWith(p, i))) return true;
  }
  return false;
}

function blocksOf({ lang, lines, str, runs }, minLines) {
  const blocks = [];

  // 1. 连续的独立行注释
  for (const run of runs) {
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

function signalsOf({ lang, lines, str, runs }) {
  const docLines = new Set(runs.filter((r) => r.doc).flatMap((r) => r.items.map((x) => x.k)));
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
