// 找出源码里"独立成段的长注释块"和带信号词的注释行，供 check.mjs 和 comment-hook.mjs 共用。
// 只认独立成行的注释，行尾注释、JSDoc/TSDoc、/*! license 块、Rust/C# 的 /// 文档注释一律跳过。

import path from 'node:path';

const SLASH = { line: ['//'], block: true, html: false };
const HASH = { line: ['#'], block: false, html: false };
const DASH = { line: ['--'], block: false, html: false };
const MARKUP = { line: ['//'], block: true, html: true };

const LANGS = {
  js: SLASH, jsx: SLASH, mjs: SLASH, cjs: SLASH, ts: SLASH, tsx: SLASH, mts: SLASH, cts: SLASH,
  java: SLASH, kt: SLASH, kts: SLASH, scala: SLASH, groovy: SLASH, gradle: SLASH,
  c: SLASH, h: SLASH, cc: SLASH, cpp: SLASH, cxx: SLASH, hpp: SLASH, m: SLASH, mm: SLASH,
  cs: SLASH, go: SLASH, rs: SLASH, swift: SLASH, dart: SLASH, php: SLASH, zig: SLASH,
  scss: SLASH, less: SLASH, css: { line: [], block: true, html: false },
  py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, fish: HASH, pl: HASH, r: HASH,
  yaml: HASH, yml: HASH, toml: HASH, ex: HASH, exs: HASH, nim: HASH, cr: HASH, tf: HASH,
  sql: DASH, lua: DASH, hs: DASH,
  vue: MARKUP, svelte: MARKUP, astro: MARKUP,
  html: { line: [], block: false, html: true }, htm: { line: [], block: false, html: true },
  xml: { line: [], block: false, html: true },
};
const BASENAMES = { Dockerfile: HASH, Makefile: HASH, Rakefile: HASH, Gemfile: HASH };

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

// 返回 [{ start, end, lines, text, kind }]，start/end 为 1 起的行号（相对 text）
export function findCommentBlocks(text, file, minLines = MIN_BLOCK_LINES) {
  const lang = langFor(file);
  if (!lang) return [];
  const lines = text.split(/\r?\n/);
  const blocks = [];

  // 1. 连续的独立行注释，允许中间夹一个空行
  if (lang.line.length) {
    const prefixes = lang.line;
    const lineComment = (l) => {
      const t = l.trimStart();
      for (const p of prefixes) {
        if (!t.startsWith(p)) continue;
        if (p === '#' && /^#(!|\[|include|define|pragma|if|endif|else|elif|undef|import)/.test(t)) return null;
        if (p === '//' && /^\/\/[/!]/.test(t)) return null; // /// 和 //! 是文档注释
        return t.slice(p.length);
      }
      return null;
    };
    let i = 0;
    while (i < lines.length) {
      if (lineComment(lines[i]) === null) { i++; continue; }
      const start = i;
      let end = i;
      let count = 0;
      const bodies = [];
      let j = i;
      while (j < lines.length) {
        const body = lineComment(lines[j]);
        if (body !== null) {
          bodies.push(body);
          count++;
          end = j;
          j++;
        } else if (lines[j].trim() === '' && j + 1 < lines.length && lineComment(lines[j + 1]) !== null) {
          j++;
        } else break;
      }
      const textBody = bodies.join('\n');
      if (count >= minLines && !bodies.every(isDirective) && !(start <= 2 && isLicense(textBody))) {
        blocks.push({ start: start + 1, end: end + 1, lines: count, text: textBody, kind: 'line' });
      }
      i = end + 1;
    }
  }

  // 2. /* */ 块注释和 <!-- --> 注释：必须从行首开始（前面只有空白）
  const scan = (open, close, kind, skip) => {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trimStart();
      if (!t.startsWith(open)) continue;
      if (skip && skip(t)) continue;
      let j = i;
      let closed = lines[i].indexOf(close, lines[i].indexOf(open) + open.length) !== -1;
      while (!closed && j + 1 < lines.length) {
        j++;
        closed = lines[j].includes(close);
      }
      const count = j - i + 1;
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
  const prefixes = [...lang.line];
  if (lang.block) prefixes.push('/*', '*');
  if (lang.html) prefixes.push('<!--');
  const out = [];
  text.split(/\r?\n/).forEach((l, idx) => {
    const t = l.trimStart();
    const p = prefixes.find((x) => t.startsWith(x));
    if (!p) return;
    if (p === '#' && /^#(!|\[|include|define|pragma)/.test(t)) return;
    if (p === '*' && !/^\*(\s|$)/.test(t)) return;
    const body = t.slice(p.length);
    if (SIGNAL_RE.test(body)) out.push({ line: idx + 1, text: t.slice(0, 120) });
  });
  return out;
}
