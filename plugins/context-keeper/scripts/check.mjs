#!/usr/bin/env node
// context-keeper 结构检查：把规范里能确定性校验的部分交给脚本，模型只处理需要判断的部分。
// 无第三方依赖。复制进项目接 CI 时连同 lib/ 目录一起复制。
//
// 用法：node check.mjs [路径] [--comments] [--json]
//   路径        只报告该路径下文件的问题（默认整个仓库）。相对当前目录找不到时，按仓库根起的路径再找一次；
//               路径在别的 git 仓库里、或在当前仓库外面的普通目录里时，检查那个仓库或目录
//   --comments  额外扫描源码里的长注释块和带信号词的注释，作为整理候选（认得出是生成物的文件不扫）
//   --json      输出 JSON
// 有「错误」级问题时退出码为 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeComments, langFor, scanSource } from './lib/comments.mjs';
import {
  AGENT_MD_RE, CLAUDE_MD_RE, INDEX_RULE_RE, LEGACY_DOC_DIRS, LOCAL_MD_RE, MARKDOWN_RE, NOT_CODE_DIR_RE, RULE_RE, SKILL_MD_RE, SKILL_RE,
  proseLines, segmentIndex, segmentIndexes,
} from './lib/markdown.mjs';

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
// 路径参数在别的 git 仓库里时（比如在插件目录里跑、检查另一个项目），按那个路径所在的仓库检查；
// 在当前仓库（不是 git 仓库时是当前目录）外面、又不在任何 git 仓库里时，把那个目录当作一个不是 git 仓库的项目来查
const toplevel = (cwd) => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
// 只解析所在目录的符号链接，路径本身是软链接时不跟过去：仓库里指向外面的软链接，算仓库里的
const lexicalOf = (abs) => path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
const isOutside = (root, p) => {
  const rel = path.relative(root, p);
  return rel.startsWith('..') || path.isAbsolute(rel);
};
let top = toplevel(ROOT);
if (target) {
  const abs = path.resolve(ROOT, target);
  if (fs.existsSync(abs)) {
    const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    const other = toplevel(dir);
    if (other.status === 0) top = other;
    else if (isOutside(top.status === 0 ? top.stdout.trim() : fs.realpathSync(ROOT), lexicalOf(abs))) {
      top = other;
      ROOT = fs.realpathSync(dir);
    }
  }
}
const IS_GIT = top.status === 0;
if (IS_GIT) ROOT = top.stdout.trim();

// 不是 git 仓库时遍历要跳过的目录：没有 .gitignore 可问，构建产物和第三方代码只能按名字认
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target', 'vendor']);
// 进了 git 也不算这个仓库自己的：第三方代码。`build/`、`dist/`、`target/` 这类名字进了 git 的多半是真的包或目录，照常检查
const THIRD_PARTY_DIRS = new Set(['node_modules', 'vendor']);
const isThirdParty = (f) => f.split('/').some((s) => THIRD_PARTY_DIRS.has(s));

// files：仓库里的文件（不含被忽略的）；tracked：其中已经进了 git 索引的，用来判断 CLAUDE.local.md 是没被忽略还是已经提交了
function listFiles() {
  const tracked = new Set();
  if (IS_GIT) {
    // -t 给每个路径加状态前缀：`? ` 是未跟踪的，其余（H、S、M…）都在索引里
    const r = git(['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard']);
    const all = new Set();
    for (const e of r.stdout.split('\0')) {
      if (e.length < 3) continue;
      const f = e.slice(2);
      all.add(f);
      if (e[0] !== '?') tracked.add(f);
    }
    return { files: [...all].filter((f) => fs.existsSync(path.join(ROOT, f))), tracked };
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
  return { files: out, tracked };
}

const { files: LISTED, tracked: TRACKED } = listFiles();
const FILES = LISTED.sort();
const FILE_SET = new Set(FILES);
// 这个仓库自己的文件：所有检查都只看它们。FILES 只在算 rule 的 glob 匹配到哪些文件时用（rule 可以指向第三方目录里的文件）
const OWN = FILES.filter((f) => !isThirdParty(f));

let FILTER = '';
if (target) {
  let abs = path.resolve(process.cwd(), target);
  // 规范里的路径都从仓库根写起：在子目录里跑（比如在包目录里启动的会话）、按当前目录找不到时，再按仓库根解析一次
  if (!fs.existsSync(abs) && !path.isAbsolute(target) && fs.existsSync(path.join(ROOT, target))) abs = path.join(ROOT, target);
  // git 给的仓库根是解析过符号链接的（macOS 的 /tmp → /private/tmp），路径也要解析，否则算出来的相对路径以 .. 开头
  // 先只解析所在目录：路径本身是仓库里的软链接时按链接所在的位置算，不跟到链接指向的地方；
  // 这样算出来在仓库外（路径是指向仓库或仓库里某处的软链接）时，再整条解析
  if (fs.existsSync(abs)) {
    const lexical = lexicalOf(abs);
    abs = isOutside(ROOT, lexical) ? fs.realpathSync(abs) : lexical;
  }
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
// read(f) 的正文行（proseLines）：几项检查都要逐行过同一份文件，只解析一次。读不了的返回 null
const proseCache = new Map();
function prose(f) {
  if (!proseCache.has(f)) {
    const text = read(f);
    proseCache.set(f, text === null ? null : proseLines(text));
  }
  return proseCache.get(f);
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
// 挂在目录上的发现：路径参数落在这个目录里面（只看其中一个领域）时也要报
const addDir = (level, category, dir, msg) => {
  if (inScope(dir) || FILTER.startsWith(dir)) findings.push({ level, category, file: dir, line: undefined, msg });
};

// ---------- 分类 ----------

const RULE_MAX_LINES = 10;
// 一条 rule 的 paths 超过 10 项，基本都是把几组「改 A 同步 B」攒成了一张表：每个文件只需要知道和自己相关的一两行
const RULE_MAX_PATHS = 10;
const EMPHASIS_MAX = 2;
const ruleBodyLines = new Map(); // rule -> 正文行数（不算 frontmatter 和空行），规模汇总用

// rule 正文里 ⚠ 和加粗的处数，代码块和行内代码里的不算。
// 紧贴 `/` 的 `**` 是没包反引号的 glob（`src/**/foo`），不是加粗的标记
function emphasisCount(body) {
  let n = 0;
  for (const [line] of proseLines(body)) {
    const plain = line.replace(/`[^`]*`/g, '').replace(/\/\*\*|\*\*\//g, '/');
    n += (plain.match(/⚠/g) || []).length + (plain.match(/\*\*[^*\n]+?\*\*/g) || []).length;
  }
  return n;
}

// s 里第一个作为路径段开头出现的旧版文档目录，返回 [位置, 目录名]，没有返回 null。
// s 是文件路径时按完整的目录名认；loose 为 true 时 s 是一行正文（见 segmentIndex）
function firstLegacy(s, loose = false) {
  let best = null;
  for (const d of LEGACY_DOC_DIRS) {
    const i = segmentIndex(s, `${d}/`, loose);
    if (i !== -1 && (!best || i < best[0])) best = [i, d];
  }
  return best;
}
// 文件所在的旧版文档目录（带结尾的 /），不在旧版文档目录里返回 null
function legacyDirOf(f) {
  const hit = firstLegacy(f);
  return hit ? f.slice(0, hit[0] + hit[1].length + 1) : null;
}

const rules = OWN.filter((f) => RULE_RE.test(f) && !legacyDirOf(f));
const isLocalMd = (f) => LOCAL_MD_RE.test(f);
// 被 .gitignore 正确忽略的 CLAUDE.local.md 不在 FILES 里，单独列出来，否则体检时看不到里面只留本机的内容。
// --directory：整个被忽略的目录（dist/、node_modules/、别的 worktree）只给出目录名、不往里走，里面的不算这份 checkout 的
function ignoredLocalMds() {
  if (!IS_GIT) return [];
  const r = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', '*CLAUDE.local.md']);
  return r.stdout.split('\0').filter((f) => isLocalMd(f) && !isThirdParty(f) && fs.existsSync(path.join(ROOT, f)));
}
const listedLocal = new Set(OWN.filter(isLocalMd));
const claudeMds = [...OWN.filter((f) => CLAUDE_MD_RE.test(f)), ...ignoredLocalMds()].filter((f) => !legacyDirOf(f)).sort();
const skills = OWN.filter((f) => SKILL_RE.test(f));
const skillMds = OWN.filter((f) => SKILL_MD_RE.test(f));

// marker 作为完整的目录名出现的第一个位置：`.claude/rules/` 前面的部分是作用域
const scopeOf = (f, marker) => f.slice(0, segmentIndex(f, marker));
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
// text 是调用方已经读好的内容，没传就自己读
function isGenerated(f, text) {
  if (GENERATED_PATH_RE.test(f)) return true;
  const head = text ?? readRaw(f);
  return !!head && GENERATED_HEAD_RE.test(head.split(/\r?\n/, 5).join('\n'));
}

// ---------- rules ----------

const unmatched = []; // 匹配不到文件、要问 git 是否指向被忽略路径的 glob，最后一次性查
for (const rule of rules) {
  const text = read(rule);
  if (text === null) continue;
  const scope = scopeOf(rule, '.claude/rules/');
  const scopeLabel = scope || '仓库根';
  const fm = parseFrontmatter(text);
  const body = fm ? fm.body : text.split(/\r?\n/);
  // 规模汇总、正文长度和强调都在任何 continue 之前算：没有 paths、会常驻的 rule 成本最高，不能漏
  const bodyLines = body.filter((l) => l.trim()).length;
  ruleBodyLines.set(rule, bodyLines);
  if (INDEX_RULE_RE.test(rule)) {
    add('warn', 'legacy', rule, '旧版领域索引 rule：0.10.0 起不再有项目文档，也不再登记文档。每一行的重点按准入门槛重过，过了的放到该放的地方（窄 rule、某处注释或包级 CLAUDE.md），然后删掉这条 rule（跑 /context-keeper:organize-context）');
    continue;
  }
  if (bodyLines > RULE_MAX_LINES) {
    add('warn', 'rule', rule, `正文 ${bodyLines} 行（上限 ${RULE_MAX_LINES}）：命中时整份加载。先删经过、状态、数字表和没过准入门槛的行；还写不下，按「谁需要知道」拆成几条窄 rule 或几处注释，流程写成 skill。不要挪到别的文件里`);
  }
  const emphasis = emphasisCount(body.join('\n'));
  if (emphasis > EMPHASIS_MAX) {
    add('info', 'prune-emphasis', rule, `强调 ${emphasis} 处（⚠ 和加粗，上限 ${EMPHASIS_MAX}）：处处都强调，等于哪处都不突出。只给最容易做错的那一处留着，其余降回普通文字`);
  }
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
  // 按逗号切开、不展开花括号数项数：`*.{ts,tsx}` 是一项
  const pathItems = new Set(positive.map((p) => p.orig)).size;
  if (pathItems > RULE_MAX_PATHS) {
    add('warn', 'prune-wide-rule', rule, `paths 有 ${pathItems} 项（超过 ${RULE_MAX_PATHS}）：碰到其中任何一个文件，整条都跟着进来，大半行和手上的任务无关。按「谁需要知道」拆窄，没过准入门槛的行删掉`);
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
  if (hitFiles.size === 1) {
    const [only] = hitFiles;
    if (langFor(only) && !isGenerated(`${scope}${only}`)) add('warn', 'rule', rule, `只匹配一个文件 ${scope}${only}：改写成那个文件里紧贴相关代码的注释，再删掉这条 rule（这个文件是生成物、写了注释会被工具覆盖的，保留 rule）`);
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
  for (const [line, i] of prose(f) || []) {
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

// ---------- 指向旧版文档目录的行 ----------

const mentionsLegacy = (line) => firstLegacy(line, true) !== null;
// 一行里每一处旧版文档目录出现的位置（作为路径段的开头）
const legacyPositions = (line) => LEGACY_DOC_DIRS.flatMap((d) => segmentIndexes(line, `${d}/`, true));
// Markdown 文件 f 的正文里提到旧版文档目录的行（0 起的下标）。带原因、叙述形态、旧版指针三项检查共用，每个文件只算一次
const legacyLineCache = new Map();
function legacyLines(f) {
  if (!legacyLineCache.has(f)) legacyLineCache.set(f, new Set((prose(f) || []).filter(([line]) => mentionsLegacy(line)).map(([, i]) => i)));
  return legacyLineCache.get(f);
}

// ---------- CLAUDE.md ----------

// 两个字的词容易是别的词的一部分，常见的排除掉：「以前缀开头」「以前端为准」「当初始化完成」
const BEFORE = '以前(?![缀置者端])';
const REASON_RE = new RegExp(String.raw`(因为|当初(?!始)|${BEFORE}|原因是|由于|\bbecause\b|\bpreviously\b)`, 'i');
const lineList = (nums) => `第 ${nums.slice(0, 15).join('、')}${nums.length > 15 ? ' …' : ''} 行`;
const claudeMdStats = [];
const reasonLines = new Map(); // CLAUDE.md -> 已报带原因的行（下标），叙述形态不再重复报
for (const f of claudeMds) {
  const text = read(f);
  if (text === null) continue;
  const lines = text.split(/\r?\n/);
  // 以换行结尾时 split 会多出一个空串，和 wc -l 对齐
  claudeMdStats.push({ file: f, lines: text ? lines.length - (/\n$/.test(text) ? 1 : 0) : 0 });
  // CLAUDE.local.md 是用户选了只留本机的内容，「移进 rule 或注释」等于把它公开，不报
  if (isLocalMd(f)) continue;
  const seen = new Set();
  reasonLines.set(f, seen);
  const legacy = legacyLines(f);
  for (const [line, i] of prose(f)) {
    // 指向旧版文档的行另报「旧版指针」
    if (legacy.has(i) || !REASON_RE.test(line)) continue;
    seen.add(i);
    add('warn', 'claude-md', f, `疑似带原因：「${line.trim().slice(0, 60)}」——CLAUDE.md 一条一行，只写做什么。原因过不了准入门槛的删掉；能挂到代码上的整条移进 rule 或注释`, i + 1);
  }
}

// CLAUDE.local.md 是只留本机的文件（不打算公开的业务方向、个人设置）。没被忽略的未跟踪文件和已经提交的文件都在 ls-files 里：
// 已提交的再加 .gitignore 也没用，要分开提示。已提交的报错误：CI 的 checkout 里只看得到这一种，要能拦下 PR
if (IS_GIT) {
  for (const f of claudeMds.filter((x) => listedLocal.has(x))) {
    const committed = TRACKED.has(f);
    add(committed ? 'error' : 'warn', 'local-not-ignored', f, committed
      ? 'CLAUDE.local.md 已经提交进了仓库：它只该留在本机，里面常有不打算公开的内容（竞品、经营策略）。`git rm --cached` 把它移出仓库（文件留在本机），.gitignore 里还没有 `CLAUDE.local.md` 的补上一行；git 历史里仍看得到，要不要改写历史由用户定'
      : 'CLAUDE.local.md 没被 .gitignore 忽略：它只该留在本机，里面常有不打算公开的内容（竞品、经营策略），一提交就进了仓库。在 .gitignore 里加一行 `CLAUDE.local.md`');
  }
}

// ---------- 修剪候选：叙述形态 ----------
// 带完整日期、状态词、叙述词的行，多半在讲发生过什么，不是一条结论。只标年月的观测日期（「2026-11 实测」）不算。
// 机械匹配，只作候选。叙述词是别的词的一部分的常见情况排除掉（「当时间超过」「统一度量」「修改回调」「还原本地」
// 「登录后来自」），排除不尽的由人判断

const NARRATIVE_RE = new RegExp([
  String.raw`(?<![\d-])20\d{2}-\d{2}-\d{2}(?!\d)`,
  '已上线', '尚未上线', '未部署', '待上线', '已部署', '待办',
  BEFORE, '曾经', '(?<![然之以稍随])后来(?!自)', '(?<![适恰妥])当时(?![间刻钟区])', '(?<![统单同])一度(?!量)',
  '起初', '(?<![还复])原本', '最初', '改回(?![调复车滚退])',
].join('|'));
const narrativeSources = [
  ...claudeMds.filter((f) => !isLocalMd(f)),
  ...rules.filter((f) => !INDEX_RULE_RE.test(f)),
  ...skillMds,
];
for (const f of narrativeSources) {
  if (!inScope(f)) continue;
  const skip = reasonLines.get(f) || new Set();
  const legacy = legacyLines(f);
  const hits = [];
  for (const [line, i] of prose(f) || []) {
    if (skip.has(i) || legacy.has(i)) continue;
    if (NARRATIVE_RE.test(line.replace(/`[^`]*`/g, ''))) hits.push(i + 1);
  }
  if (hits.length) {
    add('info', 'prune-narrative', f, `叙述形态：${hits.length} 行像是在讲经过或状态（完整日期、「已上线」「以前」「后来」这类词）：${lineList(hits)}。只留结论和最多一句理由，经过和状态删掉`, hits[0]);
  }
}

// ---------- 作用域 ----------
// 仓库根，以及所有有 `.claude/` 或旧版文档目录的目录。被忽略的文件不在 ls-files 里，另外问一次 git

const scopes = new Set(['']);
const ignoredLegacyDirs = new Set(); // 被忽略的旧版文档目录：里面的文件不在 ls-files 里
// 目录里（往下两层，对应 <领域>/<slug>.md）有没有 Markdown：被忽略的同名目录也可能是别的工具的缓存目录
function hasMarkdown(dir, depth = 2) {
  try {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).some((e) => (e.isFile() && MARKDOWN_RE.test(e.name))
      || (e.isDirectory() && depth > 1 && hasMarkdown(`${dir}${e.name}/`, depth - 1)));
  } catch {
    return false;
  }
}
if (IS_GIT) {
  const r = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  const checked = new Set();
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    const segs = p.replace(/\/$/, '').split('/');
    // 只认目录：`--directory` 给出的目录带结尾的 `/`，或者是目录下的文件。被忽略的同名普通文件不算
    const k = segs.findIndex((x, j) => LEGACY_DOC_DIRS.includes(x) && (j < segs.length - 1 || p.endsWith('/')));
    if (k !== -1) {
      const dir = segs.slice(0, k + 1).map((x) => `${x}/`).join('');
      if (!checked.has(dir)) {
        checked.add(dir);
        if (!isThirdParty(dir) && hasMarkdown(dir)) ignoredLegacyDirs.add(dir);
      }
    }
    const c = segs.indexOf('.claude');
    if (c !== -1) scopes.add(segs.slice(0, c).map((x) => `${x}/`).join(''));
  }
}

// ---------- 旧版文档 ----------

const legacyDocs = new Map(); // 旧版文档目录 -> 其中的 Markdown 文件
for (const f of OWN) {
  if (!MARKDOWN_RE.test(f)) continue;
  const dir = legacyDirOf(f);
  if (!dir) continue;
  if (!legacyDocs.has(dir)) legacyDocs.set(dir, []);
  legacyDocs.get(dir).push(f);
}
for (const f of OWN) {
  const i = segmentIndex(f, '.claude/');
  if (i !== -1 && !legacyDirOf(f)) scopes.add(f.slice(0, i));
}
for (const dir of [...legacyDocs.keys(), ...ignoredLegacyDirs]) {
  scopes.add(dir.slice(0, dir.slice(0, -1).lastIndexOf('/') + 1));
}
for (const [dir, list] of legacyDocs) {
  addDir('warn', 'legacy', dir, `旧版文档目录（${list.length} 份文档）：0.10.0 起不再有项目文档。每份文档里过得了准入门槛、原处还没有的结论放回原处，其余随文档删掉，指针只留重点（跑 /context-keeper:organize-context，文档多的按领域分批）`);
}
for (const dir of ignoredLegacyDirs) {
  if (legacyDocs.has(dir)) continue;
  addDir('warn', 'legacy', dir, '旧版文档目录，被 .gitignore 忽略了：0.10.0 起不再有项目文档。里面过得了准入门槛的结论放回原处；是不是只当本地草稿、要不要删，交给用户决定');
}

// 放在 `.claude/` 下、又不是 rule、skill、子代理记忆这类 Claude Code 自己的文件的文档，以及按类型分目录的文档（decisions/、adr/）。
// 更早的插件版本往这两种地方放过文档，但团队自己的 ADR、别的工具的文件也长这样：只给提示，是不是旧版文档由人确认
const CLAUDE_OWN = /(^|\/)\.claude\/(rules|skills|commands|agents|agent-memory(-local)?|output-styles|hooks|worktrees)\//;
const typeDirs = new Map(); // 目录 -> 文档数
for (const f of OWN) {
  if (!MARKDOWN_RE.test(f) || legacyDirOf(f) || CLAUDE_MD_RE.test(f)) continue;
  if (/(^|\/)\.claude\//.test(f) && !CLAUDE_OWN.test(f)) {
    add('info', 'legacy', f, '放在 `.claude/` 下的文档：Claude Code 不会从这里加载它。是旧版插件留下的项目文档才按旧版文档处理；团队自己或别的工具放的不动，由用户确认');
    continue;
  }
  const m = f.match(/^(.*?(?:^|\/)(?:context\/(?:decisions|data)|decisions|adrs?)\/)/);
  if (m) typeDirs.set(m[1], (typeDirs.get(m[1]) || 0) + 1);
}
for (const [dir, n] of typeDirs) {
  addDir('info', 'legacy', dir, `疑似按类型分的文档目录（${n} 份）：是旧版插件建的（有「重点 + 路径」的指针指向它）才按旧版文档处理；团队自己维护的 ADR、被代码读取的不动，由用户确认`);
}

// ---------- 旧版指针 ----------
// Claude 会加载的 Markdown（CLAUDE.md、rule、skill、子代理和命令的定义）里，以及源码注释里提到旧版文档目录的行。
// 这些 Markdown 的代码块里提到的不算指针，但多半是要照着执行的命令（`cat <文档>`），删了文档就指空，另列提示。
// 源码按所在语言的注释语法认注释（含行尾注释、跨行块注释的每一行）；命令参数、字符串、配置值里的路径不是指针，另列「代码字符串」。
// 别的 Markdown（README、对外文档）不是指针，但删了文档链接会指空。这两类都只在仓库里还有旧版文档时提示：
// 没有文档可删时，`.gitignore` 里的一行同名目录、历史记录里的旧路径不用再提。
// 先用 git grep 筛（范围与 ls-files 一致），不用把整个仓库读进内存

const legacyPointerLines = new Map(); // 文件 -> 指向旧版文档的行数，规模汇总用
const MD_SOURCES = new Set([...claudeMds, ...rules, ...skillMds, ...OWN.filter((f) => AGENT_MD_RE.test(f) && !legacyDirOf(f))]);
function othersMentioningLegacy() {
  const wanted = (f) => !MD_SOURCES.has(f) && !legacyDirOf(f) && !isThirdParty(f);
  if (IS_GIT) {
    const r = git(['grep', '-lIz', '--untracked', '-F', ...LEGACY_DOC_DIRS.flatMap((d) => ['-e', `${d}/`])]);
    if (r.status === 0 || r.status === 1) return r.stdout.split('\0').filter((f) => FILE_SET.has(f) && wanted(f));
  }
  return FILES.filter(wanted);
}
function reportLegacyPointers(f, hits) {
  if (!hits.length) return;
  legacyPointerLines.set(f, hits.length);
  if (INDEX_RULE_RE.test(f)) return; // 整条 rule 已经报了「旧版领域索引 rule」
  add('warn', 'legacy-pointer', f, `旧版指针：${hits.length} 处指向旧版文档目录：${lineList(hits)}。只留重点（重点是经过或状态的改写成结论或删掉），删掉「什么时候读 + 路径」`, hits[0]);
}
for (const f of MD_SOURCES) {
  reportLegacyPointers(f, [...legacyLines(f)].map((i) => i + 1));
  const text = read(f);
  if (text === null || INDEX_RULE_RE.test(f)) continue;
  const proseIdx = new Set(prose(f).map(([, i]) => i));
  const code = [];
  text.split(/\r?\n/).forEach((line, i) => { if (!proseIdx.has(i) && mentionsLegacy(line)) code.push(i + 1); });
  if (code.length) {
    add('info', 'legacy-code-block', f, `代码块里有 ${code.length} 行提到旧版文档目录：${lineList(code)}。文档删掉后这些路径会指空：是要照着执行的命令（读文件、传路径）就改掉，只是示例的不用动`, code[0]);
  }
}
const hasLegacyDocs = legacyDocs.size > 0 || ignoredLegacyDirs.size > 0;
for (const f of othersMentioningLegacy()) {
  const text = readRaw(f);
  if (!text) continue;
  if (MARKDOWN_RE.test(f)) {
    // 文档都删完以后剩下的（CHANGELOG 里的历史记录、讲这个目录本身的说明）不用再提
    if (!hasLegacyDocs) continue;
    const hits = proseLines(text).filter(([line]) => mentionsLegacy(line)).map(([, i]) => i + 1);
    if (hits.length) {
      add('info', 'legacy-mention', f, `别的 Markdown 里有 ${hits.length} 行提到旧版文档目录：${lineList(hits)}。Claude 不会主动加载它，不算指针；删了文档这些链接、路径会指空，随文档一起改掉（CHANGELOG 这类历史记录不用动）`, hits[0]);
    }
    continue;
  }
  const lines = text.split(/\r?\n/);
  const { spans } = scanSource(lines, langFor(f));
  const hits = [];
  const strings = [];
  lines.forEach((line, i) => {
    const at = legacyPositions(line);
    if (!at.length) return;
    // 每一处各自判断：`const P = '<文档>'; // 见 <文档>` 这一行既有字符串里的路径，也有注释里的指针
    const inComment = at.map((p) => spans[i].some(([from, to]) => p >= from && p < to));
    if (inComment.includes(true)) hits.push(i + 1);
    if (inComment.includes(false)) strings.push(i + 1);
  });
  reportLegacyPointers(f, hits);
  // 可执行的行（命令参数、字符串、配置值、ignore 规则）提到旧版文档：删了文档它们就指空，而改它们要动可执行代码
  if (strings.length && hasLegacyDocs) {
    add('info', 'legacy-string', f, `代码（不是注释）里有 ${strings.length} 行提到旧版文档目录：${lineList(strings)}。删这些文档前，先由用户决定这些行怎么改`, strings[0]);
  }
}

// ---------- .claude/rules/、.claude/skills/ 能否进 git ----------
// `.claude/` 下只探 rules/ 和 skills/：settings.local.json 之类本来就该被忽略。目录级 CLAUDE.md 所在目录不是作用域，不探

const PROBES = [
  { dir: '.claude/rules/', probe: '.claude/rules/__probe__.md', msg: '`.claude/rules/` 被 .gitignore 忽略了：rule 进不了仓库，队友看不到，本脚本也检查不到里面的文件。调整 .gitignore（比如只忽略 `.claude/settings.local.json`）后再往里写' },
  { dir: '.claude/skills/', probe: '.claude/skills/__probe__/SKILL.md', msg: '`.claude/skills/` 被 .gitignore 忽略了：skill 进不了仓库，队友看不到。调整 .gitignore 后再往里写' },
];
for (const { dir, probe, msg } of PROBES) {
  for (const p of ignored([...scopes].map((s) => s + probe))) add('error', 'claude-dir', p.slice(0, -probe.length) + dir, msg);
}

// ---------- 注释候选 ----------

if (WANT_COMMENTS) {
  for (const f of OWN) {
    if (!inScope(f) || !langFor(f) || NOT_CODE_DIR_RE.test(f)) continue;
    const text = readRaw(f);
    // 生成物里的注释改了也会被工具覆盖，不当整理候选
    if (!text || isGenerated(f, text)) continue;
    const { blocks, signals } = analyzeComments(text, f);
    for (const b of blocks) {
      add('info', 'comment-block', f, `${b.lines} 行的注释块（第 ${b.start}–${b.end} 行）`, b.start);
    }
    if (signals.length) {
      const lines = signals.map((s) => s.line);
      add('info', 'comment-signal', f, `带信号词的注释 ${signals.length} 处：${lineList(lines)}`, lines[0]);
    }
  }
}

// ---------- 规模 ----------
// 每个作用域的 rule 条数和正文行数、skill 数、旧版文档数、指向旧版文档的行数：整理前后各跑一次，对比效果。
// 文件归到离它最近的那个作用域

const scopeList = [...scopes].sort((a, b) => b.length - a.length);
const scopeFor = (f) => scopeList.find((s) => f.startsWith(s)) ?? '';
const scaleMap = new Map();
const scaleOf = (s) => {
  if (!scaleMap.has(s)) scaleMap.set(s, { scope: s || null, rules: 0, ruleLines: 0, skills: 0, legacyDocs: 0, legacyPointers: 0 });
  return scaleMap.get(s);
};
scaleOf('');
for (const [r, n] of ruleBodyLines) { const x = scaleOf(scopeFor(r)); x.rules++; x.ruleLines += n; }
for (const s of skills) scaleOf(scopeFor(s)).skills++;
for (const list of legacyDocs.values()) for (const d of list) scaleOf(scopeFor(d)).legacyDocs++;
for (const [f, n] of legacyPointerLines) scaleOf(scopeFor(f)).legacyPointers += n;
// 带路径时只列和这个路径有交集的作用域：路径所在的那一个，以及路径下的
const filterScope = FILTER ? scopeFor(FILTER) : '';
// 路径所在的作用域什么都没有时也列出来（全是 0）：整理前的基线要有这一行
scaleOf(filterScope);
const scale = [...scaleMap.values()]
  .filter((x) => !FILTER || (x.scope ?? '') === filterScope || (x.scope ?? '').startsWith(FILTER))
  .sort((a, b) => (a.scope ?? '').localeCompare(b.scope ?? ''));

// ---------- 输出 ----------

const order = { error: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
// 修剪候选单独计数，不影响退出码：删不删要人和模型读内容判断
const isPrune = (f) => f.category.startsWith('prune-');
const counts = { error: 0, warn: 0, info: 0 };
const pruneCounts = { warn: 0, info: 0 };
for (const f of findings) {
  if (isPrune(f)) pruneCounts[f.level]++;
  else counts[f.level]++;
}

if (WANT_JSON) {
  console.log(JSON.stringify({ root: ROOT, filter: FILTER || null, claudeMd: claudeMdStats, scale, findings, counts, pruneCounts }, null, 2));
} else {
  const label = { error: '错误', warn: '警告', info: '提示' };
  console.log(`context-keeper check：${ROOT}${FILTER ? `（只看 ${FILTER}）` : ''}`);
  const stats = claudeMdStats.filter((s) => inScope(s.file));
  if (stats.length) console.log(`CLAUDE.md 行数：${stats.map((s) => `${s.file} ${s.lines}`).join('；')}`);
  console.log(`规模：${scale.map((x) => {
    const legacy = x.legacyDocs || x.legacyPointers ? `，旧版文档 ${x.legacyDocs}，旧版指针 ${x.legacyPointers}` : '';
    return `${x.scope ? x.scope.slice(0, -1) : '仓库根'} rule ${x.rules} 条 / 正文 ${x.ruleLines} 行，skill ${x.skills}${legacy}`;
  }).join('；')}`);
  console.log('');
  const print = (f) => console.log(`[${label[f.level]}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.msg}`);
  const regular = findings.filter((f) => !isPrune(f));
  const prune = findings.filter(isPrune);
  regular.forEach(print);
  if (regular.length) console.log('');
  if (prune.length) {
    console.log('修剪候选（可能该删的，读内容确认；不计入下面的错误、警告、提示）：');
    prune.forEach(print);
    console.log('');
    console.log(`修剪候选：警告 ${pruneCounts.warn}，提示 ${pruneCounts.info}`);
  }
  console.log(`错误 ${counts.error}，警告 ${counts.warn}，提示 ${counts.info}`);
}
// 不用 process.exit：macOS 上 stdout 是管道时写入是异步的，直接退出会截断超过管道缓冲（64KB）的输出
process.exitCode = counts.error ? 1 : 0;
