#!/usr/bin/env node
// PostToolUse hook：Write / Edit / MultiEdit 改了 .context/ 里的项目文档之后，列出指到这份文档的行
// （领域索引 rule、文档入口、rule、CLAUDE.md、skill 和源码注释里的指针），提醒 Claude：文档里的结论变了，这些行里的重点要跟着改。
// 这些行里的重点是从文档提炼的，文档改了它们不会自己变，而 Claude 看了重点多半不会再去读文档。
// 只提醒，不阻断；没有任何一处指到的文档（比如刚新建的）不提醒。设环境变量 CONTEXT_KEEPER_DOC_HOOK=0 可关闭。
//
// 指到它的行和 check.mjs 同一套口径：Markdown 代码块里的示例、源码字符串里的路径不算。
// 用 git grep 找，所以不是 git 仓库的项目不提醒。出任何意外都静默退出。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { langFor } from './lib/comments.mjs';
import {
  DOC_RE, ENTRY_RE, MARKDOWN_RE, commentLines, findRoot, inComment, isPointerMarkdown, pointersIn, proseLines, resolvePointer,
} from './lib/pointers.mjs';

if (process.env.CONTEXT_KEEPER_DOC_HOOK === '0') process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const ti = input.tool_input || {};
if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || !ti.file_path) process.exit(0);
const file = path.resolve(input.cwd || process.cwd(), ti.file_path);
if (!/\.md$/.test(file)) process.exit(0);

// 指针写的是项目根起的路径。不是 git 仓库时下面的 git grep 会失败退出
const root = findRoot(file, process.env.CLAUDE_PROJECT_DIR || input.cwd);
if (!root) process.exit(0);
const doc = path.relative(root, file).split(path.sep).join('/');
// 只管文档。文档入口是清单，不是文档：指到它的行里没有从它提炼的重点
if (!DOC_RE.test(doc) || ENTRY_RE.test(doc)) process.exit(0);

// 先用 git grep 筛出提到这个路径的文件（范围和 check.mjs 一致：已跟踪的加未跟踪、没被忽略的）
const r = spawnSync('git', ['grep', '-lIz', '--untracked', '-F', '-e', doc], { cwd: root, encoding: 'utf8', timeout: 5000 });
if (r.error || r.status !== 0) process.exit(0); // 1 是没找到

// 哪些文件里的路径算指针，和 check.mjs 同一套口径：rule、文档入口、CLAUDE.md、skill 里代码块外的行，
// 以及认得的源码里注释里的。别的文档里提到它只是互相引用，README、CHANGELOG 这类 Markdown 里的多半是示例，都不算；
// 源码字符串里的路径（输出文件名、测试数据）和不认得的文件里的路径没有从文档提炼的重点，也不列
const exists = (p) => fs.existsSync(path.join(root, p));

const MAX_ROWS = 10;
const rows = [];
let more = 0;
for (const f of r.stdout.split('\0').filter(Boolean)) {
  const isMd = MARKDOWN_RE.test(f);
  if (isMd ? !isPointerMarkdown(f) : !langFor(f)) continue;
  let text;
  try {
    const full = path.join(root, f);
    if (fs.statSync(full).size > 1 << 20) continue;
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const comment = isMd ? null : commentLines(text.split(/\r?\n/)).comment;
  for (const [line, i] of proseLines(text, !isMd)) {
    // 路径只是另一个作用域里同名文档的后半截时，解析出来的不是这份文档
    const hit = pointersIn(line).find((raw) => resolvePointer(raw, exists) === doc);
    if (!hit || (!isMd && !inComment(line, i, comment, hit))) continue;
    if (rows.length >= MAX_ROWS) { more++; continue; }
    const t = line.trim();
    rows.push(`- ${f}:${i + 1}  ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
  }
}
if (!rows.length) process.exit(0);

const msg = [
  `[context-keeper] 刚改的 ${doc} 被下面${rows.length + more > 1 ? '几' : '这一'}处指到，每一行里的重点都是从这份文档提炼的：`,
  ...rows,
  ...(more ? [`（另有 ${more} 处没列出，grep 这个路径看）`] : []),
  '这次改动让哪一行的重点不再成立（结论变了、提到的数值变了），同一次改动里把那一行也改掉；都还成立就不用动。',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
}));
