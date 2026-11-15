// check.mjs 和 comment-hook.mjs 共用的文件分类与文本工具。
// 这个文件会随 check.mjs 复制进项目。

// ---------- 文件分类 ----------

export const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
export const CLAUDE_MD_RE = /(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/;
export const SKILL_RE = /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/;
// skill 目录下的 Markdown（SKILL.md 和它的参考文件）：用到 skill 时才读，同样只该写结论
export const SKILL_MD_RE = /(^|\/)\.claude\/skills\/.+\.(md|mdx|markdown)$/i;
// 子代理和命令的定义：同样是 Claude 会加载的文字，里面指向旧版文档的行也是指针
export const AGENT_MD_RE = /(^|\/)\.claude\/(agents|commands)\/.+\.(md|mdx|markdown)$/i;
export const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;
// 0.9.x 及更早的插件建的项目文档目录（0.7.x 及更早是点开头的那个）：0.10.0 起整个迁走
export const LEGACY_DOC_DIRS = ['context-docs', '.context'];
// 0.9.x 的领域索引 rule：登记旧版文档用的，随文档一起迁走
export const INDEX_RULE_RE = /(^|\/)\.claude\/rules\/[^/]+\/context-index\.md$/;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 注释扫描和 comment-hook 都不管的目录：旧版文档目录、.claude/、node_modules/。分隔符两种都认（hook 拿到的可能是 Windows 路径）
export const NOT_CODE_DIR_RE = new RegExp(String.raw`(^|[\\/])(${[...LEGACY_DOC_DIRS, '.claude', 'node_modules'].map(reEscape).join('|')})[\\/]`);

// ---------- Markdown 正文 ----------

// Markdown 代码块外的行，返回 [[line, i]]，i 为 0 起的行下标，围栏行本身不返回。
// 缩进代码块也不返回：缩进 4 格以上（在列表项里从列表项内容的缩进算起）的行，到缩进不够的行为止。
// 缩进代码块不能打断段落：只在空行、标题、分隔线、围栏结束之后（或文件开头）才算开始。
// 列表项里缩进的续行不算代码块。列表可以嵌套，按层记每一层内容的缩进：
// 空行之后缩进不够某一层的、新的列表项、标题、引言、围栏和分隔线都退出到够得着的那一层；
// 不空行接着写的普通文字是上一段的续行，层次不变。`- - -`、`* * *` 是分隔线，不是列表项
const LIST_MARK_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const HR_LINE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^[ \t]*#{1,6}(?:[ \t]|$)/;
const FENCE_RE = /^\s*(```|~~~)/;
const BLOCK_START_RE = /^[ \t]*(?:>|```|~~~)/;
const widthOf = (s) => s.replace(/\t/g, '    ').length;
export function proseLines(text) {
  const out = [];
  let fence = false;
  const lists = [];
  let blank = true;
  let codeOk = true;
  text.split(/\r?\n/).forEach((line, i) => {
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

// ---------- 路径段 ----------

// marker 在 s 里作为一个路径段的开头出现的第一个位置，没有返回 -1。默认（s 是路径）前一个字符是 `/` 或 s 的开头才算；
// loose 为 true 时（s 是一段正文），前一个字符不是路径名里的字符就算，空白、引号、`(`、中文都行。
// 两种都不认 `user-context-docs/` 中间的那一截；反斜杠后面的也不认：那是正则里转义的点，不是路径
const NAME_CHAR_RE = /[A-Za-z0-9_.\\-]/;
const atSegment = (s, i, loose) => i === 0 || (loose ? !NAME_CHAR_RE.test(s[i - 1]) : s[i - 1] === '/');
export function segmentIndex(s, marker, loose = false) {
  for (let i = s.indexOf(marker); i !== -1; i = s.indexOf(marker, i + 1)) {
    if (atSegment(s, i, loose)) return i;
  }
  return -1;
}
// 同上，返回所有位置
export function segmentIndexes(s, marker, loose = false) {
  const out = [];
  for (let i = s.indexOf(marker); i !== -1; i = s.indexOf(marker, i + 1)) {
    if (atSegment(s, i, loose)) out.push(i);
  }
  return out;
}
