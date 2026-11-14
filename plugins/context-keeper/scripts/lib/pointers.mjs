// 指向 context-docs/ 文档的指针，供 check.mjs、pointer-guard.mjs 和 doc-hook.mjs 共用。
// 指针一律写仓库根起的路径（`<作用域>/context-docs/<领域>/<slug>.md`）。这个文件会随 check.mjs 复制进项目，注释里不写具体示例路径，免得被当成失效指针。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 文件分类：哪些文件里的路径算指针 ----------

export const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
// 目录名在脚本里只写这一次，下面的正则和各脚本里的判断都从它们生成。
// hooks/hooks.json 里 doc-hook 的 shell 预筛另写了一遍（shell 读不到这里），改目录名时一起改，doc-hook.test.mjs 会对着这两个常量查
export const DOC_DIR = 'context-docs';
export const LEGACY_DOC_DIR = '.context'; // 0.7.x 及更早的文档目录：check.mjs 报出来要求改名，hook 在改名前照样认，保护不中断
export const DOC_DIRS = [DOC_DIR, LEGACY_DOC_DIR];
// hook 拦下或提醒时，碰到旧目录里的文档附带的改名提示
export const LEGACY_RENAME_HINT = `旧目录 \`${LEGACY_DOC_DIR}/\` 里，这个目录 0.8.0 起要改名为 \`${DOC_DIR}/\`：改完提醒用户跑 organize-context 迁移（把目录 git mv 改名，指针一并改掉）`;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const underDir = (dir, rest) => new RegExp(String.raw`(^|\/)${reEscape(dir)}\/${rest}$`);
export const DOC_RE = underDir(DOC_DIR, String.raw`.+\.md`); // 区分大小写：和 POINTER_RE 口径一致
export const ENTRY_RE = underDir(DOC_DIR, String.raw`README\.md`); // 文档入口：登记挂不到代码上的文档，本身不是文档
export const LEGACY_DOC_RE = underDir(LEGACY_DOC_DIR, String.raw`.+\.md`);
export const LEGACY_ENTRY_RE = underDir(LEGACY_DOC_DIR, String.raw`README\.md`);
// hook 和注释扫描都不管的目录：文档目录（含旧版）、.claude/、node_modules/。分隔符两种都认（hook 拿到的可能是 Windows 路径）
export const NOT_CODE_DIR_RE = new RegExp(String.raw`(^|[\\/])(${[...DOC_DIRS, '.claude', 'node_modules'].map(reEscape).join('|')})[\\/]`);
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

// 路径段允许中文等非 ASCII 字符；前面紧贴的字符只排除 ASCII 的路径字符，这样"详见context-docs/…"这种紧贴中文的写法也能认出来。
// dirs 是文档目录名（不转义）的列表
// 返回的正则带 marks（`<目录名>/` 的列表），pointersIn 用它先粗筛
export const pointerRe = (dirs) => Object.assign(new RegExp(
  String.raw`(?<![\w./-])((?:[\p{L}\p{N}_.-]+\/)*(?:${dirs.map(reEscape).join('|')})\/[\p{L}\p{N}_./-]*?[\p{L}\p{N}_-]\.md)(?![\p{L}\p{N}_.-])`,
  'gu',
), { marks: dirs.map((d) => `${d}/`) });
export const POINTER_RE = pointerRe([DOC_DIR]);
export const LEGACY_POINTER_RE = pointerRe([LEGACY_DOC_DIR]);
export const ANY_POINTER_RE = pointerRe([DOC_DIR, LEGACY_DOC_DIR]); // hook 用：改名前的旧指针照样认

// 一行里的指针原文（去重，去掉开头的 ./）。re 默认只认新目录
export function pointersIn(line, re = POINTER_RE) {
  const out = [];
  if (re.marks && !re.marks.some((m) => line.includes(m))) return out; // 先粗筛：一行里连目录名都没有就不跑正则
  for (const m of line.matchAll(re)) {
    const raw = m[1].replace(/^\.\//, '');
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

// 文档路径是不是在旧目录里
export const isLegacyDoc = (p) => LEGACY_DOC_RE.test(p);

// marker 在 s 里作为一个路径段的开头出现的第一个位置，没有返回 -1。默认（s 是路径）前一个字符是 `/` 或 s 的开头才算；
// loose 为 true 时（s 是一段命令），前一个字符不是路径名里的字符就算，空白、引号、`<`、`(`、`=` 都行。
// 两种都不认 `user-context-docs/` 中间的那一截
const NAME_CHAR_RE = /[\p{L}\p{N}_.-]/u;
const atSegment = (s, i, loose) => i === 0 || (loose ? !NAME_CHAR_RE.test(s[i - 1]) : s[i - 1] === '/');
export function segmentIndex(s, marker, loose = false) {
  for (let i = s.indexOf(marker); i !== -1; i = s.indexOf(marker, i + 1)) {
    if (atSegment(s, i, loose)) return i;
  }
  return -1;
}
// 同 segmentIndex（s 是路径），找最后一个
export function lastSegmentIndex(s, marker) {
  for (let i = s.lastIndexOf(marker); i !== -1; i = i > 0 ? s.lastIndexOf(marker, i - 1) : -1) {
    if (atSegment(s, i, false)) return i;
  }
  return -1;
}

// 中文正文紧贴路径时（"见包/context-docs/…"），前面的字会被并进第一段：逐个去掉开头的非 ASCII 字符再试，
// 第一段至少留一个字符，免得退化成根作用域的 `context-docs/`。exists(p) 判断仓库根起的路径是否存在，都不存在时返回 null
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
