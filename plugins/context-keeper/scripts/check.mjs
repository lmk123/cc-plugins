#!/usr/bin/env node
// context-keeper 结构检查：把规范里能确定性校验的部分交给脚本，模型只处理需要判断的部分。
// 无第三方依赖。复制进项目接 CI 时连同 lib/ 目录一起复制（import 了 lib/comments.mjs）。
//
// 用法：node check.mjs [路径] [--comments] [--json]
//   路径        只报告该路径下文件的问题（默认整个仓库）
//   --comments  额外扫描源码里的长注释块和带信号词的注释，作为搬运候选
//   --json      输出 JSON
// 有「错误」级问题时退出码为 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeComments, langFor } from './lib/comments.mjs';

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
  FILTER = path.relative(ROOT, path.resolve(process.cwd(), target)).split(path.sep).join('/');
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

// Markdown 代码块外的行，返回 [[line, i]]，i 为 0 起的行下标，围栏行本身不返回。plain 为 true 时（源码）不认围栏
function proseLines(text, plain = false) {
  const out = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!plain && /^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence) out.push([line, i]);
  });
  return out;
}

// ---------- 结果收集 ----------

const findings = [];
const add = (level, category, file, msg, line) => {
  if (inScope(file)) findings.push({ level, category, file, line, msg });
};

// ---------- 分类 ----------

const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
const DOC_RE = /(^|\/)\.context\/.+\.md$/; // 区分大小写：和 scopeOf 的 indexOf、POINTER_RE 口径一致
const ENTRY_RE = /(^|\/)\.context\/README\.md$/; // 文档入口：登记挂不到代码上的文档，本身不是文档
// 提示文字里的入口路径拆开写，免得脚本复制进项目后把它当成失效指针
const ENTRY = ['.context', 'README.md'].join('/');
const CLAUDE_MD_RE = /(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/;
const ROOT_CLAUDE_MD = new Set(['CLAUDE.md', '.claude/CLAUDE.md']);
const SKILL_RE = /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/;
const INDEX_RULE_RE = /(^|\/)\.claude\/rules\/[^/]+\/context-index\.md$/;
const RULE_MAX_LINES = 20;

const rules = FILES.filter((f) => RULE_RE.test(f));
const entries = FILES.filter((f) => ENTRY_RE.test(f));
const docs = FILES.filter((f) => DOC_RE.test(f) && !ENTRY_RE.test(f));
const claudeMds = FILES.filter((f) => CLAUDE_MD_RE.test(f));
const skills = FILES.filter((f) => SKILL_RE.test(f));

const scopeOf = (f, marker) => f.slice(0, f.indexOf(marker));
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
    add('warn', 'rule', rule, `正文 ${bodyLines} 行（上限 ${RULE_MAX_LINES}）：命中时整份加载。收窄 paths 拆成几条，或把长背景拆进 .context/ 文档、rule 留一行路径`);
  }
  const sf = scopeFiles(scope);
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
    if (!line.includes(ENTRY) && /(因为|当初|以前|原因是|由于|\bbecause\b|\bpreviously\b)/i.test(line)) {
      add('warn', 'claude-md', f, `疑似带原因：「${line.trim().slice(0, 60)}」——CLAUDE.md 只写做什么，原因拆出来：能挂到代码上的进 rule，挂不上的进 .context/ 文档`, i + 1);
    }
  }
}

// ---------- 文档 ----------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const domainsWithDocs = new Map(); // `${scope}|${domain}` -> [docs]
for (const d of docs) {
  const scope = scopeOf(d, '.context/');
  const rel = d.slice(scope.length + '.context/'.length);
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  if (segs.length > 2) add('warn', 'doc', d, '领域目录嵌套了：`.context/` 下只分一层领域目录');
  if (/^\d{4}-\d{2}-\d{2}-/.test(name)) add('warn', 'doc', d, `文件名带日期前缀：建议改为 ${name.replace(/^\d{4}-\d{2}-\d{2}-/, '')} 并同步所有指针`);
  else if (/^\d+-/.test(name)) add('warn', 'doc', d, `文件名带编号前缀：建议改为 ${name.replace(/^\d+-/, '')} 并同步所有指针`);
  else if (!SLUG_RE.test(name)) add('warn', 'doc', d, '文件名不是英文小写短横线的 <slug>.md');
  if (segs.length >= 2) {
    const key = `${scope}|${segs[0]}`;
    if (!domainsWithDocs.has(key)) domainsWithDocs.set(key, []);
    domainsWithDocs.get(key).push(d);
  }
}

// ---------- .context/、.claude/rules/、.claude/skills/ 能否进 git ----------

// 两路：一是磁盘上已经存在、但被忽略的 `.context/`、`.claude/`（被忽略的文件不在 ls-files 里，上面的分类看不到它们）；
// 二是按根和已有 `.claude/`、`.context/` 的位置探一下写进去会不会被忽略。
// `.claude/` 下只探 rules/ 和 skills/：settings.local.json 之类本来就该被忽略。
// 目录级 CLAUDE.md 所在目录不是作用域，不探。
const scopes = new Set(['']);
if (IS_GIT) {
  const r = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    const segs = p.replace(/\/$/, '').split('/');
    const k = segs.findIndex((x) => x === '.context' || x === '.claude');
    if (k !== -1) scopes.add(segs.slice(0, k).map((x) => `${x}/`).join(''));
  }
}
// 已有 `.claude/`（哪怕只有 settings.json）或 `.context/` 的目录都当作作用域探一下
for (const f of FILES) {
  for (const marker of ['.claude/', '.context/']) {
    const i = f.indexOf(marker);
    if (i !== -1 && (i === 0 || f[i - 1] === '/')) { scopes.add(f.slice(0, i)); break; }
  }
}
// 拆开写，免得脚本复制进项目后把这里当成失效指针
const PROBES = [
  { dir: '.context/', probe: ['.context', '__probe__.md'].join('/'), category: 'context-dir', msg: '`.context/` 被 .gitignore 忽略了，文档进不了仓库：调整 .gitignore 后再往里写' },
  { dir: '.claude/rules/', probe: '.claude/rules/__probe__.md', category: 'claude-dir', msg: '`.claude/rules/` 被 .gitignore 忽略了：rule 进不了仓库，队友看不到，本脚本也检查不到里面的文件。调整 .gitignore（比如只忽略 `.claude/settings.local.json`）后再往里写' },
  { dir: '.claude/skills/', probe: '.claude/skills/__probe__/SKILL.md', category: 'claude-dir', msg: '`.claude/skills/` 被 .gitignore 忽略了：skill 进不了仓库，队友看不到。调整 .gitignore 后再往里写' },
];
for (const { dir, probe, category, msg } of PROBES) {
  for (const p of ignored([...scopes].map((s) => s + probe))) add('error', category, p.slice(0, -probe.length) + dir, msg);
}

// ---------- 指针：失效与孤儿 ----------

// 路径段允许中文等非 ASCII 字符；前面紧贴的字符只排除 ASCII 的路径字符，这样"详见.context/…"这种紧贴中文的写法也能认出来
const POINTER_RE = /(?<![\w./-])((?:[\p{L}\p{N}_.-]+\/)*\.context\/[\p{L}\p{N}_./-]*?[\p{L}\p{N}_-]\.md)(?![\p{L}\p{N}_.-])/gu;
const referenced = new Set(); // 被文档以外的文件指到
const fromRule = new Set(); // 被 rule（含领域索引 rule）指到：碰到 rule 的 paths 时路径随 rule 进 context，等于已登记
const RULE_SET = new Set(rules);
const inEntry = new Set(); // 登记在文档入口里
const fromRootClaude = new Set(); // 被根 CLAUDE.md 指到
// 指针只认 Claude 会读到的地方：CLAUDE.md、rule、skill、文档、文档入口，以及源码。
// 其他 Markdown（README、CHANGELOG、对外文档）里的 `.context/…` 多半是示例或历史记录，不算指针
const MD_SOURCES = new Set([...claudeMds, ...rules, ...skills, ...entries, ...docs]);
const isPointerSource = (f) => MD_SOURCES.has(f) || langFor(f) !== null;
// 只读含 `.context/` 的文件：git 仓库里先用 git grep 筛（范围与 ls-files 一致），不用把整个仓库读进内存
function filesMentioningContext() {
  if (IS_GIT) {
    const r = git(['grep', '-lIz', '--untracked', '-F', '-e', '.context/']);
    if (r.status === 0 || r.status === 1) return r.stdout.split('\0').filter((f) => FILE_SET.has(f) && isPointerSource(f));
  }
  return FILES.filter(isPointerSource);
}
const pointerExists = (p) => FILE_SET.has(p) || fs.existsSync(path.join(ROOT, p));
// 中文正文紧贴路径时（"见包/.context/…"），前面的字会被并进第一段：逐个去掉开头的非 ASCII 字符再试，
// 第一段至少留一个字符，免得退化成根作用域的 `.context/`。都不存在时返回 null
function resolvePointer(p) {
  for (let q = p; ; q = q.replace(/^[^\x00-\x7f]/u, '')) {
    if (pointerExists(q)) return q;
    if (!/^[^\x00-\x7f][^/]/u.test(q)) return null;
  }
}
for (const f of filesMentioningContext()) {
  const isMd = MD_SOURCES.has(f);
  const text = isMd ? read(f) : readRaw(f);
  if (!text || !text.includes('.context/')) continue;
  const fromDoc = DOC_RE.test(f) && !ENTRY_RE.test(f);
  const isEntry = ENTRY_RE.test(f);
  const isRootClaude = ROOT_CLAUDE_MD.has(f);
  const isRule = RULE_SET.has(f);
  // Markdown 代码块里的是示例，不算指针
  for (const [line, i] of proseLines(text, !isMd)) {
    if (!line.includes('.context/')) continue;
    const seen = new Set();
    for (const m of line.matchAll(POINTER_RE)) {
      const raw = m[1].replace(/^\.\//, '');
      if (seen.has(raw)) continue;
      seen.add(raw);
      const p = resolvePointer(raw);
      if (p) {
        if (!fromDoc) referenced.add(p);
        if (isEntry) inEntry.add(p);
        if (isRootClaude) fromRootClaude.add(p);
        if (isRule) fromRule.add(p);
      } else {
        add('error', 'pointer', f, `指针指向不存在的文件 ${raw}（指针一律写仓库根起的路径）`, i + 1);
      }
    }
  }
}
for (const d of docs) {
  if (!referenced.has(d)) add('warn', 'orphan', d, `孤儿文档：没有登记在任何入口，也没有被 rule、CLAUDE.md 或代码以仓库根起的路径指到，不会被读到。能挂到代码上的先看能不能并回 rule，不能就在相关 rule 里留一行路径、或登记进领域索引 rule；挂不到的登记进 ${ENTRY}`);
}
for (const e of entries) {
  if (!fromRootClaude.has(e)) add('warn', 'entry', e, '文档入口没被根 CLAUDE.md 指到：挂不到代码上的文档在做新需求时不会被看到；在根 CLAUDE.md「更多上下文」里写上这个路径');
}

// ---------- 领域索引 ----------

for (const [key, list] of domainsWithDocs) {
  const [scope, domain] = key.split('|');
  const idx = `${scope}.claude/rules/${domain}/context-index.md`;
  if (FILE_SET.has(idx)) continue;
  // 已被某条 rule 指到的文档，碰到那条 rule 的 paths 时就会被带出来，不要求另建索引 rule
  const unindexed = list.filter((d) => !inEntry.has(d) && !fromRule.has(d));
  if (unindexed.length) add('warn', 'index', unindexed[0], `领域 ${domain} 有 ${unindexed.length} 份文档没登记在 ${ENTRY}、没被任何 rule 指到，也没有索引 rule ${idx}：碰到相关代码时不会被带出来（挂不到代码上的应登记进 ${ENTRY}）`);
}

// ---------- 放错地方的文档 ----------

const CLAUDE_OWN = /(^|\/)\.claude\/(rules|skills|commands|agents|output-styles|hooks)\//;
for (const f of FILES) {
  if (!f.endsWith('.md') || CLAUDE_MD_RE.test(f)) continue;
  if (/(^|\/)\.claude\//.test(f) && !CLAUDE_OWN.test(f)) {
    add('warn', 'misplaced', f, '文档放在 `.claude/` 下：迁到所属作用域的 `.context/<领域>/<slug>.md`');
  } else if (!DOC_RE.test(f) && /(^|\/)(context\/(decisions|data)|decisions|adrs?)\//.test(f) && !/(^|\/)node_modules\//.test(f)) {
    add('info', 'misplaced', f, '疑似按类型分的文档目录（旧版 context/decisions 之类）：确认是文档后迁到 `.context/<领域>/<slug>.md`');
  }
}

// ---------- 注释候选 ----------

if (WANT_COMMENTS) {
  for (const f of FILES) {
    if (!inScope(f) || !langFor(f) || /(^|\/)(\.context|\.claude)\//.test(f)) continue;
    if (f.split('/').some((s) => SKIP_DIRS.has(s))) continue;
    const text = readRaw(f);
    if (!text) continue;
    const { blocks, signals: sig } = analyzeComments(text, f);
    for (const b of blocks) {
      add('info', 'comment-block', f, `${b.lines} 行的注释块（第 ${b.start}–${b.end} 行）`, b.start);
    }
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
