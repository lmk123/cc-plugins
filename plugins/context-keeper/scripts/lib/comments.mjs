// 源码注释的识别，供 check.mjs 和 comment-hook.mjs 共用：各语言的注释语法（langFor）、
// 逐行扫描出注释和跨行字符串的位置（scanSource），以及在它上面找"独立成段的长注释块"和带信号词的注释行。
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

// ---------- 逐行扫描 ----------
// 一份源码只扫一遍，哪里是注释、哪里是字符串都从这里取：长注释块、信号词，以及 check.mjs 判断旧版文档的路径
// 是写在注释里（写给人看的指针）还是写在可执行的行里（命令参数、字符串、配置值），用的是同一份结果。
//   spans[k]  第 k 行里的注释区间 [[from, to), …]：行注释（独立成行或行尾）、块注释、HTML 注释、docstring
//   str       开头落在跨行字符串（Python 三引号、JS 模板字符串、Go 原始字符串等）里的行下标
//   blocks    收了尾的块注释和 HTML 注释 [{ mark, start, end, col }]：start、end 是 0 起的行下标，col 是开头在 start 行里的位置
// 按 lang（langFor 的结果）的注释语法认：`--exclude x`、`**/x` 这类行在不拿 `--`、`*` 当注释符的语言里不是注释。
// 扩展名表里没有的文件（.env.example、Caddyfile、各种 ignore 文件）只认 `#` 和 `//`。
// 只按分隔符粗略配对：
// - 反斜杠转义下一个字符。单行字符串（'…'、"…"、`…`）整段跳过；这一行里配不上对的引号当作撇号
//   （`Don't`、Rust 的 `<'a>`），接着往后看
// - 注释符前面要是空白（`https://`、`a#b` 不算）；`//`、`/*` 紧贴在语句结尾后面（`x;// …`、`}/* … */`、
//   JSX 的 `{/* … */}`）的也认，`<!--` 前面是什么都认。前面不是空白的行注释符不算注释，
//   但这一行后面不再开跨行字符串：多半还是注释，里面的反引号不是字符串的开头
// - 块注释、docstring 要找到收尾才算注释，免得把后面整份文件当成注释；没收尾的跨行字符串照样算到文件末尾
// - 连续两个以上的单字符分隔符（'```' 这类 Markdown 围栏）不算分隔符，免得把后面整份文件都当成字符串
// - 行首的三引号字符串（前面最多有 r、b、f 这类前缀）是 docstring，算注释；赋值给变量的不算

const UNKNOWN_LANG = { line: ['#', '//'], block: false, html: false };
const CLOSE = { '/*': '*/', '<!--': '-->' };
const DOCSTRING_PREFIX_RE = /^[rRuUbBfF]{0,2}$/;
const afterBlank = (l, i, mark) => i === 0 || /\s/.test(l[i - 1]) || mark === '<!--' || (mark[0] === '/' && /[;,{})]/.test(l[i - 1]));

export function scanSource(lines, lang) {
  const { line: prefixes, block, html, strings = [], docstring } = lang || UNKNOWN_LANG;
  const opens = [...(block ? ['/*'] : []), ...(html ? ['<!--'] : [])];
  const spans = lines.map(() => []);
  const str = new Set();
  const blocks = [];
  // 位置 (k, i) 后面还有没有 close。每种 close 最后出现在哪一行只找一次
  const lastLine = {};
  const closesAfter = (close, k, i) => {
    if (lines[k].indexOf(close, i) !== -1) return true;
    if (lastLine[close] === undefined) {
      let n = lines.length - 1;
      while (n >= 0 && !lines[n].includes(close)) n--;
      lastLine[close] = n;
    }
    return lastLine[close] > k;
  };
  let open = null; // 还没收尾的跨行结构：{ close, string, comment, block }
  lines.forEach((l, k) => {
    let from = 0; // 当前注释区间在这一行的起点：上一行延续下来的从 0 起
    let quiet = false; // 碰到过前面不是空白的行注释符
    if (open && open.string) str.add(k);
    for (let i = 0; i < l.length; i++) {
      if (open) {
        if (open.string && l[i] === '\\') { i++; continue; }
        if (!l.startsWith(open.close, i)) continue;
        i += open.close.length - 1;
        if (open.comment) spans[k].push([from, i + 1]);
        if (open.block) open.block.end = k;
        open = null;
        continue;
      }
      const c = l[i];
      if (c === '\\') { i++; continue; }
      const p = prefixes.find((x) => l.startsWith(x, i));
      if (p) {
        if (afterBlank(l, i, p)) { spans[k].push([i, l.length]); return; }
        quiet = true;
      }
      const o = opens.find((x) => l.startsWith(x, i));
      if (o && afterBlank(l, i, o) && closesAfter(CLOSE[o], k, i + o.length)) {
        open = { close: CLOSE[o], comment: true, block: { mark: o, start: k, end: k, col: i } };
        blocks.push(open.block);
        from = i;
        i += o.length - 1;
        continue;
      }
      const d = quiet ? undefined : strings.find((x) => l.startsWith(x, i));
      if (d) {
        let j = i;
        if (d.length === 1) while (l[j] === d) j++;
        if (j - i >= 2) { i = j - 1; continue; }
        const doc = !!docstring && d.length === 3 && DOCSTRING_PREFIX_RE.test(l.slice(0, i).trim()) && closesAfter(d, k, i + d.length);
        open = { close: d, string: true, comment: doc };
        from = i;
        i += d.length - 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < l.length && l[j] !== c) j += l[j] === '\\' ? 2 : 1;
        if (j < l.length) i = j;
      }
    }
    if (open && open.comment) spans[k].push([from, l.length]);
  });
  return { spans, str, blocks };
}

// 独立成行的块注释（开头前面只有空白），带上是不是文档注释：JSDoc（/**）和 /*! license 块
const standaloneBlocks = (blocks, lines) => blocks
  .filter((b) => b.col === lines[b.start].search(/\S/))
  .map((b) => ({ ...b, doc: b.mark === '/*' && /^\/\*[*!]/.test(lines[b.start].slice(b.col)) }));

// 连续的独立行注释，允许中间夹一个空行。返回 [{ items: [{ k, body }], doc }]，k 为 0 起的行下标。
// 紧贴声明（docBefore）的那一段（不跨空行）单独成一段，标为 doc。str 为 scanSource 的结果。
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

// 一份文本只切一次行、只扫一遍、只算一次行注释分段，长注释块和信号词共用
function prepare(text, file) {
  const lang = langFor(file);
  if (!lang) return null;
  const lines = text.split(/\r?\n/);
  const { str, blocks } = scanSource(lines, lang);
  return { lang, lines, str, blocks: standaloneBlocks(blocks, lines), runs: lineRuns(lines, lang, str) };
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

function blocksOf({ lines, blocks, runs }, minLines) {
  const out = [];

  // 1. 连续的独立行注释
  for (const run of runs) {
    if (run.doc) continue;
    const bodies = run.items.map((x) => x.body);
    const start = run.items[0].k;
    const end = run.items[run.items.length - 1].k;
    const textBody = bodies.join('\n');
    if (bodies.length >= minLines && !bodies.every(isDirective) && !(start <= 2 && isLicense(textBody))) {
      out.push({ start: start + 1, end: end + 1, lines: bodies.length, text: textBody, kind: 'line' });
    }
  }

  // 2. /* */ 块注释和 <!-- --> 注释：只要独立成行的，JSDoc 和 /*! 不算。
  // 行数只算正文：单独占一行的开头 /* 和结尾 */ 不算，和行注释的口径一致
  for (const b of blocks) {
    if (b.doc) continue;
    let count = b.end - b.start + 1;
    if (lines[b.start].trim() === b.mark) count--;
    if (b.end > b.start && lines[b.end].trim() === CLOSE[b.mark]) count--;
    const body = lines.slice(b.start, b.end + 1).join('\n');
    if (count >= minLines && !(b.start <= 2 && isLicense(body)) && !isLicense(body.split('\n').slice(0, 3).join('\n'))) {
      out.push({ start: b.start + 1, end: b.end + 1, lines: count, text: body, kind: b.mark === '/*' ? 'block' : 'html' });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

function signalsOf({ lang, lines, str, blocks, runs }) {
  const docLines = new Set(runs.filter((r) => r.doc).flatMap((r) => r.items.map((x) => x.k)));
  const prefixes = [...lang.line];
  if (lang.block) prefixes.push('/*');
  if (lang.html) prefixes.push('<!--');
  // 行 -> 所在的独立块注释。开头那一行不在里面，按下面的注释前缀认
  const inBlock = new Map();
  for (const b of blocks) for (let k = b.start + 1; k <= b.end; k++) inBlock.set(k, b);
  const out = [];
  const hit = (idx, t, body) => {
    if (SIGNAL_RE.test(body)) out.push({ line: idx + 1, text: t.slice(0, 120) });
  };
  lines.forEach((l, idx) => {
    const t = l.trimStart();
    if (str.has(idx)) return;
    const b = inBlock.get(idx);
    if (b) {
      // JSDoc（/**）和 /*! 整块跳过；`* ` 开头的行去掉星号再看
      if (b.mark === '<!--') hit(idx, t, t);
      else if (!b.doc && (/^\*(\s|$)/.test(t) || !t.startsWith('*'))) hit(idx, t, t.replace(/^\*/, ''));
      return;
    }
    if (lang.block && (t.startsWith('/**') || t.startsWith('/*!'))) return;
    if (docLines.has(idx)) return;
    const body = commentBody(t, prefixes, idx);
    if (body !== null) hit(idx, t, body);
  });
  return out;
}
