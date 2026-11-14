#!/usr/bin/env node
// PostToolUse hook：Write / Edit / MultiEdit 新写入了长注释块时，提醒 Claude 注释只留一句重点，扩展内容进 context-docs/、原处留指针。
// 只提醒，不阻断。设环境变量 CONTEXT_KEEPER_COMMENT_HOOK=0 可关闭。
//
// 做法：对写入后的整个文件找注释块，块里至少一半的行是这次新写的才提醒。
// "新写的行"优先取 tool_response.structuredPatch 里的 `+` 行；改个别词、整段挪位置或改缩进都不算新写。

import fs from 'node:fs';
import path from 'node:path';
import { findCommentBlocks } from './lib/comments.mjs';
import { NOT_CODE_DIR_RE } from './lib/pointers.mjs';

if (process.env.CONTEXT_KEEPER_COMMENT_HOOK === '0') process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const tool = input.tool_name;
const ti = input.tool_input || {};
const resp = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
const file = ti.file_path;
if (!file || !['Write', 'Edit', 'MultiEdit'].includes(tool)) process.exit(0);
// 跳过规则只看项目内的相对路径：worktree 在 <repo>/.claude/worktrees/<name>/ 下，拿绝对路径去比会把整个 worktree 都跳过。
// 项目根取离文件最近的 .git（worktree 里是 .git 文件），找不到时用 hook 的 cwd
function projectRelative(abs) {
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.relative(dir, abs);
    if (path.dirname(dir) === dir) break;
  }
  const rel = input.cwd ? path.relative(input.cwd, abs) : abs;
  return rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(abs) : rel;
}
const rel = projectRelative(path.resolve(input.cwd || process.cwd(), file));
if (NOT_CODE_DIR_RE.test(rel)) process.exit(0);

// 统一成 \n，CRLF 文件里行号才对得上
const lf = (s) => s.replace(/\r\n?/g, '\n');
let current;
try {
  if (fs.statSync(file).size > 1 << 20) process.exit(0);
  current = lf(fs.readFileSync(file, 'utf8'));
} catch {
  process.exit(0);
}
const fileLines = current.split('\n');

// 本次新写的行号（1 起）。和删掉的某行只差空白的不算：那是挪位置或改缩进
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const added = new Set();
const patch = Array.isArray(resp.structuredPatch) ? resp.structuredPatch : null;
if (patch && patch.length) {
  const removed = new Set();
  for (const h of patch) for (const l of h.lines || []) if (l[0] === '-') removed.add(squash(l.slice(1)));
  for (const h of patch) {
    let n = h.newStart;
    for (const l of h.lines || []) {
      if (l[0] === '-' || l[0] === '\\') continue; // `\ No newline at end of file` 不占行
      if (l[0] === '+' && !removed.has(squash(l.slice(1)))) added.add(n);
      n++;
    }
  }
} else if (tool === 'Write' && resp.type === 'create') {
  // 明确是新建文件：整份都是新写的。type 缺失时分不清新建还是覆盖，宁可不提醒，免得把原有注释当成新写的
  fileLines.forEach((_, i) => added.add(i + 1));
} else if (!patch) {
  // 没有 structuredPatch 的旧版本：按 new_string 在文件里出现的位置估算。
  // 出现多处时分不清是哪一处（replace_all 时本来就是每一处），全部算上
  const edits = tool === 'MultiEdit' ? ti.edits || [] : tool === 'Edit' ? [ti] : [];
  for (const e of edits) {
    const next = lf(e.new_string || '');
    if (!next) continue;
    const removed = new Set(lf(e.old_string || '').split('\n').map(squash));
    const fresh = next.split('\n').map((l, k) => (removed.has(squash(l)) ? -1 : k)).filter((k) => k !== -1);
    if (!fresh.length) continue;
    let line = 1;
    let from = 0;
    for (let base = current.indexOf(next); base !== -1; base = current.indexOf(next, base + next.length)) {
      for (; from < base; from++) if (current.charCodeAt(from) === 10) line++;
      for (const k of fresh) added.add(line + k);
    }
  }
}
if (!added.size) process.exit(0);

const hits = [];
for (const b of findCommentBlocks(current, file)) {
  let total = 0;
  let fresh = 0;
  for (let n = b.start; n <= b.end; n++) {
    if (!fileLines[n - 1].trim()) continue;
    total++;
    if (added.has(n)) fresh++;
  }
  if (fresh && fresh * 2 >= total) hits.push(`第 ${b.start}–${b.end} 行（${b.lines} 行）`);
}
if (!hits.length) process.exit(0);

const msg = [
  `[context-keeper] 刚写入的 ${file} 里有长注释块：${hits.join('、')}。`,
  '如果其中讲的是为什么这么做、以前的方案、实测数字、踩坑经过、外部约束这类背景，按 context-keeper 规范（用 record-context）拆开：',
  '注释只留必须知道的那一句（做什么、坑、一句原因），1–3 行；经过、试过的方案、数字等扩展内容移进 context-docs/<领域>/<slug>.md，',
  // 示例路径拆开写，免得 check.mjs 把它当成失效指针
  `原处留「重点 + 什么时候读 + 仓库根起的路径」，例如 \`// 重试上限 3：网关连续 5 次失败会封 IP。改重试次数或退避前读 ${['apps/web', 'context-docs', 'api/retry-policy.md'].join('/')}\`。`,
  '同样的内容也适用于其他文件时，写成 rule 而不是注释。注释只是在说明这段代码做什么、怎么用的，忽略本提示。',
].join('');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
}));
