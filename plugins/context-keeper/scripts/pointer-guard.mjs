#!/usr/bin/env node
// PreToolUse hook：要改的代码附近有指向 .context/ 文档的注释指针、而本会话还没读过那份文档时，拦下这次编辑，
// 把指针原文给 Claude 看，让它按指针写的触发条件决定先读文档还是直接重试。同一会话里每份文档只拦一次。
// 设环境变量 CONTEXT_KEEPER_POINTER_HOOK=0 可关闭。
//
// "附近"：改动范围内的行；从改动处往上按缩进找到的外层声明行（函数、类……）和紧贴在它们上方的注释；文件头注释。
// 只认能写注释的源码文件；rule、CLAUDE.md 里的指针不管。出任何意外都放行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { langFor } from './lib/comments.mjs';
import { pointersIn, resolvePointer } from './lib/pointers.mjs';

if (process.env.CONTEXT_KEEPER_POINTER_HOOK === '0') process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const tool = input.tool_name;
const ti = input.tool_input || {};
if (!['Edit', 'MultiEdit', 'Write'].includes(tool) || !ti.file_path) process.exit(0);
const file = path.resolve(input.cwd || process.cwd(), ti.file_path);
if (!langFor(file)) process.exit(0);

// 项目根取离文件最近的 .git（worktree 里是 .git 文件）。找不到就不管：指针是仓库根起的路径，没有根就解析不了
let root = null;
for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, '.git'))) { root = dir; break; }
  if (path.dirname(dir) === dir) break;
}
if (!root) process.exit(0);
if (/(^|[\\/])(\.context|\.claude|node_modules)([\\/])/.test(path.relative(root, file))) process.exit(0);

const lf = (s) => s.replace(/\r\n?/g, '\n');
let text;
try {
  if (fs.statSync(file).size > 1 << 20) process.exit(0);
  text = lf(fs.readFileSync(file, 'utf8'));
} catch {
  process.exit(0); // 新建文件：还没有指针
}
const lines = text.split('\n');

// ---------- 改动范围（0 起的行下标，闭区间） ----------

const lineAt = (offset) => {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
};
const ranges = [];
if (tool === 'Write') {
  ranges.push([0, lines.length - 1]);
} else {
  const edits = tool === 'MultiEdit' ? ti.edits || [] : [ti];
  for (const e of edits) {
    const old = lf(e.old_string || '');
    if (!old) continue;
    // MultiEdit 的后几处是在前几处改完之后的文本上找的，这里一律在原文里找，找不到就跳过
    for (let at = text.indexOf(old); at !== -1; at = e.replace_all ? text.indexOf(old, at + old.length) : -1) {
      const start = lineAt(at);
      ranges.push([start, start + old.split('\n').length - 1]);
    }
  }
}
if (!ranges.length) process.exit(0);

// ---------- 附近的行 ----------

const COMMENT_RE = /^(\/\/|\/\*|\*|#|--|<!--|;|%|'''|""")/;
const isComment = (k) => COMMENT_RE.test(lines[k].trimStart());
const blank = (k) => !lines[k].trim();
const indent = (k) => lines[k].match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

const near = new Set();
// 紧贴在第 k 行上方的注释（中间可以隔着装饰器 / 注解）
const leading = (k) => {
  for (let j = k - 1; j >= 0; j--) {
    if (isComment(j)) near.add(j);
    else if (!/^\s*@/.test(lines[j])) break;
  }
};
for (const [s, e] of ranges) {
  for (let k = s; k <= e && k < lines.length; k++) near.add(k);
  let k = s;
  while (k < lines.length && blank(k)) k++;
  if (k >= lines.length) continue;
  leading(k);
  // 往上找缩进更小的行，就是外层的声明。`) {` 这种多行签名的收尾行，再往上找到同缩进的签名开头
  let cur = indent(k);
  for (let j = k - 1; j >= 0 && cur > 0; j--) {
    if (blank(j) || isComment(j) || indent(j) >= cur) continue;
    cur = indent(j);
    while (/^[)\]}>]/.test(lines[j].trimStart()) && j > 0) {
      let p = j - 1;
      while (p > 0 && (blank(p) || indent(p) > cur)) p--;
      if (indent(p) !== cur || blank(p)) break;
      j = p;
    }
    near.add(j);
    leading(j);
  }
}
// 文件头注释：整个文件的约定写在这里（跳过 shebang 和空行）
for (let k = 0; k < lines.length; k++) {
  if (blank(k) || (k === 0 && lines[k].startsWith('#!'))) continue;
  if (!isComment(k)) break;
  near.add(k);
}

// ---------- 指针 ----------

const exists = (p) => {
  try { return fs.statSync(path.join(root, p)).isFile(); } catch { return false; }
};
const pointers = new Map(); // 仓库根起的文档路径 -> [行下标]
for (const k of [...near].sort((a, b) => a - b)) {
  for (const raw of pointersIn(lines[k])) {
    const p = resolvePointer(raw, exists);
    if (!p) continue; // 失效指针交给 check.mjs
    if (!pointers.has(p)) pointers.set(p, []);
    pointers.get(p).push(k);
  }
}
if (!pointers.size) process.exit(0);

// ---------- 本会话读过哪些 ----------

// 读过：Read / Edit / Write 过这个文件，或 Bash 命令里出现过它的 `.context/…` 部分（cd 进子目录后 cat 时没有仓库根起的前缀）。
// 压缩之后原文已经不在 context 里，压缩点之前的不算
const tailOf = (p) => p.slice(p.lastIndexOf('.context/'));
const unread = new Set(pointers.keys());
const seen = new Set();
try {
  const transcript = input.transcript_path ? fs.readFileSync(input.transcript_path, 'utf8') : '';
  const tails = [...unread].map(tailOf);
  for (const l of transcript.split('\n')) {
    if (l.includes('"compact_boundary"')) {
      try { if (JSON.parse(l).subtype === 'compact_boundary') seen.clear(); } catch {}
      continue;
    }
    if (!tails.some((t) => l.includes(t))) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const content = o.type === 'assistant' && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) {
      if (c.type !== 'tool_use' || !c.input) continue;
      for (const p of unread) {
        const fp = typeof c.input.file_path === 'string' ? c.input.file_path.split(path.sep).join('/') : '';
        if (fp && (fp === p || fp.endsWith(`/${p}`))) seen.add(p);
        else if (c.name === 'Bash' && typeof c.input.command === 'string' && c.input.command.includes(tailOf(p))) seen.add(p);
      }
    }
  }
} catch {
  process.exit(0);
}
for (const p of seen) unread.delete(p);
if (!unread.size) process.exit(0);

// ---------- 每份文档只拦一次 ----------

const sid = String(input.session_id || input.transcript_path || 'unknown').replace(/[^\w-]/g, '_').slice(0, 120);
const stateFile = path.join(os.tmpdir(), 'context-keeper', `${sid}.json`);
let warned = [];
try { warned = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
const key = (p) => crypto.createHash('sha1').update(path.join(root, p)).digest('hex').slice(0, 16);
const todo = [...unread].filter((p) => !warned.includes(key(p)));
if (!todo.length) process.exit(0);
try {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify([...warned, ...todo.map(key)]));
} catch {
  process.exit(0); // 记不住拦过哪些就不拦，免得反复拦
}

const rel = path.relative(root, file).split(path.sep).join('/');
const shown = todo.flatMap((p) => pointers.get(p).map((k) => `- ${rel}:${k + 1}  ${lines[k].trim().slice(0, 200)}`));
const msg = [
  '[context-keeper] 这次要改的代码附近有指向项目文档的指针，本会话还没读过：',
  ...[...new Set(shown)].slice(0, 20),
  '按指针写的"什么时候读"判断：这次改动在条件内，先读文档再重新提交这次编辑；不在条件内，直接重新提交即可，同一份文档本会话不会再拦。',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
}));
