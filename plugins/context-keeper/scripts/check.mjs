#!/usr/bin/env node
// context-keeper 结构检查：把规范里能确定性校验的部分交给脚本，模型只处理需要判断的部分。
// 无第三方依赖。复制进项目接 CI 时连同 lib/ 目录一起复制（import 了 lib/comments.mjs）。
//
// 用法：node check.mjs [路径] [--comments] [--json]
//   路径        只报告该路径下文件的问题（默认整个仓库）。相对当前目录找不到时，按仓库根起的路径再找一次
//   --comments  额外扫描源码里的长注释块和带信号词的注释，作为搬运候选
//   --json      输出 JSON
// 有「错误」级问题时退出码为 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeComments, langFor } from './lib/comments.mjs';
import {
  CLAUDE_MD_RE, DOC_DIR, DOC_RE, ENTRY_RE, HR_LINE_RE, LEGACY_DOC_DIR, LEGACY_POINTER_RE, LIST_MARK_RE, MARKDOWN_RE, NOT_CODE_DIR_RE,
  RULE_RE, SKILL_RE, commentLines, escapeLinkPath, inComment, isDocLink, linkDefs, linkedFile, linkPath, pointersIn, proseLines,
  resolvePointer as resolveWith, rootPathOf, segmentIndex, splitLine, TRIGGER_RE,
} from './lib/pointers.mjs';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('用法：node check.mjs [路径] [--comments] [--json]');
  process.exit(0);
}
const WANT_COMMENTS = argv.includes('--comments');
const WANT_JSON = argv.includes('--json');
const target = argv.find((a) => !a.startsWith('--'));

// ---------- 仓库与文件列表 ----------

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

let ROOT = process.cwd();
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
const IS_GIT = top.status === 0;
if (IS_GIT) ROOT = top.stdout.trim();

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target', 'vendor']);

function listFiles() {
  if (IS_GIT) {
    const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(ROOT, f)));
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel); }
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

const FILES = listFiles().sort();
const FILE_SET = new Set(FILES);

let FILTER = '';
if (target) {
  let abs = path.resolve(process.cwd(), target);
  // 规范里的路径都从仓库根写起：在子目录里跑（比如在包目录里启动的会话）、按当前目录找不到时，再按仓库根解析一次
  if (!fs.existsSync(abs) && !path.isAbsolute(target) && fs.existsSync(path.join(ROOT, target))) abs = path.join(ROOT, target);
  FILTER = path.relative(ROOT, abs).split(path.sep).join('/');
  if (FILTER.startsWith('..')) { console.error(`路径不在仓库内：${target}`); process.exit(2); }
  if (!fs.existsSync(path.join(ROOT, FILTER))) { console.error(`路径不存在：${target}`); process.exit(2); }
  if (FILTER && !FILTER.endsWith('/') && fs.statSync(path.join(ROOT, FILTER)).isDirectory()) FILTER += '/';
}
const inScope = (f) => !FILTER || f === FILTER || f.startsWith(FILTER);

// 读文本文件；超过 1MB 或是二进制的返回 null
function readRaw(f) {
  try {
    const full = path.join(ROOT, f);
    if (fs.statSync(full).size > 1 << 20) return null;
    const buf = fs.readFileSync(full);
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
  } catch {
    return null;
  }
}

// 只缓存 rule、文档、CLAUDE.md 这类会被多处检查读到的小文件，源码一律用 readRaw 读、不进缓存
const cache = new Map();
function read(f) {
  if (!cache.has(f)) cache.set(f, readRaw(f));
  return cache.get(f);
}

// -z：不加的话非 ASCII 路径会被 git 转义成 "\345\214\205/..." 这种形式
function ignored(paths) {
  if (!IS_GIT || !paths.length) return new Set();
  const r = git(['check-ignore', '-z', '--stdin'], { input: paths.join('\0') });
  return new Set(r.stdout.split('\0').filter(Boolean));
}

// ---------- 结果收集 ----------

const findings = [];
const add = (level, category, file, msg, line) => {
  if (inScope(file)) findings.push({ level, category, file, line, msg });
};

// ---------- 分类 ----------

// RULE_RE、DOC_RE、ENTRY_RE、CLAUDE_MD_RE、SKILL_RE 在 lib/pointers.mjs 里，和 doc-hook 共用。DOC_RE 区分大小写，和 segmentIndex 口径一致
// 提示文字里的入口路径拆开写，免得脚本复制进项目后把它当成失效指针
const DOC_MARK = `${DOC_DIR}/`;
const LEGACY_MARK = `${LEGACY_DOC_DIR}/`;
const ENTRY = [DOC_DIR, 'README.md'].join('/');
const LEGACY_ENTRY = [LEGACY_DOC_DIR, 'README.md'].join('/'); // 0.7.x 及更早的文档入口
const ROOT_CLAUDE_MD = new Set(['CLAUDE.md', '.claude/CLAUDE.md']);
const INDEX_RULE_RE = /(^|\/)\.claude\/rules\/[^/]+\/context-index\.md$/;
const RULE_MAX_LINES = 10;

const rules = FILES.filter((f) => RULE_RE.test(f));
const entries = FILES.filter((f) => ENTRY_RE.test(f));
const docs = FILES.filter((f) => DOC_RE.test(f) && !ENTRY_RE.test(f));
const claudeMds = FILES.filter((f) => CLAUDE_MD_RE.test(f));
const skills = FILES.filter((f) => SKILL_RE.test(f));

// marker 作为完整的目录名出现的第一个位置（segmentIndex）：`request-context-docs/` 这类目录名里的 `context-docs/` 不算
const scopeOf = (f, marker) => f.slice(0, segmentIndex(f, marker));
// 第三方、构建产物目录（node_modules、vendor 等）下的旧版文档目录不是这个仓库的，不要求改名
const inSkipDir = (f) => f.split('/').some((s) => SKIP_DIRS.has(s));
const scopeFilesCache = new Map();
function scopeFiles(scope) {
  if (!scopeFilesCache.has(scope)) scopeFilesCache.set(scope, FILES.filter((f) => f.startsWith(scope)).map((f) => f.slice(scope.length)));
  return scopeFilesCache.get(scope);
}

// ---------- frontmatter ----------

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const fm = lines.slice(1, end);
  const unq = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  // YAML 行内注释：引号包起来的值取到配对的引号为止，否则去掉空白后面的 `#…`
  const noComment = (s) => {
    const t = s.trim();
    const q = t.match(/^(["'])(.*?)\1/);
    return q ? q[0] : t.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
  };
  const res = { paths: null, description: null, body: lines.slice(end + 1) };
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^(paths|description)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key] = m;
    const rest = noComment(m[2]);
    if (key === 'description') { res.description = unq(rest); continue; }
    if (rest.startsWith('[')) {
      res.paths = splitTopLevel(rest.replace(/^\[|\]$/g, '')).map(unq).filter(Boolean);
    } else if (rest) {
      res.paths = [unq(rest)];
    } else {
      // 块列表：中间夹的空行和注释行跳过
      res.paths = [];
      while (i + 1 < fm.length) {
        const next = fm[i + 1];
        if (/^\s*(#.*)?$/.test(next)) { i++; continue; }
        if (!/^\s*-\s+/.test(next)) break;
        const item = unq(noComment(next.replace(/^\s*-\s+/, '')));
        if (item) res.paths.push(item);
        i++;
      }
    }
  }
  return res;
}

// ---------- glob ----------
// 对齐 Claude Code 的做法：paths 每项按花括号外的逗号切开、展开花括号、去掉末尾的 `/**`，
// 再按 gitignore 语义匹配作用域根起的相对路径（ignore 包）。全部是 `**` 时视为没有 paths。

function splitTopLevel(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && depth <= 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// 展开第一组花括号（按深度找配对的 `}`，支持嵌套），再递归展开剩下的
function expandBraces(p, budget = { n: 1000 }) {
  const open = p.indexOf('{');
  if (open === -1) return [p];
  let close = -1;
  for (let i = open, depth = 0; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close === -1) return [p];
  const parts = splitTopLevel(p.slice(open + 1, close));
  if (!parts.length || (budget.n -= parts.length) < 0) return [p];
  const head = p.slice(0, open);
  const tail = p.slice(close + 1);
  return parts.flatMap((x) => expandBraces(head + x + tail, budget));
}

function expandPaths(items) {
  return items
    .flatMap(splitTopLevel)
    .flatMap((p) => expandBraces(p))
    .map((p) => (p.endsWith('/**') ? p.slice(0, -3) : p))
    .filter(Boolean);
}

// gitignore 语义：不含 `/`（末尾的不算）的模式匹配任意深度；含 `/` 的相对作用域根锚定；
// 匹配到某个目录，目录下所有文件都算匹配（所以 `src/*` 等于整个 src/）。正则不合法时抛错。
function gitignoreMatcher(glob) {
  let g = glob;
  const dirOnly = g.endsWith('/');
  g = g.replace(/\/+$/, '');
  const anchored = g.includes('/');
  g = g.replace(/^\//, '');
  const re = new RegExp(`^${anchored ? '' : '(?:[^/]+/)*'}${globBody(g)}$`);
  return (file) => {
    const segs = file.split('/');
    for (let i = 1; i <= segs.length; i++) {
      if (dirOnly && i === segs.length) continue;
      if (re.test(segs.slice(0, i).join('/'))) return true;
    }
    return false;
  };
}

function globBody(g) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length;) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      const prevSlash = i === 0 || g[i - 1] === '/';
      if (prevSlash && g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; continue; }
      if (prevSlash && i + 2 === g.length) { re += '.*'; i += 2; continue; }
      re += '[^/]*'; i += 2; continue;
    }
    if (c === '*') { re += '[^/]*'; i++; continue; }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      const close = g.indexOf(']', i + 1);
      if (close > i) {
        let cls = g.slice(i + 1, close);
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
    }
    if (c === '{') { depth++; re += '(?:'; i++; continue; }
    if (c === '}' && depth) { depth--; re += ')'; i++; continue; }
    if (c === ',' && depth) { re += '|'; i++; continue; }
    re += c.replace(/[.+^$(){}|\\\]]/g, '\\$&');
    i++;
  }
  return re;
}

// 按 glob 造一个它会匹配到的示例路径，用来问 git 这类文件是否被忽略。
// `**/*.pb.go` → `__probe__.pb.go`，`dist/**/*.js` → `dist/__probe__.js`
const sampleOf = (glob) => glob
  .replace(/^\/+|\/+$/g, '')
  .replace(/(^|\/)\*\*\//g, '$1')
  .replace(/\*+/g, '__probe__')
  .replace(/\?/g, '_')
  .replace(/\[([^\]]*)\]/g, (_, cls) => (/^[!^]/.test(cls) || !cls ? '_' : cls[0]))
  .replace(/[{}]/g, '') || '__probe__';

// 一碰就全中的写法：通配整个作用域，或通配 src/、packages/ 这类容器目录（`src/*` 按 gitignore 语义等于整个 src/）。
// `api/**` 这种领域级目录不算，交给下面按匹配比例判断。
const CONTAINER_DIRS = new Set(['src', 'lib', 'libs', 'app', 'apps', 'packages', 'modules', 'services', 'crates', 'pkg', 'internal', 'cmd', 'source', 'sources']);
const isBroadPattern = (g) => {
  const n = g.replace(/^\//, '').replace(/\/+$/, '').replace(/(\/\*\*)*(\/\*)?$/, '');
  return ['', '*', '**', '**/*', '**/*.*'].includes(n) || CONTAINER_DIRS.has(n);
};

// 生成物和 lockfile：按路径认（generated/ 目录、.generated. / .gen. / .pb. / .min. 这类文件名、-lock.yaml），
// 或文件头几行写着 generated / do not edit。认不出来的照常报，由人判断
const GENERATED_PATH_RE = /(^|\/)(generated|__generated__|gen)\/|\.(generated|gen|g|pb|min)\.[a-z0-9]+$|_pb2(_grpc)?\.pyi?$|[-.]lock\.(ya?ml|hcl|json|toml)$/i;
const GENERATED_HEAD_RE = /@generated|auto-?generated|code generated|generated by|do not edit|自动生成|请勿手动修改|不要手改/i;
function isGenerated(f) {
  if (GENERATED_PATH_RE.test(f)) return true;
  const text = readRaw(f);
  return !!text && GENERATED_HEAD_RE.test(text.split(/\r?\n/, 5).join('\n'));
}

// ---------- rules ----------

const unmatched = []; // 匹配不到文件、要问 git 是否指向被忽略路径的 glob，最后一次性查
for (const rule of rules) {
  const text = read(rule);
  if (text === null) continue;
  const scope = scopeOf(rule, '.claude/rules/');
  const scopeLabel = scope || '仓库根';
  const fm = parseFrontmatter(text);
  if (!fm) {
    if (/^paths\s*:/m.test(text)) add('error', 'rule', rule, 'frontmatter 的 `---` 不在第一行，paths 不生效，这条 rule 会常驻');
    else add('warn', 'rule', rule, '没有 paths，会常驻加载：补 paths，或说明它其实是 ALWAYS');
    continue;
  }
  // orig 是 paths 里按逗号切开后的一项，glob 是它展开花括号、去掉末尾 `/**` 后的结果
  const pairs = (fm.paths || []).flatMap(splitTopLevel).flatMap((orig) => expandPaths([orig]).map((glob) => ({ orig, glob })));
  if (!pairs.length) {
    add('warn', 'rule', rule, '没有 paths，会常驻加载：补 paths，或说明它其实是 ALWAYS');
    continue;
  }
  // `!` 开头的是 gitignore 的否定模式，只用来排除，不单独要求匹配到文件
  const positive = pairs.filter((p) => !p.glob.startsWith('!'));
  if (!positive.length) {
    add('error', 'rule', rule, 'paths 只有 `!` 开头的否定模式，匹配不到任何文件，这条 rule 永远不会加载');
    continue;
  }
  if (positive.every((p) => p.glob === '**')) {
    add('warn', 'rule', rule, 'paths 只有 "**"，Claude Code 会当作没有 paths，常驻加载：写窄，或说明它其实是 ALWAYS');
    continue;
  }
  const bodyLines = fm.body.filter((l) => l.trim()).length;
  if (bodyLines > RULE_MAX_LINES && !INDEX_RULE_RE.test(rule)) {
    add('warn', 'rule', rule, `正文 ${bodyLines} 行（上限 ${RULE_MAX_LINES}）：命中时整份加载。rule 只留做什么和一两句原因，经过、数字等扩展内容拆进 ${DOC_MARK} 文档，rule 里留「重点 + 什么时候读 + 路径」`);
  }
  const sf = scopeFiles(scope);
  const hitFiles = new Set(); // 所有 glob 一共匹配到的文件，用来认出单文件 rule
  for (const { orig, glob } of positive) {
    const label = orig === glob ? `"${glob}"` : `"${orig}"（展开后的 "${glob}"）`;
    let test;
    try {
      test = gitignoreMatcher(glob);
    } catch {
      add('error', 'rule', rule, `paths ${label} 不是合法的 glob（括号没配对？），Claude Code 会当它匹配不到任何文件`);
      continue;
    }
    const matched = sf.filter(test);
    for (const m of matched) hitFiles.add(m);
    if (!matched.length) {
      if (glob.startsWith('./')) {
        add('error', 'rule', rule, `paths ${label} 以 ./ 开头：Claude Code 按 gitignore 语义匹配，这样写匹配不到文件，去掉 ./`);
      } else if (scope && glob.replace(/^\//, '').startsWith(scope)) {
        add('error', 'rule', rule, `paths ${label} 写成了从仓库根算起的路径；包内 rule 的 glob 相对 ${scope} 写`);
      } else {
        // glob 可能指向文件本身（`*.pb.go`）或整个目录（`dist`），两种都问
        const sample = `${scope}${sampleOf(glob)}`;
        unmatched.push({ rule, label, scopeLabel, probes: [sample, `${sample}/__probe__`] });
      }
      continue;
    }
    if (isBroadPattern(glob)) {
      add('warn', 'rule', rule, `paths ${label} 过宽：一碰这个目录（或整个作用域）就全中，起不到过滤作用`);
    } else if (sf.length >= 20 && matched.length / sf.length >= 0.5) {
      add('warn', 'rule', rule, `paths ${label} 过宽：匹配了作用域里 ${matched.length}/${sf.length} 个文件，起不到过滤作用`);
    }
  }
  // 只匹配一个文件、且它能写注释：碰到文件就整条加载，和写在文件里的注释成本一样，还离代码更远。
  // 生成物和 lockfile 里写了注释也会被工具覆盖，这种单文件 rule 是对的，不报
  if (hitFiles.size === 1 && !INDEX_RULE_RE.test(rule)) {
    const [only] = hitFiles;
    if (langFor(only) && !isGenerated(`${scope}${only}`)) add('warn', 'rule', rule, `只匹配一个文件 ${scope}${only}：改写成那个文件里紧贴相关代码的注释，扩展内容进 ${DOC_MARK} 文档、注释里留指针，再删掉这条 rule（这个文件是生成物、写了注释会被工具覆盖的，保留 rule）`);
  }
}
const ignoredProbes = ignored(unmatched.flatMap((u) => u.probes));
for (const { rule, label, scopeLabel, probes } of unmatched) {
  if (probes.some((p) => ignoredProbes.has(p))) {
    add('warn', 'rule', rule, `paths ${label} 指向被 .gitignore 忽略的路径（以${scopeLabel}为基准），人工核对它与生成脚本的输出一致`);
  } else {
    add('error', 'rule', rule, `paths ${label} 匹配不到任何现存文件（以${scopeLabel}为基准）`);
  }
}

// ---------- skills ----------

for (const s of skills) {
  const text = read(s);
  if (text === null) continue;
  const fm = parseFrontmatter(text);
  if (!fm || !fm.description) add('error', 'skill', s, '缺少 description，Claude 不知道什么时候该用它');
}

// ---------- @ import ----------

for (const f of [...claudeMds, ...rules]) {
  const text = read(f);
  if (text === null) continue;
  for (const [line, i] of proseLines(text)) {
    const plain = line.replace(/`[^`]*`/g, '');
    // 只有目标文件真的存在才会被展开；`@types/node` 这类包名找不到文件，不算
    for (const m of plain.matchAll(/(?:^|\s)@([~./\w][^\s'")\]]*)/g)) {
      const ref = m[1].replace(/[.,;:!?，。；：！？、）》]+$/, '');
      if (!/[/.]/.test(ref)) continue;
      const abs = ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2))
        : path.isAbsolute(ref) ? ref
        : path.join(ROOT, path.dirname(f), ref);
      let isFile = false;
      try { isFile = fs.statSync(abs).isFile(); } catch {}
      if (isFile) add('error', 'import', f, `\`@${ref}\` 是 import，启动时会整份展开进 context；改成自然语言写路径`, i + 1);
    }
  }
}

// ---------- CLAUDE.md ----------

const claudeMdStats = [];
for (const f of claudeMds) {
  const text = read(f);
  if (text === null) continue;
  const lines = text.split(/\r?\n/);
  // 以换行结尾时 split 会多出一个空串，和 wc -l 对齐
  claudeMdStats.push({ file: f, lines: text ? lines.length - (/\n$/.test(text) ? 1 : 0) : 0 });
  for (const [line, i] of proseLines(text)) {
    // 指向文档入口的那一行是模板规定的索引行，不算带原因
    // 按完整的目录名认：`user-context-docs/README.md` 不是文档入口
    if (segmentIndex(line, ENTRY, true) === -1 && segmentIndex(line, LEGACY_ENTRY, true) === -1 &&/(因为|当初|以前|原因是|由于|\bbecause\b|\bpreviously\b)/i.test(line)) {
      add('warn', 'claude-md', f, `疑似带原因：「${line.trim().slice(0, 60)}」——CLAUDE.md 只写做什么，原因拆出来：能挂到代码上的进 rule，挂不上的进 ${DOC_MARK} 文档`, i + 1);
    }
  }
}

// ---------- 文档 ----------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const domainsWithDocs = new Map(); // `${scope}|${domain}` -> [docs]
for (const d of docs) {
  const scope = scopeOf(d, DOC_MARK);
  const rel = d.slice(scope.length + DOC_MARK.length);
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  if (segs.length > 2) add('warn', 'doc', d, `领域目录嵌套了：\`${DOC_MARK}\` 下只分一层领域目录`);
  if (/^\d{4}-\d{2}-\d{2}-/.test(name)) add('warn', 'doc', d, `文件名带日期前缀：建议改为 ${name.replace(/^\d{4}-\d{2}-\d{2}-/, '')} 并同步所有指针`);
  else if (/^\d+-/.test(name)) add('warn', 'doc', d, `文件名带编号前缀：建议改为 ${name.replace(/^\d+-/, '')} 并同步所有指针`);
  else if (!SLUG_RE.test(name)) add('warn', 'doc', d, '文件名不是英文小写短横线的 <slug>.md');
  if (segs.length >= 2) {
    const key = `${scope}|${segs[0]}`;
    if (!domainsWithDocs.has(key)) domainsWithDocs.set(key, []);
    domainsWithDocs.get(key).push(d);
  }
}

// ---------- context-docs/、.claude/rules/、.claude/skills/ 能否进 git ----------

// 两路：一是磁盘上已经存在、但被忽略的 `context-docs/`、`.claude/`（被忽略的文件不在 ls-files 里，上面的分类看不到它们）；
// 二是按根和已有 `.claude/`、`context-docs/` 的位置探一下写进去会不会被忽略。
// 旧版 `.context/` 所在的目录也算作用域：改名之后文档就落在那里的 `context-docs/`，要提前知道会不会被忽略。
// `.claude/` 下只探 rules/ 和 skills/：settings.local.json 之类本来就该被忽略。
// 目录级 CLAUDE.md 所在目录不是作用域，不探。
const scopes = new Set(['']);
const ignoredLegacyDirs = new Set(); // 被忽略的旧版文档目录：里面的文件不在 ls-files 里，下面按文件找旧目录时看不到
const checkedLegacyDirs = new Set();
// 目录里（往下两层，对应 <领域>/<slug>.md）有没有 Markdown：被忽略的 `.context/` 也可能是别的工具的缓存目录
function hasMarkdown(dir, depth = 2) {
  try {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).some((e) => (e.isFile() && e.name.endsWith('.md'))
      || (e.isDirectory() && depth > 1 && hasMarkdown(`${dir}${e.name}/`, depth - 1)));
  } catch {
    return false;
  }
}
if (IS_GIT) {
  const r = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    const segs = p.replace(/\/$/, '').split('/');
    // 只认目录：`--directory` 给出的目录带结尾的 `/`，或者是目录下的文件。被忽略的同名普通文件不算
    const legacy = segs.indexOf(LEGACY_DOC_DIR);
    if (legacy !== -1 && (legacy < segs.length - 1 || p.endsWith('/'))) {
      const dir = segs.slice(0, legacy + 1).map((x) => `${x}/`).join('');
      // 目录里的文件被逐个列出时（比如 .gitignore 写的是 `*.md`），同一个目录只查一次
      if (!checkedLegacyDirs.has(dir)) {
        checkedLegacyDirs.add(dir);
        if (!inSkipDir(dir) && hasMarkdown(dir)) ignoredLegacyDirs.add(dir);
      }
    }
    const k = segs.findIndex((x) => x === DOC_DIR || x === LEGACY_DOC_DIR || x === '.claude');
    if (k !== -1) scopes.add(segs.slice(0, k).map((x) => `${x}/`).join(''));
  }
}
// 已有 `.claude/`（哪怕只有 settings.json）、`context-docs/` 或旧版 `.context/` 的目录都当作作用域探一下
for (const f of FILES) {
  for (const marker of ['.claude/', DOC_MARK, LEGACY_MARK]) {
    const i = segmentIndex(f, marker);
    if (i !== -1) { scopes.add(f.slice(0, i)); break; }
  }
}
// 拆开写，免得脚本复制进项目后把这里当成失效指针
const PROBES = [
  { dir: DOC_MARK, probe: [DOC_DIR, '__probe__.md'].join('/'), category: 'context-dir', msg: `\`${DOC_MARK}\` 被 .gitignore 忽略了，文档进不了仓库：调整 .gitignore 后再往里写` },
  { dir: '.claude/rules/', probe: '.claude/rules/__probe__.md', category: 'claude-dir', msg: '`.claude/rules/` 被 .gitignore 忽略了：rule 进不了仓库，队友看不到，本脚本也检查不到里面的文件。调整 .gitignore（比如只忽略 `.claude/settings.local.json`）后再往里写' },
  { dir: '.claude/skills/', probe: '.claude/skills/__probe__/SKILL.md', category: 'claude-dir', msg: '`.claude/skills/` 被 .gitignore 忽略了：skill 进不了仓库，队友看不到。调整 .gitignore 后再往里写' },
];
for (const { dir, probe, category, msg } of PROBES) {
  for (const p of ignored([...scopes].map((s) => s + probe))) add('error', category, p.slice(0, -probe.length) + dir, msg);
}

// ---------- 指针：失效与孤儿 ----------

const referenced = new Set(); // 被文档以外的文件指到
const fromRule = new Set(); // 被 rule（含领域索引 rule）指到：碰到 rule 的 paths 时路径随 rule 进 context，等于已登记
const RULE_SET = new Set(rules);
const inEntry = new Set(); // 登记在文档入口里
const fromRootClaude = new Set(); // 被根 CLAUDE.md 指到
const fromCode = new Set(); // 被源码注释指到：读到那段代码时指针就在眼前，等于已登记
const fromClaudeMd = new Set(); // 被 CLAUDE.md 里某一行指到（不含个人的 CLAUDE.local.md）：那一行加载时指针就在眼前，等于已登记
// 指针只认 Claude 会读到的地方：CLAUDE.md、rule、skill、文档、文档入口，以及源码。
// 其他 Markdown（README、CHANGELOG、对外文档）里的 `context-docs/…` 多半是示例或历史记录，不算指针。
// 扩展名表里没有的非 Markdown 文件（表不可能列全所有能写注释的格式）只认里面指得到文档的路径，算作已登记；
// 指不到的不报失效、也不查写法：这类文件里的路径可能只是数据
const MD_SOURCES = new Set([...claudeMds, ...rules, ...skills, ...entries, ...docs]);
const isPointerSource = (f) => MD_SOURCES.has(f) || !MARKDOWN_RE.test(f);
// 一行是不是独立成行的注释（粗略，按常见注释前缀认）
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#|--|<!--|;|%)/;
// 源码只读含 `context-docs/`（或旧版 `.context/`）的：git 仓库里先用 git grep 筛（范围与 ls-files 一致），不用把整个仓库读进内存。
// Markdown 来源（CLAUDE.md、rule、skill、文档、入口）不多，全读：入口和文档之间的相对链接（`models/x.md`）不带目录名，grep 筛不出来
function filesMentioningContext() {
  if (IS_GIT) {
    const r = git(['grep', '-lIz', '--untracked', '-F', '-e', DOC_MARK, '-e', LEGACY_MARK]);
    if (r.status === 0 || r.status === 1) {
      return [...MD_SOURCES, ...r.stdout.split('\0').filter((f) => FILE_SET.has(f) && isPointerSource(f) && !MD_SOURCES.has(f))];
    }
  }
  return FILES.filter(isPointerSource);
}
const pointerExists = (p) => FILE_SET.has(p) || fs.existsSync(path.join(ROOT, p));
const resolvePointer = (p) => resolveWith(p, pointerExists);
// 文件 f 里的一行拆成：links（全部 Markdown 链接）、scan（抹掉链接目标的行，纯文本指针在这上面找）、found（纯文本指针）、
// docLinks（指向文档的链接，目标按 f 的目录解析，带 resolved；旧目录的另算，见 legacyLinksIn）。f 不是 Markdown 时只有纯文本指针。
// hasOwnContent、折行判断和逐行检查都要用同一行，同一个文件里每行只解析一次。defs 是 f 里引用式链接的定义，f 不是 Markdown 时为 null
function lineParser(f, defs) {
  const memo = new Map();
  return (line) => {
    let p = memo.get(line);
    if (!p) {
      const { links, scan } = splitLine(f, line, defs);
      p = { links, scan, found: pointersIn(scan), docLinks: links.filter((l) => isDocLink(l.resolved, l.target)) };
      memo.set(line, p);
    }
    return p;
  };
}
// 一行里有没有指向文档的指针：纯文本的或链接。parsed 是 lineParser 的结果
const hasPointer = (parsed) => parsed.found.length > 0 || parsed.docLinks.length > 0;
// 仓库根起的路径 p 在文件 f 里该写成的链接目标：所在文件起的相对路径。原目标的 `#锚点`、`?查询` 和尖括号照留；
// 路径是 linkPath 解码后的字，空格、`)`、`#` 这类原样写回去会弄断链接，用 escapeLinkPath 转义回去
function relTarget(f, p, target) {
  const angled = target.startsWith('<');
  const raw = angled ? target.slice(1, -1) : target;
  const fixed = escapeLinkPath(path.posix.relative(path.posix.dirname(f), p)) + (raw.match(/[#?].*$/)?.[0] ?? '');
  return angled ? `<${fixed}>` : fixed;
}
// 0.7.x 及更早的指针写的是点开头的旧目录：本脚本不再按指针检查它，目录改名后漏改的会静默失效，单独报出来
const toNewDir = (p) => {
  const i = segmentIndex(p, LEGACY_MARK);
  return i === -1 ? p : p.slice(0, i) + DOC_MARK + p.slice(i + LEGACY_MARK.length);
};
// 链接目标里的旧目录名换成新的，其余照原样写：尖括号包着的先拆开再换（`<` 后面不算路径段的开头）
const toNewDirTarget = (target) => (target.startsWith('<') ? `<${toNewDir(target.slice(1, -1))}>` : toNewDir(target));
// 紧贴中文时前面的字会被并进第一段，按旧路径或改名后的路径找得到文件时去掉。
// 返回 { raw, fixed }：找不到文件的 fixed 为 null，前面并进来的字去不掉，不给具体的新路径。
// 传进来的是抹掉链接目标的行，链接目标另由 legacyLinksIn 按所在文件的目录解析
const legacyPointersIn = (line) => {
  const out = new Map();
  for (const raw of pointersIn(line, LEGACY_POINTER_RE)) {
    const p = resolveWith(raw, (q) => pointerExists(q) || pointerExists(toNewDir(q)));
    if (!out.has(p || raw)) out.set(p || raw, p ? toNewDir(p) : null);
  }
  return [...out].map(([raw, fixed]) => ({ raw, fixed }));
};
// 链接目标里写了旧目录名的（目标里没写、只是文件本身在旧目录里的相对链接，目录整个改名后照样有效，不报）。
// 引用式用法的目标在定义行里，只在定义行报。links 是这一行解析好的链接。
// 先按所在文件的目录解析，找不到再按仓库根找：0.7.x 的规范要求链接目标也写仓库根起的路径，子目录的文件里这样写的，
// 改好的目标直接给所在文件起的相对路径，免得改了旧目录名又被报"写成了仓库根起的路径"。
// 返回 { raw, fixed, doc, link }：doc 是改名后的文档路径（存在时），fixed 是改好的链接目标
const legacyLinksIn = (f, links) => links.flatMap((l) => {
  if (l.ref) return [];
  const t = linkPath(l.target);
  if (t === null || segmentIndex(t.replace(/^\//, ''), LEGACY_MARK) === -1 || !MARKDOWN_RE.test(t)) return [];
  const renamed = (p) => (p && pointerExists(toNewDir(p)) ? toNewDir(p) : null); // 改名后的文档，存在时
  const at = (p) => (p && (renamed(p) || pointerExists(p)) ? p : null); // 改名前后有一个在就算找到
  const rel = at(l.resolved);
  const p = rel ?? at(rootPathOf(l.target));
  if (!p) return [{ raw: l.target, fixed: null, doc: null, link: true }];
  // 按所在目录找到的只换目录名；按仓库根找到的直接给所在文件起的相对路径
  return [{ raw: l.target, fixed: rel ? toNewDirTarget(l.target) : relTarget(f, toNewDir(p), l.target), doc: renamed(p), link: true }];
});
// 旧版路径的提示：改名前 hook 照样认旧路径，但目录一改名旧路径就指不到文件了，hook 也跟着认不出来
const legacyPointerMsg = (legacy) => {
  const fixes = legacy.map((x) => (x.fixed ? `${x.label ?? x.raw} → ${x.fixed}` : `${x.label ?? x.raw}（指不到文件，确认路径后把 \`${LEGACY_MARK}\` 换成 \`${DOC_MARK}\`）`));
  return `旧版路径：0.8.0 起文档目录改名为 \`${DOC_MARK}\`，改成新路径：${fixes.join('、')}。目录改名之后旧路径就指不到文件了，pointer-guard 和 doc-hook 也不再认这些指针`;
};
const stripItemMarks = (s) => s.replace(/^\s*(?:>\s*)+/, '').replace(LIST_MARK_RE, '').replace(/^\[[ xX]\]\s+/, '');
// 下面几个判断都是机械的：只看路径前面（或折行时的上一行）有没有话，不判断那句话是文档标题还是重点。
// 「[重试策略](路径)」「- 重试策略」这种只有标题的登记行认不出来，要 organize-context 读内容看：
// 标题和短结论靠字面分不开（"会话管理"和"网关会封 IP"），猜错了会让人去改一行本来正确的登记行
const CONSTRAINT_RE = /必须|务必|不能|不可|不要|不许|不得|禁止|只能|最多|最少|至多|至少|上限|下限|超过|\b(?:must|never|always|at most|at least|do not|don't|cannot|can't)\b/i;
const NUMBER_RE = /(?<![A-Za-z\d/_-])\d/; // "5 次""上限 3"；v2、OAuth2、HTTP/2 这类名字里的不算
// 引出登记行的话（"api 相关的项目文档，改动前按需读："）：提到文档、本身不带结论（约束词、数字）。
// 按"提到文档"来认，不按"以冒号结尾"来认："网关连续失败会封 IP，细节："这种结论也以冒号结尾
const DOC_WORD_RE = /文档|资料|参考|详见|背景|\b(?:docs?|documents?|documentation|references?|see also|background)\b/i;
// "以下 2 份文档""3 docs" 数的是文档本身，不是结论里的数字
const DOC_COUNT_RE = /\d+\s*(?:份|篇)|\d+\s*(?:个|条|项)(?=[^，。；：,;:]{0,6}(?:文档|资料|参考))|\b\d+\s+(?:docs?|documents?|references?)\b/gi;
const introducesDocs = (t) => DOC_WORD_RE.test(t) && !CONSTRAINT_RE.test(t) && !NUMBER_RE.test(t.replace(DOC_COUNT_RE, ''));
// 标题、表格行、HTML 注释，以及以冒号或"按需读"结尾的引言：不是重点，也不是折行登记行的上半句
function isLead(line) {
  const t = line.trim();
  return /^(?:[#|]|<!--)/.test(t) || (/(?:[：:]|按需读[。.]?)$/.test(t) && introducesDocs(t));
}
// 顶格写、只是提到文档的话（"api 相关的项目文档。改动前先看有没有相关的。"）：没以冒号结尾的引言
const mentionsDocsOnly = (line) => /^\S/.test(line) && !LIST_MARK_RE.test(line) && introducesDocs(line.trim());
// 一段文字去掉标点、符号、emoji 之后剩下的字。什么都不剩，或只剩"见""文档"这类不带信息的引导词，等于没有话
const wordsOf = (s) => s.replace(/[^\p{L}\p{N}]/gu, '');
const LEAD_IN_RE = /^(?:详见|参见|参考|见|文档|链接|这里|seealso|see|referto|docs?|link|here)?$/i;
// 登记行是不是路径打头：路径前面只剩列表符号、引号、表格竖线、箭头这类标记，或者只有"见""文档："这类引导词。
// 路径前面有别的话（含链接文字、加粗）就不算，那句话是标题还是重点脚本不判断。
// 路径前面紧贴着中文（resolvePointer 去掉了前缀才找到文件）说明前面有话，不算。
// 指向另一个文档入口的行也不算：入口是清单，不是文档，没有重点可提
function pathFirst(line, raw) {
  if (ENTRY_RE.test(raw)) return false;
  return LEAD_IN_RE.test(wordsOf(stripItemMarks(line.slice(0, line.indexOf(raw))))) && resolvePointer(raw) === raw;
}
// 链接打头的登记行同理：链接文字只是路径、文件名（`[x.md](…)`）或"文档"这类引导词时算路径打头；链接文字是标题时前面有话，不算。
// 只去掉文字里的路径、文件名（路径段可以是中文，和指针的口径一致），"重试策略 retry-policy.md"这种标题加文件名的照样算有话
const LINK_TEXT_PATH_RE = /[\p{L}\p{N}_./-]*\.(?:md|mdx|markdown)(?![\p{L}\p{N}_])/giu;
function linkFirst(line, link) {
  if (link.resolved && ENTRY_RE.test(link.resolved)) return false;
  const text = link.text.replace(/`/g, '').replace(LINK_TEXT_PATH_RE, '');
  return LEAD_IN_RE.test(wordsOf(stripItemMarks(line.slice(0, link.index)) + text));
}
// 折行的登记行，上一行是不是它的上半句（重点，或纯参考的"什么时候读"）：有话，而且不是标题、表格行、引言
function carriesHead(prev) {
  return !LEAD_IN_RE.test(wordsOf(stripItemMarks(prev))) && !isLead(prev) && !mentionsDocsOnly(prev);
}
// rule 正文里除了指针行、标题和引出登记行的话，还有没有别的话。有的话重点可能写在那里，路径打头的指针行不报。
// 登记行折到下一行的后半句（缩进、不是新的列表项，紧跟在带指针的行后面）是那一行的一部分，不算。
// 顶格写、只是提到文档的话，后面紧跟着登记行（中间可以隔空行）时是引言，不算；后面是别的话时算正文。
// 表格只有表头和分隔行不算，不带指针的数据行是正文；分隔线（---）不算。代码块是正文：rule 里的代码示例就是"怎么做"
const TABLE_SEP_RE = /^(?=.*\|)\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
function hasOwnContent(text, parse) {
  const fm = parseFrontmatter(text);
  const lines = fm ? fm.body : text.split(/\r?\n/);
  let afterPointer = false;
  return lines.some((l, i) => {
    const t = l.trim();
    if (!t || HR_LINE_RE.test(t)) { afterPointer = false; return false; }
    if (hasPointer(parse(l))) { afterPointer = true; return false; }
    afterPointer = afterPointer && /^\s/.test(l) && !LIST_MARK_RE.test(l);
    if (afterPointer) return false;
    if (t.startsWith('|')) return !TABLE_SEP_RE.test(t) && !TABLE_SEP_RE.test((lines[i + 1] || '').trim());
    if (!mentionsDocsOnly(l)) return carriesHead(l);
    const next = lines.slice(i + 1).find((x) => x.trim());
    return !(next && hasPointer(parse(next)));
  });
}
for (const f of filesMentioningContext()) {
  const isMd = MD_SOURCES.has(f);
  const text = isMd ? read(f) : readRaw(f);
  const hasLegacy = !!text && text.includes(LEGACY_MARK);
  if (!text || (!hasLegacy && !text.includes(DOC_MARK) && !(isMd && /\]\(|\]:/.test(text)))) continue;
  const fromDoc = DOC_RE.test(f) && !ENTRY_RE.test(f);
  const isEntry = ENTRY_RE.test(f);
  const isRootClaude = ROOT_CLAUDE_MD.has(f);
  const isRule = RULE_SET.has(f);
  const isCode = !isMd;
  const isClaudeMd = CLAUDE_MD_RE.test(f) && !/\.local\.md$/.test(f);
  // Markdown 代码块里的是示例，不算指针
  const prose = proseLines(text, !isMd);
  // 源码里只有注释里的才是写给人看的指针，和 pointer-guard 认注释用同一套口径。字符串里的路径（输出文件名、测试数据）
  // 指得到文档的照样算已登记，指不到的不报失效、也不查写法
  const known = isMd || langFor(f) !== null; // 失效指针和写法只在认得的文件里查
  const cm = isCode && known ? commentLines(text.split(/\r?\n/)).comment : null;
  // 文档入口和领域索引 rule 的每一行都是登记行；别的 rule 只在正文除了指针没有别的话时才查
  const parse = lineParser(f, isMd ? linkDefs(text, prose) : null);
  const bareLines = isEntry || (isRule && (INDEX_RULE_RE.test(f) || !hasOwnContent(text, parse)));
  const register = (p) => {
    if (!fromDoc) referenced.add(p);
    if (isEntry) inEntry.add(p);
    if (isRootClaude) fromRootClaude.add(p);
    if (isRule) fromRule.add(p);
    if (isCode) fromCode.add(p);
    if (isClaudeMd) fromClaudeMd.add(p);
  };
  // 第三方、构建产物目录里的旧指针不是这个仓库写的，和旧目录一样不要求改
  const warnLegacy = known && !inSkipDir(f);
  prose.forEach(([line, i], k) => {
    // Markdown 里纯文本路径按仓库根解析、链接目标按所在文件的目录解析，分开找：先把链接目标抹掉，纯文本的正则就看不到它
    const { links: allLinks, scan, found, docLinks: links } = parse(line);
    const legacy = hasLegacy ? legacyPointersIn(scan) : [];
    // 目录已经改名、只是指针漏改的，按新路径登记：同一份文档不再另报孤儿、缺索引，只报下面这条旧版路径
    for (const x of legacy) if (x.fixed && pointerExists(x.fixed)) register(x.fixed);
    const legacyLinks = hasLegacy && isMd ? legacyLinksIn(f, allLinks) : [];
    for (const x of legacyLinks) if (x.doc) register(x.doc);
    // 链接文字和链接目标写的是同一个旧路径、改法也一样时只列一次，取给得出新路径的那条。
    // 改法不一样（子目录里文字从仓库根写，目标要改成相对路径）时两条都列，目标那条注明是链接目标
    const stale = [];
    if (warnLegacy) {
      for (const x of [...legacy.filter((y) => isMd || inComment(line, i, cm, y.raw)), ...legacyLinks]) {
        const dup = stale.findIndex((y) => y.raw === x.raw && (!y.fixed || !x.fixed || y.fixed === x.fixed));
        if (dup === -1) stale.push(x);
        else if (!stale[dup].fixed && x.fixed) stale[dup] = x;
      }
      for (const x of stale) if (x.link && stale.some((y) => y !== x && y.raw === x.raw)) x.label = `链接目标 ${x.raw}`;
    }
    if (stale.length) add('warn', 'pointer', f, legacyPointerMsg(stale), i + 1);
    if (!found.length && !links.length) return;
    // 引用式链接的定义行（`[id]: 目标`）只是目标，重点和什么时候读写在用到它的那一行，写法不查，只查目标在不在
    const defOnly = !found.length && links.every((l) => l.def);
    const strict = known && (isMd || inComment(line, i, cm, found[0]));
    // 只删指针路径本身：中文正文和路径之间往往没有空格，按"删到下一个空白为止"会把后面的触发条件一起删掉
    let own = scan;
    for (const raw of found) own = own.split(raw).join('');
    // 指针折行时"什么时候读"可能写在上一行。上一行自己带指针、这一行是新的列表项、或（源码里）上一行不是注释时，
    // 上一行是另一回事，不借它的：代码行里的 `if` 之类会被当成触发条件
    const prev = k > 0 ? prose[k - 1][0] : '';
    const separate = isMd ? LIST_MARK_RE.test(line) : !(cm && k > 0 && cm[prose[k - 1][1]]);
    const folded = !separate && !hasPointer(parse(prev)); // 这一行接着上一行写
    const near = folded ? `${prev}\n${own}` : own;
    // 折行的登记行，重点在上一行时，路径打头不算没写重点
    const headAbove = folded && carriesHead(prev);
    if (!defOnly && strict && !fromDoc && !TRIGGER_RE.test(near)) {
      add('info', 'pointer-style', f, '指针没写什么时候读：改成「重点 + 什么时候读 + 路径」，比如"改重试次数前读 …"，Claude 才判断得了要不要读', i + 1);
    } else if (!defOnly && bareLines && !headAbove && (links.length && (!found.length || links[0].index < scan.indexOf(found[0]))
      ? linkFirst(line, links[0])
      : pathFirst(scan, found[0]))) {
      add('info', 'pointer-style', f, '登记行以路径开头，路径前面没有重点：只有路径和什么时候读的行进了 context 等于什么都没给，Claude 要读完整份文档才拿得到重点。把文档里不知道就会做错的结论写在路径前面（「重点 + 什么时候读 + 路径」），已经写在路径后面的挪到前面；文档里没有这类结论的，改成以"什么时候读"开头', i + 1);
    }
    for (const raw of found) {
      const p = resolvePointer(raw);
      if (p) register(p);
      else if (strict) {
        // 写在链接文字里的，多半是照着相对的链接目标抄的：点得开的链接被报失效，要说清楚是文字要改、改成什么
        const l = allLinks.find((x) => pointersIn(x.text).includes(raw));
        const to = l?.resolved;
        add('error', 'pointer', f, l
          ? `链接文字里的路径 ${raw} 指不到文件：链接文字里写的路径按纯文本算，从仓库根写起${to && pointerExists(to) ? `，这条链接指向的是 ${to}，文字改成它` : ''}`
          : `指针指向不存在的文件 ${raw}（纯文本指针写仓库根起的路径；Markdown 链接的目标另按所在文件的目录解析）`, i + 1);
      }
    }
    for (const l of links) {
      const doc = linkedFile(l, pointerExists);
      if (doc && doc === l.resolved) {
        register(l.resolved);
        // 链接文字里也写了路径的，两边要指向同一份文档：改了一边忘了另一边，点开的和 grep 到的就不是一份了
        for (const raw of pointersIn(l.text)) {
          const p = resolvePointer(raw);
          if (p && p !== l.resolved) add('error', 'pointer', f, `链接文字写的 ${raw} 和链接目标 ${l.target}（解析为 ${l.resolved}）不是同一份文档：两边改成一致`, i + 1);
        }
        continue;
      }
      // 写成仓库根起的路径的，按仓库根找得到的那份文档照样登记：同一份文档不再另报孤儿、缺索引，只报下面这条写法错误
      if (doc) register(doc);
      if (!strict || l.ref) continue; // 引用式用法的目标失效在定义行报，不在每个用到它的地方重复报
      add('error', 'pointer', f, doc
        ? `链接目标 ${l.target} 写成了仓库根起的路径：Markdown 链接按所在文件的目录解析，现在点开是 404。改成 ${relTarget(f, doc, l.target)}`
        : `链接指向不存在的文件 ${l.target}（Markdown 链接的目标按所在文件的目录解析，开头是 / 的按仓库根解析）`, i + 1);
    }
  });
}
for (const d of docs) {
  if (!referenced.has(d)) add('warn', 'orphan', d, `孤儿文档：没有登记在任何入口，也没有被 rule、CLAUDE.md 或代码指到，不会被读到。能挂到代码上的先看能不能并回原处，不能就在相关代码的注释或 rule 里留指针、或登记进领域索引 rule；挂不到的登记进 ${ENTRY}`);
}
for (const e of entries) {
  if (!fromRootClaude.has(e)) add('warn', 'entry', e, '文档入口没被根 CLAUDE.md 指到：挂不到代码上的文档在做新需求时不会被看到；在根 CLAUDE.md「更多上下文」里写上这个路径');
}

// ---------- 领域索引 ----------

for (const [key, list] of domainsWithDocs) {
  const [scope, domain] = key.split('|');
  const idx = `${scope}.claude/rules/${domain}/context-index.md`;
  if (FILE_SET.has(idx)) continue;
  // 已被 rule、代码注释或 CLAUDE.md 里某一行指到的文档，那条 rule、那段代码、那一行进 context 时就会被带出来，不要求另建索引 rule
  const unindexed = list.filter((d) => !inEntry.has(d) && !fromRule.has(d) && !fromCode.has(d) && !fromClaudeMd.has(d));
  if (unindexed.length) add('warn', 'index', unindexed[0], `领域 ${domain} 有 ${unindexed.length} 份文档没登记在 ${ENTRY}、没被任何 rule、CLAUDE.md 或代码注释指到，也没有索引 rule ${idx}：碰到相关代码时不会被带出来（挂不到代码上的应登记进 ${ENTRY}）`);
}

// ---------- 放错地方的文档 ----------

const CLAUDE_OWN = /(^|\/)\.claude\/(rules|skills|commands|agents|output-styles|hooks)\//;
// 0.7.x 及更早的文档目录是点开头的，rg / Grep 默认跳过：每个作用域报一次，整个目录改名。
// 旧目录里的文件只报这一条，不再按 `.claude/`、类型目录另报：整个目录改名之后再按新位置检查
const legacyDirs = new Set();
for (const f of FILES) {
  if (!f.endsWith('.md')) continue;
  const legacy = segmentIndex(f, LEGACY_MARK);
  if (legacy !== -1) {
    const dir = f.slice(0, legacy + LEGACY_MARK.length);
    if (!inSkipDir(dir)) legacyDirs.add(dir);
    continue;
  }
  if (CLAUDE_MD_RE.test(f)) continue;
  if (/(^|\/)\.claude\//.test(f) && !CLAUDE_OWN.test(f)) {
    add('warn', 'misplaced', f, `文档放在 \`.claude/\` 下：迁到所属作用域的 \`${DOC_MARK}<领域>/<slug>.md\``);
  } else if (!DOC_RE.test(f) && /(^|\/)(context\/(decisions|data)|decisions|adrs?)\//.test(f) && !/(^|\/)node_modules\//.test(f)) {
    add('info', 'misplaced', f, `疑似按类型分的文档目录（旧版 context/decisions 之类）：确认是文档后迁到 \`${DOC_MARK}<领域>/<slug>.md\``);
  }
}
for (const d of legacyDirs) {
  add('warn', 'misplaced', d, `旧版文档目录：0.8.0 起改名为 \`${d.slice(0, -LEGACY_MARK.length)}${DOC_MARK}\`（点开头的目录 rg、Grep 默认不搜）。用 git mv 整个改名，再把整个仓库里指向旧路径的指针一并改掉`);
}
for (const d of ignoredLegacyDirs) {
  if (legacyDirs.has(d)) continue;
  add('warn', 'misplaced', d, `旧版文档目录，而且被 .gitignore 忽略了：0.8.0 起改名为 \`${d.slice(0, -LEGACY_MARK.length)}${DOC_MARK}\`。里面的文档要进仓库的话，改名后调整 .gitignore 让新目录能进 git，再把整个仓库里指向旧路径的指针一并改掉；是不是只当本地草稿，交给用户决定`);
}

// ---------- 注释候选 ----------

if (WANT_COMMENTS) {
  for (const f of FILES) {
    if (!inScope(f) || !langFor(f) || NOT_CODE_DIR_RE.test(f) || inSkipDir(f)) continue;
    const text = readRaw(f);
    if (!text) continue;
    const { blocks, signals } = analyzeComments(text, f);
    for (const b of blocks) {
      add('info', 'comment-block', f, `${b.lines} 行的注释块（第 ${b.start}–${b.end} 行）`, b.start);
    }
    // 已经是「重点 + 指针」的短注释（3 行以内、指得到文档）不用再搬：重点里常带数字和"坑""注意"，每次都会命中信号词
    const fileLines = text.split(/\r?\n/);
    const isPointerComment = (n) => {
      let a = n - 1;
      let b = n - 1;
      while (a > 0 && COMMENT_LINE_RE.test(fileLines[a - 1])) a--;
      while (b + 1 < fileLines.length && COMMENT_LINE_RE.test(fileLines[b + 1])) b++;
      if (b - a + 1 > 3) return false;
      return fileLines.slice(a, b + 1).some((l) => pointersIn(l).some((raw) => resolvePointer(raw)));
    };
    const sig = signals.filter((s) => !isPointerComment(s.line));
    if (sig.length) {
      const lines = sig.map((s) => s.line);
      add('info', 'comment-signal', f, `带信号词的注释 ${sig.length} 处：第 ${lines.slice(0, 15).join('、')}${lines.length > 15 ? ' …' : ''} 行`, lines[0]);
    }
  }
}

// ---------- 输出 ----------

const order = { error: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
const counts = { error: 0, warn: 0, info: 0 };
for (const f of findings) counts[f.level]++;

if (WANT_JSON) {
  console.log(JSON.stringify({ root: ROOT, filter: FILTER || null, claudeMd: claudeMdStats, findings, counts }, null, 2));
} else {
  const label = { error: '错误', warn: '警告', info: '提示' };
  console.log(`context-keeper check：${ROOT}${FILTER ? `（只看 ${FILTER}）` : ''}`);
  const stats = claudeMdStats.filter((s) => inScope(s.file));
  if (stats.length) console.log(`CLAUDE.md 行数：${stats.map((s) => `${s.file} ${s.lines}`).join('；')}`);
  console.log('');
  for (const f of findings) {
    console.log(`[${label[f.level]}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.msg}`);
  }
  if (findings.length) console.log('');
  console.log(`错误 ${counts.error}，警告 ${counts.warn}，提示 ${counts.info}`);
}
// 不用 process.exit：macOS 上 stdout 是管道时写入是异步的，直接退出会截断超过管道缓冲（64KB）的输出
process.exitCode = counts.error ? 1 : 0;
