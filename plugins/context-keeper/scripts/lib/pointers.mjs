// 指向 _context/ 文档的指针，供 check.mjs、pointer-guard.mjs 和 doc-hook.mjs 共用。
// 指针一律写仓库根起的路径（`<作用域>/_context/<领域>/<slug>.md`）。这个文件会随 check.mjs 复制进项目，注释里不写具体示例路径，免得被当成失效指针。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 文件分类：哪些文件里的路径算指针 ----------

export const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
export const DOC_RE = /(^|\/)_context\/.+\.md$/; // 区分大小写：和 POINTER_RE 口径一致
export const ENTRY_RE = /(^|\/)_context\/README\.md$/; // 文档入口：登记挂不到代码上的文档，本身不是文档
export const CLAUDE_MD_RE = /(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/;
export const SKILL_RE = /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/;
export const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;
// 指针只认 Claude 会读到的 Markdown：CLAUDE.md、rule、skill、文档入口（文档之间的互相引用另算），以及非 Markdown 文件。
// 其他 Markdown（README、CHANGELOG、对外文档）里的路径多半是示例或历史记录，不算指针
export const isPointerMarkdown = (f) => RULE_RE.test(f) || ENTRY_RE.test(f) || CLAUDE_MD_RE.test(f) || SKILL_RE.test(f);

// Markdown 代码块外的行，返回 [[line, i]]，i 为 0 起的行下标，围栏行本身不返回。plain 为 true 时（源码）不认围栏
export function proseLines(text, plain = false) {
  const out = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!plain && /^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence) out.push([line, i]);
  });
  return out;
}

// 源码里的指针是不是写在注释里：所在行是注释（comment 是 commentLines 的结果），或者是行尾注释（指针前面有注释符）。
// 字符串里的路径（输出文件名、测试数据）不是写给人看的指针
const TRAILING_COMMENT_RE = /(?:^|\s)(?:\/\/|\/\*|#|--|<!--)/;
export const inComment = (line, i, comment, raw) => comment[i] || TRAILING_COMMENT_RE.test(line.slice(0, line.indexOf(raw)));

// 项目根取离文件最近的 .git（worktree 里是 .git 文件）。不是 git 仓库时用 base（启动会话的目录），
// 文件不在它下面时返回 null：指针是项目根起的路径，没有根就解析不了
export function findRoot(file, base) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  if (!base) return null;
  const inside = path.relative(path.resolve(base), file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return path.resolve(base);
}

// ---------- 指针 ----------

// 路径段允许中文等非 ASCII 字符；前面紧贴的字符只排除 ASCII 的路径字符，这样"详见_context/…"这种紧贴中文的写法也能认出来
export const POINTER_RE = /(?<![\w./-])((?:[\p{L}\p{N}_.-]+\/)*_context\/[\p{L}\p{N}_./-]*?[\p{L}\p{N}_-]\.md)(?![\p{L}\p{N}_.-])/gu;

// 一行里的指针原文（去重，去掉开头的 ./）
export function pointersIn(line) {
  const out = [];
  if (!line.includes('_context/')) return out;
  for (const m of line.matchAll(POINTER_RE)) {
    const raw = m[1].replace(/^\.\//, '');
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

// 中文正文紧贴路径时（"见包/_context/…"），前面的字会被并进第一段：逐个去掉开头的非 ASCII 字符再试，
// 第一段至少留一个字符，免得退化成根作用域的 `_context/`。exists(p) 判断仓库根起的路径是否存在，都不存在时返回 null
export function resolvePointer(raw, exists) {
  for (let q = raw; ; q = q.replace(/^[^\x00-\x7f]/u, '')) {
    if (exists(q)) return q;
    if (!/^[^\x00-\x7f][^/]/u.test(q)) return null;
  }
}

// 哪些行是注释，不分语言，pointer-guard 和 check.mjs 用同一套口径认"注释里的指针"。lines 是按 \n 切开的行。
// 行注释和 `*` 开头的块注释续行按前缀认，JSX 的 `{/* … */}` 也认；
// `/* … */`、`<!-- … -->` 和行首的三引号 docstring 跨行时，中间没有前缀的行也算（CSS 只有这种块注释）。
// 没闭合的块不算，免得把后面整份文件当成注释；赋值给变量的三引号字符串不是注释，但要整段跳过，
// 否则收尾的那一行三引号会被当成新的开头。返回 { comment, docstring }，都是和 lines 等长的布尔数组
const COMMENT_RE = /^(\/\/|\/\*|\*|#|--|<!--|;|%|\{\s*\/\*)/;
const BLOCK_OPEN_RE = /^(?:\{\s*)?(\/\*|<!--)/;
const CLOSE = { '/*': '*/', '<!--': '-->', '"""': '"""', "'''": "'''" };
export function commentLines(lines) {
  const comment = new Array(lines.length).fill(false);
  const docstring = new Array(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].trim();
    if (COMMENT_RE.test(t)) comment[k] = true;
    let open = null;
    let at = 0;
    let doc = false;
    const m = t.match(BLOCK_OPEN_RE);
    if (m) {
      open = m[1];
      at = m[0].length;
    } else if (!comment[k]) {
      const q = t.search(/"""|'''/);
      if (q === -1) continue;
      open = t.slice(q, q + 3);
      at = q + 3;
      doc = /^[rRuUbBfF]{0,2}$/.test(t.slice(0, q));
    } else continue;
    let end = t.indexOf(CLOSE[open], at) !== -1 ? k : -1;
    for (let j = k + 1; end === -1 && j < lines.length; j++) if (lines[j].includes(CLOSE[open])) end = j;
    if (end === -1) continue;
    if (m || doc) for (let j = k; j <= end; j++) { comment[j] = true; docstring[j] = doc; }
    k = end;
  }
  return { comment, docstring };
}

// 指针有没有写"什么时候读"。没写的（"原因见 X""详见 X"）只能靠 Claude 猜要不要读。
// 认的是"…前 / …时 / …之后"。按排除来认：前、时后面跟什么动词都行（"前阅读""时对照""前确认"），
// 只排除它们属于别的词的情况——"以前""目前""超时""同时"（前面的字），"前端""前缀""时间""时序"（后面的字），"前 3 次"。
// 后面跟的字列不完，前、时开头的名词列得完。传进来的文本要先去掉指针路径本身
export const TRIGGER_RE = new RegExp([
  '(?<![以目从先此提当眼面日向往靠超空])前(?![端缀置面者后提景台方身述言任辈期夕往进驱沿锋线天年次]|\\s*[0-9一二两三四五六七八九十几])',
  '(?<![超同当实临暂及随定小平有届按准历耗即延何那顿]|运行)时(?![间候序刻期钟区长效代机延限段点速常而光])',
  '之后(?![的者])',
  '的时候|的话|如果|若(?!干)|涉及|遇到|碰到|一旦|先(?:阅?读|看|查|翻)',
  '\\b(?:before|when|whenever|if|prior to)\\b',
].join('|'), 'i');
