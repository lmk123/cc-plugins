#!/usr/bin/env node
// PostToolUse hook：Write / Edit / MultiEdit 改了 context-docs/ 里的项目文档之后，列出指到这份文档的行
// （领域索引 rule、文档入口、rule、CLAUDE.md、skill 和源码注释里的指针），提醒 Claude：文档里的结论变了，这些行里的重点要跟着改。
// 这些行里的重点是从文档提炼的，文档改了它们不会自己变，而 Claude 看了重点多半不会再去读文档。
// 只提醒，不阻断；没有任何一处指到的文档（比如刚新建的）不提醒。设环境变量 CONTEXT_KEEPER_DOC_HOOK=0 可关闭。
// 同一会话里同一份文档，清单只给一次：之后再改它、清单没变时只提醒一行，清单变了或压缩上下文之后重新给。
//
// 指到它的行和 check.mjs 同一套口径：Markdown 代码块里的示例、源码字符串里的路径不算。
// 用 git grep 找，所以不是 git 仓库的项目不提醒。出任何意外都静默退出。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { langFor } from './lib/comments.mjs';
import {
  ANY_POINTER_RE, DOC_RE, ENTRY_RE, LEGACY_DOC_RE, LEGACY_ENTRY_RE, LEGACY_RENAME_HINT, MARKDOWN_RE,
  commentLines, escapeLinkPath, findRoot, inComment, isLegacyDoc, isPointerMarkdown, linkDefs, pointersIn, proseLines, resolvePointer,
  splitLine,
} from './lib/pointers.mjs';
import { stateFile } from './lib/state.mjs';

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

// 指针写的是项目根起的路径。不是 git 仓库时下面的 git grep 会失败退出
const root = findRoot(file, process.env.CLAUDE_PROJECT_DIR || input.cwd);
if (!root) process.exit(0);
const doc = path.relative(root, file).split(path.sep).join('/');
// 只管文档。文档入口是清单，不是文档：指到它的行里没有从它提炼的重点。
// 旧目录 `.context/` 里的文档也管：升级后、改名前提醒不中断
if (DOC_RE.test(doc) ? ENTRY_RE.test(doc) : !LEGACY_DOC_RE.test(doc) || LEGACY_ENTRY_RE.test(doc)) process.exit(0);

// 先用 git grep 筛出提到这份文档的文件（范围和 check.mjs 一致：已跟踪的加未跟踪、没被忽略的），下面逐行解析。
// 源码只认纯文本指针，按完整路径筛。Markdown 链接的目标是相对所在文件的路径（`../api/x.md`），不含完整路径，
// 只在 .md 里按文件名筛：原样的、%20 转义空格的、整个 URL 编码的、check.mjs 给出改法时的写法（escapeLinkPath，括号、`#` 也转义；
// 十六进制大小写都认），和 check.mjs 解码后的口径一致。
// 两次 grep 同时跑：hook 每次改文档都跑，串着跑要扫两遍工作区的时间。一次出错、超时（返回 null）只丢它那一份，另一份照列；两次都失败才静默退出
const grep = (patterns, flags = [], spec = []) => new Promise((resolve) => {
  const g = spawn('git', ['grep', '-lIz', '--untracked', '-F', ...flags, ...patterns.flatMap((p) => ['-e', p]), '--', ...spec], {
    cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  g.stdout.setEncoding('utf8');
  g.stdout.on('data', (d) => { out += d; });
  g.on('error', () => resolve(null));
  g.on('close', (code) => resolve(code === 0 || code === 1 ? out.split('\0').filter(Boolean) : null)); // 1 是没找到
});
const base = path.posix.basename(doc);
const hits = await Promise.all([
  grep([doc]),
  grep([...new Set([base, base.replace(/ /g, '%20'), encodeURI(base), escapeLinkPath(base)])], ['-i'], ['*.md']),
]);
if (hits.every((h) => h === null)) process.exit(0);
const candidates = new Set(hits.flat().filter((f) => f !== null));

// 哪些文件里的路径算指针，和 check.mjs 同一套口径：rule、文档入口、CLAUDE.md、skill 里代码块外的行，
// 以及认得的源码里注释里的。别的文档里提到它只是互相引用，README、CHANGELOG 这类 Markdown 里的多半是示例，都不算；
// 源码字符串里的路径（输出文件名、测试数据）和不认得的文件里的路径没有从文档提炼的重点，也不列
const exists = (p) => fs.existsSync(path.join(root, p));

const MAX_ROWS = 10;
const rows = [];
let more = 0;
for (const f of [...candidates].sort()) {
  const isMd = MARKDOWN_RE.test(f);
  if (isMd ? !isPointerMarkdown(f) && !LEGACY_ENTRY_RE.test(f) : !langFor(f)) continue;
  let text;
  try {
    const full = path.join(root, f);
    if (fs.statSync(full).size > 1 << 20) continue;
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const comment = isMd ? null : commentLines(text.split(/\r?\n/)).comment;
  const defs = isMd ? linkDefs(text) : null;
  for (const [line, i] of proseLines(text, !isMd)) {
    // 路径只是另一个作用域里同名文档的后半截时，解析出来的不是这份文档
    // Markdown 里纯文本路径按仓库根解析，链接目标按所在文件的目录解析。引用式链接列用到它的那一行（重点写在那里），不列定义行
    const { links, scan } = splitLine(f, line, defs);
    const hit = pointersIn(scan, ANY_POINTER_RE).find((raw) => resolvePointer(raw, exists) === doc)
      || links.some((l) => !l.def && l.resolved === doc);
    if (!hit || (!isMd && !inComment(line, i, comment, hit))) continue;
    if (rows.length >= MAX_ROWS) { more++; continue; }
    const t = line.trim();
    rows.push(`- ${f}:${i + 1}  ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
  }
}
if (!rows.length) process.exit(0);

// 一份文档常常连着改好几次，每次都贴一遍清单只是占 context：本会话已经给过同样的清单时只提醒一行。
// 状态按会话（子代理各算各的）记在临时目录里，主会话压缩上下文后由 pointer-guard 清掉。
// 拿不到会话 id 时不记，每次都给清单；状态读写失败也照常给
const sf = input.session_id || input.transcript_path ? stateFile(input, 'doc') : null;
const key = crypto.createHash('sha1').update(`${root}\n${doc}`).digest('hex').slice(0, 16);
const digest = crypto.createHash('sha1').update(`${rows.join('\n')}\n${more}`).digest('hex').slice(0, 16);
let shown = {};
if (sf) try { shown = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
const repeat = Boolean(shown[key] && shown[key].h === digest);
if (sf && !repeat) {
  try {
    shown[key] = { h: digest, t: Date.now() };
    fs.mkdirSync(path.dirname(sf), { recursive: true });
    fs.writeFileSync(sf, JSON.stringify(shown));
  } catch {}
}

const msg = repeat
  ? `[context-keeper] 又改了 ${doc}：指到它的 ${rows.length + more} 处（清单见本会话前面的提醒）里，重点跟着不成立的，同一次改动里改掉。`
  : [
    `[context-keeper] 刚改的 ${doc} 被下面${rows.length + more > 1 ? '几' : '这一'}处指到，每一行里的重点都是从这份文档提炼的：`,
    ...rows,
    ...(more ? [`（另有 ${more} 处没列出，grep 这个路径看）`] : []),
    '这次改动让哪一行的重点不再成立（结论变了、提到的数值变了），同一次改动里把那一行也改掉；都还成立就不用动。',
    ...(isLegacyDoc(doc) ? [`这份文档在${LEGACY_RENAME_HINT}。`] : []),
  ].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
}));
