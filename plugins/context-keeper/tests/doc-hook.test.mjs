import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, docHook } from './helpers.mjs';

const DOC = '.context/api/retry-policy.md';
const REPO = {
  [DOC]: '# 重试策略\n',
  '.context/api/gateway.md': `# 网关\n\n重试相关的见 ${DOC}\n`,
  '.context/README.md': `# 项目文档入口\n\n- 网关连续 5 次失败封 IP。评估限流方案前读 \`${DOC}\`\n`,
  '.claude/rules/api/context-index.md': `---\npaths:\n  - "src/api/*.ts"\n---\n\n- 重试上限 3。改重试次数前读 \`${DOC}\`\n`,
  'src/api/retry.ts': `// 重试上限 3：网关会封 IP。改重试次数前读 ${DOC}\nexport const MAX_RETRY = 3;\n`,
  'README.md': `示例：\`${DOC}\`\n`,
};

test('改了文档之后列出指到它的行：文档入口、领域索引 rule、源码注释', () => {
  const msg = docHook(makeRepo(REPO), { file: DOC });
  assert.match(msg, /刚改的 \.context\/api\/retry-policy\.md 被下面几处指到/);
  assert.match(msg, /- \.context\/README\.md:3 {2}- 网关连续 5 次失败封 IP/);
  assert.match(msg, /- \.claude\/rules\/api\/context-index\.md:6 {2}- 重试上限 3/);
  assert.match(msg, /- src\/api\/retry\.ts:1 {2}\/\/ 重试上限 3/);
});

test('别的文档里的互相引用、普通 Markdown 里的示例不列', () => {
  const msg = docHook(makeRepo(REPO), { file: DOC });
  assert.doesNotMatch(msg, /gateway\.md/);
  assert.doesNotMatch(msg, /- README\.md/);
});

test('没有任何一处指到的文档、文档入口、不是文档的文件不提醒', () => {
  const t = makeRepo({ ...REPO, '.context/api/unused.md': '# 没人指\n' });
  assert.equal(docHook(t, { file: '.context/api/unused.md', tool: 'Write' }), null);
  assert.equal(docHook(t, { file: '.context/README.md' }), null);
  assert.equal(docHook(t, { file: 'src/api/retry.ts' }), null);
});

test('另一个作用域里同名的文档不算指到它', () => {
  const t = makeRepo({
    [DOC]: '# 重试策略\n',
    'apps/web/.context/api/retry-policy.md': '# web 包的重试策略\n',
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
