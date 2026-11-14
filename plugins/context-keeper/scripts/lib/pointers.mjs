// 指向 context-docs/ 文档的指针，供 check.mjs、pointer-guard.mjs 和 doc-hook.mjs 共用。
// 纯文本指针写仓库根起的路径（`<作用域>/context-docs/<领域>/<slug>.md`）；Markdown 链接的目标按所在文件的目录解析（见下面「Markdown 链接」）。
// 这个文件会随 check.mjs 复制进项目，注释里不写具体示例路径，免得被当成失效指针。

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

// Markdown 代码块外的行，返回 [[line, i]]，i 为 0 起的行下标，围栏行本身不返回。plain 为 true 时（源码）不认代码块。
// 缩进代码块也不返回：缩进 4 格以上（在列表项里从列表项内容的缩进算起）的行，到缩进不够的行为止。
// 缩进代码块不能打断段落：只在空行、标题、分隔线、围栏结束之后（或文件开头）才算开始。
// 列表项里缩进的续行（含缩进的引用式定义）不算代码块。列表可以嵌套，按层记每一层内容的缩进：
// 空行之后缩进不够某一层的、新的列表项、标题、引言、围栏和分隔线（不空行直接接在列表后面也一样）都退出到够得着的那一层；
// 不空行接着写的普通文字是上一段的续行，层次不变。`- - -`、`* * *` 是分隔线，不是列表项
export const LIST_MARK_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/; // 列表项的标记，check.mjs 判断新的列表项也用它
export const HR_LINE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/; // 分隔线
const HEADING_RE = /^[ \t]*#{1,6}(?:[ \t]|$)/;
const FENCE_RE = /^\s*(```|~~~)/;
const BLOCK_START_RE = /^[ \t]*(?:>|```|~~~)/; // 另外还有标题、分隔线
const widthOf = (s) => s.replace(/\t/g, '    ').length;
export function proseLines(text, plain = false) {
  const out = [];
  let fence = false;
  const lists = []; // 所在的各层列表项内容的缩进，外层在前
  let blank = true; // 上一行是空行（或文件开头）
  let codeOk = true; // 这里可以开始（或接着）缩进代码块：上一行是空行、标题、分隔线、围栏结束或缩进代码块
  text.split(/\r?\n/).forEach((line, i) => {
    if (plain) { out.push([line, i]); return; }
    if (!fence) {
      if (!line.trim()) { blank = codeOk = true; out.push([line, i]); return; }
      const indent = widthOf(line.match(/^[ \t]*/)[0]);
      const hr = HR_LINE_RE.test(line);
      const heading = HEADING_RE.test(line);
      const m = hr ? null : line.match(LIST_MARK_RE);
      if (blank || m || hr || heading || BLOCK_START_RE.test(line)) while (lists.length && lists[lists.length - 1] > indent) lists.pop();
      blank = false;
      if (codeOk && indent >= (lists[lists.length - 1] ?? 0) + 4) return;
      if (m) lists.push(widthOf(m[0]));
      codeOk = hr || heading;
    }
    if (FENCE_RE.test(line)) {
      fence = !fence;
      if (!fence) codeOk = true;
      return;
    }
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

// ---------- Markdown 链接 ----------
// 纯文本指针（反引号或裸写的路径）写仓库根起的路径；Markdown 链接的目标按 Markdown 的规矩，相对所在文件的目录解析，
// 这样在 GitHub、IDE 预览里点得开。开头是 `/` 的按仓库根解析（GitHub 的口径）。两种各按各的规矩校验，互不混用

// 行内链接 `[文字](目标 "标题")`（文字里允许一层方括号，目标可以用尖括号包起来）、引用式定义 `[id]: 目标`
// 和引用式用法 `[文字][id]`、`[id][]`、`[id]`（id 有定义时）。脚注定义 `[^1]: …` 后面是正文，不是链接目标。
// 定义行不限缩进（列表项里的定义要缩进），免得被当成引用式用法；目标（和标题）后面还有别的字的不是定义（`[注意]: 改 X 前读 …`），
// 按普通的行查。反斜杠转义的 `\[` 不是链接。
// 行内代码里的是示例，先抹掉
const INLINE_LINK_RE = /(?<!\\)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const LINK_DEF_RE = /^(\s*\[(?!\^)([^\]]+)\]:[ \t]*)(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const REF_LINK_RE = /(?<!\\)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\[([^\]]*)\])?/g;
// 行内代码按开头的反引号个数配对：```` ``a ` b`` ```` 里的单个反引号不结束代码
const maskCode = (line) => line.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (s) => ' '.repeat(s.length));
const refKey = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase(); // 引用 id 不分大小写，连续空白算一个

// 一份 Markdown 里引用式链接的定义（代码块外的）：Map<id, 目标>，同一个 id 以第一次定义为准。
// prose 是 proseLines(text) 的结果，调用方已经算过的传进来，不再切一遍
export function linkDefs(text, prose = proseLines(text)) {
  const defs = new Map();
  for (const [line] of prose) {
    const d = maskCode(line).match(LINK_DEF_RE);
    if (d && !defs.has(refKey(d[2]))) defs.set(refKey(d[2]), line.slice(d[1].length, d[1].length + d[3].length));
  }
  return defs;
}

// 一行里的 Markdown 链接，按出现的顺序：[{ text, target, index, at, end, def?, ref? }]。index 是链接（`[`）在行里的位置，
// at 是目标在行里的位置，end 是目标连同后面的标题（`"标题"`）结束的位置。
// def 是引用式定义行；ref 是引用式用法，目标取自 defs（linkDefs 的结果），不在这一行里，at、end 为 -1
export function linksIn(line, defs) {
  const refs = defs && defs.size > 0;
  if (!line.includes('](') && !line.includes(']:') && !(refs && line.includes(']'))) return [];
  const masked = maskCode(line);
  const out = [];
  let rest = masked; // 认过的行内链接抹掉，剩下的再找引用式用法
  for (const m of masked.matchAll(INLINE_LINK_RE)) {
    const at = m.index + m[0].indexOf(m[2], m[1].length + 3); // 跳过 `[文字](`
    out.push({ text: line.slice(m.index + 1, m.index + 1 + m[1].length), target: line.slice(at, at + m[2].length), index: m.index, at, end: m.index + m[0].length - 1 });
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  const d = masked.match(LINK_DEF_RE);
  if (d) {
    out.push({ text: '', target: line.slice(d[1].length, d[1].length + d[3].length), index: line.search(/\S/), at: d[1].length, end: line.length, def: true });
  } else if (refs) {
    for (const m of rest.matchAll(REF_LINK_RE)) {
      const target = defs.get(refKey(m[2] || m[1]));
      if (target !== undefined) out.push({ text: line.slice(m.index + 1, m.index + 1 + m[1].length), target, index: m.index, at: -1, end: -1, ref: true });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// 把一行里的链接目标连同标题抹成空格（长度不变，下标照旧），纯文本指针的正则就不会把链接目标、标题里的路径当成仓库根起的路径。
// links 是这一行已经解析好的链接，不传时现解析
export function maskLinkTargets(line, links = linksIn(line)) {
  let out = line;
  for (const l of links) if (l.at >= 0) out = out.slice(0, l.at) + ' '.repeat(l.end - l.at) + out.slice(l.end);
  return out;
}

// 链接目标里的文件路径：去掉尖括号、`#锚点`、`?查询`，解码 %20 这类转义。外链（带协议、`//` 开头）和纯锚点返回 null。
// 逐段用 decodeURIComponent 解码：decodeURI 不解 %23、%3F 这类保留字符，文件名里的 `#`、`?` 只能这样写
export function linkPath(target) {
  let t = target.replace(/^<|>$/g, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(t) || t.startsWith('//')) return null;
  t = t.replace(/[#?].*$/, '');
  if (!t) return null;
  return t.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
}

// 解码后的路径写回链接目标：空格、括号、尖括号、`%`、`#`、`?` 原样写会弄断链接或被当成锚点、查询，转义回去，`/` 照留。
// check.mjs 给出改好的链接目标、doc-hook 按文件名筛链接都用它，两边写法一致
export const escapeLinkPath = (s) => s.replace(/[%\s()<>#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

// 链接目标解析成仓库根起的路径。file 是链接所在文件（仓库根起）。解析到仓库外、或不是文件路径的返回 null
export function resolveLink(file, target) {
  const t = linkPath(target);
  if (t === null) return null;
  const p = t.startsWith('/') ? path.posix.normalize(t.slice(1)) : path.posix.join(path.posix.dirname(file), t);
  return !p || p === '.' || p.startsWith('../') || p === '..' ? null : p;
}

// 链接目标写成了仓库根起的路径（在子目录的文件里解析错了）时，按仓库根解析出来的路径。
// `/` 开头的本来就按仓库根解析；`./`、`../` 开头的是照着所在文件写的相对路径，只是写错了，不按仓库根猜。不是这种写法的返回 null。
// check.mjs 报错并给改法、doc-hook 把这种写错的链接也列出来，都用它
export function rootPathOf(target) {
  const t = linkPath(target);
  return t && !/^(?:\/|\.\.?\/)/.test(t) ? resolveLink('', target) : null;
}

// 链接实际指到的文件（仓库根起）：按所在目录解析找得到的就是它（不论是不是文档）；找不到、目标写成了仓库根起的路径、
// 按仓库根找得到一份文档（含旧目录里的）的，算指到那份文档（0.8.0 整理时改出来的写法：check.mjs 报错，doc-hook 照样列）。
// 按仓库根找到的不是文档（碰巧有个同名的普通文件）时不算：多半是相对链接指的文档没了，不该改去指那个文件。都不是返回 null。
// l 是 splitLine 解析出来的链接（带 resolved），exists(p) 判断仓库根起的路径是否存在
export function linkedFile(l, exists) {
  if (l.resolved && exists(l.resolved)) return l.resolved;
  const p = rootPathOf(l.target);
  return p && (DOC_RE.test(p) || LEGACY_DOC_RE.test(p)) && exists(p) ? p : null;
}

// 一行拆成链接和抹掉链接目标后的行（scan）：纯文本指针在 scan 上找，按仓库根解析；链接目标按 file 的目录解析，记在 resolved 上。
// check.mjs 和 doc-hook 都用它，口径一致。defs 是 file 里引用式链接的定义（linkDefs 的结果），为 null 时（不是 Markdown）不认链接
export function splitLine(file, line, defs) {
  const links = defs ? linksIn(line, defs).map((l) => ({ ...l, resolved: resolveLink(file, l.target) })) : [];
  return { links, scan: links.length ? maskLinkTargets(line, links) : line };
}

// 链接是不是指向文档目录里的 Markdown：解析出来的路径落在文档目录里，或者目标里写了文档目录名。
// 后一种是为了认出解析到别处去的链接（把仓库根起的路径写进链接目标，在子目录的文件里就会解析错）。
// 只认新目录：写了旧目录的链接由 check.mjs 另报旧版路径
export function isDocLink(resolved, target) {
  const t = linkPath(target);
  if (t === null || !MARKDOWN_RE.test(t)) return false;
  const mark = `${DOC_DIR}/`;
  return (resolved !== null && segmentIndex(resolved, mark) !== -1) || segmentIndex(t.replace(/^\//, ''), mark) !== -1;
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
