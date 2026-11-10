#!/usr/bin/env node
// context-keeper 结构检查：把规范里能确定性校验的部分交给脚本，模型只处理需要判断的部分。
// 无第三方依赖，可以直接复制进项目接 CI。
//
// 用法：node check.mjs [路径] [--comments] [--json]
//   路径        只报告该路径下文件的问题（默认整个仓库）
//   --comments  额外扫描源码里的长注释块和带信号词的注释，作为搬运候选
//   --json      输出 JSON
// 有「错误」级问题时退出码为 1。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCommentBlocks, findSignalComments, langFor } from './lib/comments.mjs';

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
  if (FILTER && !FILTER.endsWith('/') && fs.statSync(path.join(ROOT, FILTER)).isDirectory()) FILTER += '/';
}
const inScope = (f) => !FILTER || f === FILTER || f.startsWith(FILTER);

const cache = new Map();
function read(f) {
  if (cache.has(f)) return cache.get(f);
  let t = null;
  try {
    const full = path.join(ROOT, f);
    if (fs.statSync(full).size <= 1 << 20) {
      const buf = fs.readFileSync(full);
      if (!buf.subarray(0, 8000).includes(0)) t = buf.toString('utf8');
    }
  } catch {}
  cache.set(f, t);
  return t;
}

function ignored(paths) {
  if (!IS_GIT || !paths.length) return new Set();
  const r = git(['check-ignore', '--stdin'], { input: paths.join('\n') });
  return new Set(r.stdout.split('\n').filter(Boolean));
}

// ---------- 结果收集 ----------

const findings = [];
const add = (level, category, file, msg, line) => {
  if (inScope(file)) findings.push({ level, category, file, line, msg });
};

// ---------- 分类 ----------

const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
const DOC_RE = /(^|\/)\.context\/.+\.md$/i;
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
  const end = lines.indexOf('---', 1) !== -1 ? lines.indexOf('---', 1) : lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const fm = lines.slice(1, end);
  const unq = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  const res = { paths: null, description: null, body: lines.slice(end + 1) };
  for (let i = 0; i < fm.length; i++) {
    const m = fm[i].match(/^(paths|description)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === 'description') { res.description = unq(rest); continue; }
    if (rest.trim().startsWith('[')) {
      res.paths = rest.trim().replace(/^\[|\]$/g, '').split(',').map(unq).filter(Boolean);
    } else if (rest.trim()) {
      res.paths = [unq(rest)];
    } else {
      res.paths = [];
      while (i + 1 < fm.length && /^\s*-\s+/.test(fm[i + 1])) res.paths.push(unq(fm[++i].replace(/^\s*-\s+/, '')));
    }
  }
  return res;
}

// ---------- glob ----------

function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const anyDepth = !g.includes('/');
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
  return new RegExp(`^${anyDepth ? '(?:[^/]+/)*' : ''}${re}$`);
}

const staticPrefix = (glob) => {
  const segs = glob.replace(/^\.\//, '').split('/');
  const idx = segs.findIndex((s) => /[*?{[]/.test(s));
  return segs.slice(0, idx === -1 ? segs.length : idx).join('/');
};

const isBroadPattern = (g) => {
  const n = g.replace(/^\.\//, '');
  return ['*', '**', '**/*', '**/*.*'].includes(n) || /^[^/*?{[]+\/\*\*(\/\*)?$/.test(n);
};

// ---------- rules ----------

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
  if (!fm.paths || !fm.paths.length) {
    add('warn', 'rule', rule, '没有 paths，会常驻加载：补 paths，或说明它其实是 ALWAYS');
    continue;
  }
  const bodyLines = fm.body.filter((l) => l.trim()).length;
  if (bodyLines > RULE_MAX_LINES && !INDEX_RULE_RE.test(rule)) {
    add('warn', 'rule', rule, `正文 ${bodyLines} 行（上限 ${RULE_MAX_LINES}）：命中时整份加载。收窄 paths 拆成几条，或把长背景拆进 .context/ 文档、rule 留一行路径`);
  }
  const sf = scopeFiles(scope);
  for (const glob of fm.paths) {
    const re = globToRegExp(glob);
    const matched = sf.filter((f) => re.test(f));
    if (!matched.length) {
      const bare = glob.replace(/^\.\//, '').replace(/\/$/, '');
      if (scope && (glob.startsWith(scope) || glob.startsWith(`./${scope}`))) {
        add('error', 'rule', rule, `paths "${glob}" 写成了从仓库根算起的路径；包内 rule 的 glob 相对 ${scope} 写`);
      } else if (!/[*?{[]/.test(bare) && sf.some((f) => f.startsWith(`${bare}/`))) {
        add('warn', 'rule', rule, `paths "${glob}" 是目录名，不一定能匹配到文件，建议写成 "${bare}/**"`);
      } else if (ignored([`${scope}${staticPrefix(glob) || '.'}/__probe__`]).size) {
        add('warn', 'rule', rule, `paths "${glob}" 指向被 .gitignore 忽略的路径（以${scopeLabel}为基准），人工核对它与生成脚本的输出一致`);
      } else {
        add('error', 'rule', rule, `paths "${glob}" 匹配不到任何现存文件（以${scopeLabel}为基准）`);
      }
      continue;
    }
    if (isBroadPattern(glob)) {
      add('warn', 'rule', rule, `paths "${glob}" 过宽：一碰这个目录（或整个作用域）就全中，起不到过滤作用`);
    } else if (sf.length >= 20 && matched.length / sf.length >= 0.5) {
      add('warn', 'rule', rule, `paths "${glob}" 过宽：匹配了作用域里 ${matched.length}/${sf.length} 个文件，起不到过滤作用`);
    }
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
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const plain = line.replace(/`[^`]*`/g, '');
    const m = plain.match(/(?:^|\s)@([~./\w][^\s'")\]]*)/);
    if (m && /[/.]/.test(m[1]) && !/@[\w.-]+\.(com|org|net|io|dev)\b/.test(plain)) {
      add('error', 'import', f, `\`@${m[1]}\` 是 import，启动时会整份展开进 context；改成自然语言写路径`, i + 1);
    }
  });
}

// ---------- CLAUDE.md ----------

const claudeMdStats = [];
for (const f of claudeMds) {
  const text = read(f);
  if (text === null) continue;
  const lines = text.split(/\r?\n/);
  claudeMdStats.push({ file: f, lines: lines.length });
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence && /(因为|当初|以前|原因是|由于|\bbecause\b|\bpreviously\b)/i.test(line)) {
      add('warn', 'claude-md', f, `疑似带原因：「${line.trim().slice(0, 60)}」——CLAUDE.md 只写做什么，原因拆出来：能挂到代码上的进 rule，挂不上的进 .context/ 文档`, i + 1);
    }
  });
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

// ---------- .context/ 能否进 git ----------

const scopes = new Set(['']);
for (const f of [...rules, ...docs, ...claudeMds, ...skills]) {
  for (const marker of ['.claude/', '.context/', 'CLAUDE.md', 'CLAUDE.local.md']) {
    const i = f.indexOf(marker);
    if (i !== -1 && (i === 0 || f[i - 1] === '/')) { scopes.add(f.slice(0, i)); break; }
  }
}
const PROBE = ['.context', '__probe__.md'].join('/'); // 拆开写，免得脚本复制进项目后把这里当成失效指针
for (const p of ignored([...scopes].map((s) => s + PROBE))) {
  const s = p.slice(0, -PROBE.length);
  add('error', 'context-dir', `${s}.context/`, '`.context/` 被 .gitignore 忽略了，文档进不了仓库：调整 .gitignore 后再往里写');
}

// ---------- 指针：失效与孤儿 ----------

const POINTER_RE = /(?<![\w./-])((?:[\w.-]+\/)*\.context\/[\w./-]*?[\w-]\.md)(?![\w.-])/g;
const referenced = new Set(); // 被文档以外的文件指到
const inEntry = new Set(); // 登记在文档入口里
const fromRootClaude = new Set(); // 被根 CLAUDE.md 指到
for (const f of FILES) {
  if (/(^|\/)\.git\//.test(f)) continue;
  const text = read(f);
  if (!text || !text.includes('.context/')) continue;
  const fromDoc = DOC_RE.test(f) && !ENTRY_RE.test(f);
  const isEntry = ENTRY_RE.test(f);
  const isRootClaude = ROOT_CLAUDE_MD.has(f);
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.includes('.context/')) return;
    for (const m of line.matchAll(POINTER_RE)) {
      const p = m[1].replace(/^\.\//, '');
      if (FILE_SET.has(p) || fs.existsSync(path.join(ROOT, p))) {
        if (!fromDoc) referenced.add(p);
        if (isEntry) inEntry.add(p);
        if (isRootClaude) fromRootClaude.add(p);
      } else {
        add('error', 'pointer', f, `指针指向不存在的文件 ${p}（指针一律写仓库根起的路径）`, i + 1);
      }
    }
  });
}
for (const d of docs) {
  if (!referenced.has(d)) add('warn', 'orphan', d, `孤儿文档：没有登记在任何入口，也没有被 rule、CLAUDE.md 或代码以仓库根起的路径指到，不会被读到。能挂到代码上的先看能不能并回 rule，不能就登记进领域索引 rule；挂不到的登记进 ${ENTRY}`);
}
for (const e of entries) {
  if (!fromRootClaude.has(e)) add('warn', 'entry', e, '文档入口没被根 CLAUDE.md 指到：挂不到代码上的文档在做新需求时不会被看到；在根 CLAUDE.md「更多上下文」里写上这个路径');
}

// ---------- 领域索引 ----------

for (const [key, list] of domainsWithDocs) {
  const [scope, domain] = key.split('|');
  const idx = `${scope}.claude/rules/${domain}/context-index.md`;
  if (FILE_SET.has(idx)) continue;
  const unindexed = list.filter((d) => !inEntry.has(d));
  if (unindexed.length) add('warn', 'index', unindexed[0], `领域 ${domain} 有 ${unindexed.length} 份文档没登记在 ${ENTRY}，也没有索引 rule ${idx}：碰到相关代码时不会被带出来（挂不到代码上的应登记进 ${ENTRY}）`);
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
    const text = read(f);
    if (!text) continue;
    for (const b of findCommentBlocks(text, f)) {
      add('info', 'comment-block', f, `${b.lines} 行的注释块（第 ${b.start}–${b.end} 行）`, b.start);
    }
    const sig = findSignalComments(text, f);
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
process.exit(counts.error ? 1 : 0);
