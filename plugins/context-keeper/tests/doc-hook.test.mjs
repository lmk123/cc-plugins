import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { DOC_DIRS } from '../scripts/lib/pointers.mjs';
import { SCRIPTS, makeRepo, docHook, sessionStart } from './helpers.mjs';

const DOC = 'context-docs/api/retry-policy.md';
const REPO = {
  [DOC]: '# 重试策略\n',
  'context-docs/api/gateway.md': `# 网关\n\n重试相关的见 ${DOC}\n`,
  'context-docs/README.md': `# 项目文档入口\n\n- 网关连续 5 次失败封 IP。评估限流方案前读 \`${DOC}\`\n`,
  '.claude/rules/api/context-index.md': `---\npaths:\n  - "src/api/*.ts"\n---\n\n- 重试上限 3。改重试次数前读 \`${DOC}\`\n`,
  'src/api/retry.ts': `// 重试上限 3：网关会封 IP。改重试次数前读 ${DOC}\nexport const MAX_RETRY = 3;\n`,
  'README.md': `示例：\`${DOC}\`\n`,
};

test('改了文档之后列出指到它的行：文档入口、领域索引 rule、源码注释', () => {
  const msg = docHook(makeRepo(REPO), { file: DOC });
  assert.match(msg, /刚改的 context-docs\/api\/retry-policy\.md 被下面几处指到/);
  assert.match(msg, /- context-docs\/README\.md:3 {2}- 网关连续 5 次失败封 IP/);
  assert.match(msg, /- \.claude\/rules\/api\/context-index\.md:6 {2}- 重试上限 3/);
  assert.match(msg, /- src\/api\/retry\.ts:1 {2}\/\/ 重试上限 3/);
});

test('别的文档里的互相引用、普通 Markdown 里的示例不列', () => {
  const msg = docHook(makeRepo(REPO), { file: DOC });
  assert.doesNotMatch(msg, /gateway\.md/);
  assert.doesNotMatch(msg, /- README\.md/);
});

test('Markdown 代码块里的示例、源码字符串里的路径不列', () => {
  const msg = docHook(makeRepo({
    ...REPO,
    '.claude/rules/api/example.md': `---\npaths:\n  - "src/api/*.ts"\n---\n\n示例写法：\n\`\`\`\n// 改重试前读 ${DOC}\n\`\`\`\n`,
    'tests/fixture.test.ts': `const DOC = '${DOC}';\n`,
  }), { file: DOC });
  assert.match(msg, /src\/api\/retry\.ts:1/);
  assert.doesNotMatch(msg, /example\.md/);
  assert.doesNotMatch(msg, /fixture\.test\.ts/);
});

test('没有任何一处指到的文档、文档入口、不是文档的文件不提醒', () => {
  const t = makeRepo({ ...REPO, 'context-docs/api/unused.md': '# 没人指\n' });
  assert.equal(docHook(t, { file: 'context-docs/api/unused.md', tool: 'Write' }), null);
  assert.equal(docHook(t, { file: 'context-docs/README.md' }), null);
  assert.equal(docHook(t, { file: 'src/api/retry.ts' }), null);
});

test('另一个作用域里同名的文档不算指到它', () => {
  const t = makeRepo({
    [DOC]: '# 重试策略\n',
    'apps/web/context-docs/api/retry-policy.md': '# web 包的重试策略\n',
    'apps/web/src/retry.ts': `// 重试上限 5。改重试次数前读 apps/web/${DOC}\nexport const MAX_RETRY = 5;\n`,
  });
  assert.equal(docHook(t, { file: DOC }), null);
  assert.match(docHook(t, { file: `apps/web/${DOC}` }), /被下面这一处指到[\s\S]*- apps\/web\/src\/retry\.ts:1/);
});

test('指到它的行超过 10 处时只列 10 处，其余给出数目', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `// 第 ${i + 1} 处。改之前读 ${DOC}`).join('\n');
  const msg = docHook(makeRepo({ [DOC]: '# 重试策略\n', 'src/a.ts': `${lines}\n` }), { file: DOC });
  assert.equal(msg.split('\n').filter((l) => l.startsWith('- src/a.ts:')).length, 10);
  assert.match(msg, /另有 2 处没列出/);
});

test('CONTEXT_KEEPER_DOC_HOOK=0 时关闭', () => {
  assert.equal(docHook(makeRepo(REPO), { file: DOC, env: { CONTEXT_KEEPER_DOC_HOOK: '0' } }), null);
});

test('同一会话里同一份文档：清单只给一次，之后清单没变时只提醒一行', () => {
  const t = makeRepo(REPO);
  assert.match(docHook(t, { file: DOC, session: 's1' }), /被下面几处指到/);
  const again = docHook(t, { file: DOC, session: 's1' });
  assert.match(again, /又改了 context-docs\/api\/retry-policy\.md：指到它的 3 处/);
  assert.equal(again.split('\n').length, 1);
  // 另一个会话、同一会话里的子代理各算各的：它们的 context 里没有那份清单
  assert.match(docHook(t, { file: DOC, session: 's2' }), /被下面几处指到/);
  assert.match(docHook(t, { file: DOC, session: 's1', agent: 'a1' }), /被下面几处指到/);
});

test('清单变了、主会话压缩上下文之后重新给完整清单', () => {
  const t = makeRepo(REPO);
  docHook(t, { file: DOC, session: 's1' });
  fs.writeFileSync(path.join(t.repo, 'src/api/backoff.ts'), `// 退避上限 30 秒。改退避前读 ${DOC}\n`);
  assert.match(docHook(t, { file: DOC, session: 's1' }), /- src\/api\/backoff\.ts:1/);
  assert.match(docHook(t, { file: DOC, session: 's1' }), /又改了/);
  sessionStart(t, { session: 's1', source: 'compact' });
  assert.match(docHook(t, { file: DOC, session: 's1' }), /被下面几处指到/);
});

// hooks.json 里 doc-hook 前面有一段 shell 预筛：payload 里没有 `context-docs/`（Windows 上是 `context-docs\`）就不起 node。这段只有真跑一遍才测得到
test('hooks.json 里的命令：输入原样传给脚本，没提到文档目录的 payload 不出声', { skip: process.platform === 'win32' }, () => {
  const plugin = path.join(SCRIPTS, '..');
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse;
  const cmd = hooks.flatMap((h) => h.hooks).map((h) => h.command).find((c) => c.includes('doc-hook.mjs'));
  const t = makeRepo(REPO);
  const run = (file) => spawnSync('sh', ['-c', cmd], {
    // 反斜杠、百分号、引号、$ 和反引号：shell 转手时最容易被改掉的几种字符
    input: JSON.stringify({ cwd: t.repo, tool_name: 'Edit', tool_input: { file_path: path.join(t.repo, file), old_string: 'a\\n%s "q" \\\\ $HOME `x`', new_string: "it's 100%\n" } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, TMPDIR: t.tmp },
  });
  const hit = run(DOC);
  assert.equal(hit.status, 0);
  assert.match(JSON.parse(hit.stdout).hookSpecificOutput.additionalContext, /被下面几处指到/);
  const miss = run('src/api/retry.ts');
  assert.equal(miss.status, 0);
  assert.equal(miss.stdout, '');
});

// shell 预筛读不到 pointers.mjs 里的目录名，是另写的一遍：对着 DOC_DIRS 逐个查，改目录名时漏改 hooks.json 会在这里失败。
// 换一个只打印标记的假 doc-hook.mjs，只看预筛放没放行；Windows 路径在 payload 里是 JSON 转义过的 `\\`
test('hooks.json 里的预筛：每个文档目录的正斜杠和 Windows 路径都放行，别的路径不起 node', { skip: process.platform === 'win32' }, () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse;
  const cmd = hooks.flatMap((h) => h.hooks).map((h) => h.command).find((c) => c.includes('doc-hook.mjs'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-prefilter-'));
  fs.mkdirSync(path.join(fake, 'scripts'));
  fs.writeFileSync(path.join(fake, 'scripts', 'doc-hook.mjs'), "process.stdout.write('RAN');\n");
  const ran = (file) => spawnSync('sh', ['-c', cmd], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fake },
  }).stdout === 'RAN';
  try {
    for (const dir of DOC_DIRS) {
      assert.ok(ran(`/repo/${dir}/api/a.md`), dir);
      assert.ok(ran(`C:\\repo\\${dir}\\api\\a.md`), `${dir}（Windows）`);
    }
    assert.ok(!ran('/repo/src/context/a.ts'));
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('改名前改了旧目录 .context/ 里的文档，照样列出指到它的行，并提示改名', () => {
  const old = ['.context', 'api/retry-policy.md'].join('/');
  const msg = docHook(makeRepo({
    [old]: '# 重试策略\n',
    [['.context', 'README.md'].join('/')]: `# 项目文档入口\n\n- 网关连续 5 次失败封 IP。评估限流方案前读 \`${old}\`\n`,
    'src/api/retry.ts': `// 重试上限 3：网关会封 IP。改重试次数前读 ${old}\nexport const MAX_RETRY = 3;\n`,
  }), { file: old });
  assert.match(msg, /- \.context\/README\.md:3/);
  assert.match(msg, /- src\/api\/retry\.ts:1/);
  assert.match(msg, /organize-context/);
});

test('相对链接指到这份文档的也列出来，解析到别处的同名文件不列', () => {
  const msg = docHook(makeRepo({
    ...REPO,
    'context-docs/README.md': '# 项目文档入口\n\n- 网关连续 5 次失败封 IP。评估限流方案前读 [重试](api/retry-policy.md)\n- 另一份：[同名](other/retry-policy.md)\n',
    'context-docs/other/retry-policy.md': '# 别的\n',
  }), { file: DOC });
  assert.match(msg, /- context-docs\/README\.md:3 {2}- 网关连续 5 次失败封 IP/);
  assert.doesNotMatch(msg, /README\.md:4/);
});
