#!/usr/bin/env node
// PreToolUse hook：要改的代码附近有指向 .context/ 文档的注释指针、而本会话还没读过那份文档时，拦下这次编辑，
// 把指针原文给 Claude 看，让它按指针写的触发条件决定先读文档还是直接重试。同一会话里每处指针只拦一次，文档读过之后不再拦。
// 主会话和每个子代理各算各的：子代理的 context 是独立的，主会话读过、被拦过都不代表它知道。
// 设环境变量 CONTEXT_KEEPER_POINTER_HOOK=0 可关闭。
//
// "附近"：改动范围内的行；从改动处往上按缩进找到的外层声明行（函数、类……）和紧贴在它们上方的注释；
// 文件头注释（后面是空行或 import 的那几段，紧贴声明的不算）。
// 只管非 Markdown 文件里的指针（Markdown 里的路径多半是示例）；rule、CLAUDE.md 里的指针不管。出任何意外都放行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
// 不按扩展名表筛：表里没有的格式（.proto、.graphql……）照样能写注释指针。没有指针的文件下面自然放行
if (/\.(md|mdx|markdown)$/i.test(file)) process.exit(0);

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
// 文件头注释：整个文件的约定写在这里（跳过 shebang 和空行）。一段注释后面是空行、import 之类或文件结尾才算文件头；
// 紧贴着一个声明的那一段是那个声明的注释，不算：否则指针写在第一个常量上方的文件，改哪里都会被它拦
const IMPORT_RE = /^(?:(?:import|from|package|use|using|require|include|namespace|module|mod|extern|source)\b|set\s+-|['"]use |@(?:import|use|charset|forward)\b|(?:const|let|var)\s.*=\s*require\()/;
let run = [];
let h = 0;
for (; h < lines.length; h++) {
  if (h === 0 && lines[h].startsWith('#!')) continue;
  if (blank(h)) { for (const x of run) near.add(x); run = []; continue; }
  if (!isComment(h)) break;
  run.push(h);
}
if (h >= lines.length || IMPORT_RE.test(lines[h].trimStart())) for (const x of run) near.add(x);

// ---------- 指针 ----------

const exists = (p) => {
  try { return fs.statSync(path.join(root, p)).isFile(); } catch { return false; }
};
// 一处指针 = 一份文档 + 指到它的那一行。同一份文档可以被几处指到、各写各的触发条件，所以按处记，不按文档记
const hits = []; // { doc: 仓库根起的文档路径, k: 行下标 }
for (const k of [...near].sort((a, b) => a - b)) {
  for (const raw of pointersIn(lines[k])) {
    const doc = resolvePointer(raw, exists);
    if (doc) hits.push({ doc, k }); // 失效指针交给 check.mjs
  }
}
if (!hits.length) process.exit(0);

// ---------- 每处指针只拦一次 ----------

// 先查拦过没有，再去读转录：拦过的指针不用为它把整份转录读一遍。
// 按指针那一行的文本记，不按行号：文件上方增删行之后还认得出是同一处
const rel = path.relative(root, file).split(path.sep).join('/');
const safe = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 120);
const sid = safe(input.session_id || input.transcript_path || 'unknown');
// 子代理里 session_id、transcript_path 都是主会话的，靠 agent_id 区分：状态各记各的
const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
const stateFile = path.join(os.tmpdir(), 'context-keeper', `${sid}${agentId ? `.${safe(agentId)}` : ''}.json`);
// { 指针的 key: 拦下它的时间戳 }。0.5.1 及以前存的是 key 数组，时间按 0 算
let warned = {};
try {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (Array.isArray(saved)) for (const x of saved) warned[x] = 0;
  else if (saved && typeof saved === 'object') warned = saved;
} catch {}
const key = ({ doc, k }) => crypto.createHash('sha1').update([root, rel, doc, lines[k].trim()].join('\n')).digest('hex').slice(0, 16);
// 同一条消息里对同一处的几个 Edit 是挨个触发 hook 的：第一个被拦时 Claude 还没看到拦截消息，后面几个不能直接放行。
// 所以拦下之后的一小段时间内继续拦；Claude 看到消息后再提交，早就过了这段时间
const REPEAT_MS = 3000;
const now = Date.now();
const settled = (x) => typeof warned[key(x)] === 'number' && now - warned[key(x)] > REPEAT_MS;
let todo = hits.filter((x) => !settled(x));
if (!todo.length) process.exit(0);

// ---------- 本会话读过哪些 ----------

// 读过：Read / Edit / Write 过这个文件，或 Bash 命令里出现过它的 `.context/…` 部分（cd 进子目录后 cat 时没有仓库根起的前缀）。
// 压缩之后原文已经不在 context 里，压缩点之前的不算。文档读过之后，指向它的每一处指针都不再拦
const tailOf = (p) => p.slice(p.lastIndexOf('.context/'));
const unread = new Set(todo.map((x) => x.doc));
const seen = new Set();
// 子代理的转录在 <主转录去掉 .jsonl>/subagents/ 下（可能再隔一层子目录），文件名 agent-<agent_id>.jsonl。
// 找不到就当没读过：最多多拦一次
function agentTranscript(main, id) {
  const want = `agent-${id}.jsonl`;
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of list) if (e.isFile() && e.name === want) return path.join(dir, e.name);
    if (depth > 0) for (const e of list) {
      const found = e.isDirectory() ? walk(path.join(dir, e.name), depth - 1) : null;
      if (found) return found;
    }
    return null;
  };
  return walk(path.join(main.replace(/\.jsonl$/, ''), 'subagents'), 2);
}
try {
  const transcriptPath = input.transcript_path && agentId ? agentTranscript(input.transcript_path, agentId) : input.transcript_path;
  const transcript = transcriptPath ? fs.readFileSync(transcriptPath, 'utf8') : '';
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
todo = todo.filter((x) => !seen.has(x.doc));
if (!todo.length) process.exit(0);
try {
  // 已经记过时间的不刷新：窗口从第一次拦下算起，重试不会被一直顺延
  for (const x of todo) if (typeof warned[key(x)] !== 'number') warned[key(x)] = now;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(warned));
} catch {
  process.exit(0); // 记不住拦过哪些就不拦，免得反复拦
}

// 指针折行时，重点和"什么时候读"可能在路径的上面几行、括号里的说明可能折到下一行：
// 把指针所在的那段连续注释一起给出来（往上最多 3 行、往下 1 行），重叠的合并
const clip = (i) => lines[i].trim().slice(0, 200);
const spans = [];
for (const { k } of todo) {
  let a = k;
  let b = k;
  if (isComment(k)) {
    while (a > 0 && k - a < 3 && isComment(a - 1) && !(a === 1 && lines[0].startsWith('#!'))) a--;
    if (b + 1 < lines.length && isComment(b + 1)) b++;
  }
  const last = spans[spans.length - 1];
  if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
  else spans.push([a, b]);
}
const shown = spans.slice(0, 20).map(([a, b]) => {
  if (a === b) return `- ${rel}:${a + 1}  ${clip(a)}`;
  const body = [];
  for (let i = a; i <= b; i++) body.push(`    ${clip(i)}`);
  return `- ${rel}:${a + 1}-${b + 1}\n${body.join('\n')}`;
});
const msg = [
  `[context-keeper] 这次要改的代码附近有指向项目文档的指针，${agentId ? '这个子代理' : '本会话'}还没读过：`,
  ...shown,
  '按指针写的"什么时候读"判断：这次改动在条件内，先读文档再重新提交这次编辑；不在条件内，直接重新提交即可，同一处指针本会话不会再拦。',
  '改完之后，指针里的重点或文档里的说法不再成立的（比如改了指针提到的数值），同一次改动里一并更新。',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
}));
