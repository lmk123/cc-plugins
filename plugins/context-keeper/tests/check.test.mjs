import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, check } from './helpers.mjs';

const has = (r, category, re) => r.findings.some((f) => f.category === category && (!re || re.test(f.msg)));

const CLEAN = {
  'CLAUDE.md': '# 项目\n\n## 更多上下文\n- 做新需求、评估方案前，先看 `.context/README.md`：评估过但没做的需求\n',
  '.context/README.md': '# 项目文档入口\n\n- `.context/payment/installments.md`：要做分期付款前\n',
  '.context/payment/installments.md': '# 分期付款\n',
  '.context/api/retry-policy.md': '# 重试策略\n',
  '.claude/rules/styling/tokens.md': '---\npaths:\n  - "src/styles/*.css"\n---\n\n改 token 后必须跑 `pnpm tokens:build`。\n',
  'src/styles/a.css': '.a {}\n',
  'src/styles/b.css': '.b {}\n',
  'src/api/retry.ts': '// 重试上限 3：网关会封 IP。改重试次数前阅读 .context/api/retry-policy.md\nconst MAX_RETRY = 3;\n',
};

test('符合规范的仓库没有问题，退出码 0', () => {
  const r = check(makeRepo(CLEAN));
  assert.deepEqual(r.findings, []);
  assert.equal(r.status, 0);
});

test('失效指针是错误，退出码 1', () => {
  const r = check(makeRepo({ ...CLEAN, 'src/api/b.ts': '// 改 B 前读 .context/api/missing.md\nconst B = 1;\n' }));
  assert.ok(has(r, 'pointer', /missing\.md/));
  assert.equal(r.status, 1);
});

test('没写什么时候读的指针给提示', () => {
  const r = check(makeRepo({ ...CLEAN, 'src/api/retry.ts': '// 重试上限 3，原因见 .context/api/retry-policy.md\nconst MAX_RETRY = 3;\n' }));
  assert.ok(has(r, 'pointer-style'));
});

test('孤儿文档、没被根 CLAUDE.md 指到的入口', () => {
  const r = check(makeRepo({ ...CLEAN, 'CLAUDE.md': '# 项目\n', '.context/api/unused.md': '# 没人指\n' }));
  assert.ok(r.findings.some((f) => f.category === 'orphan' && f.file === '.context/api/unused.md'));
  assert.ok(has(r, 'entry'));
});

test('rule：只匹配一个文件、缺 paths、匹配不到文件、正文过长', () => {
  const body = Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const r = check(makeRepo({
    ...CLEAN,
    '.claude/rules/api/single.md': '---\npaths: "src/api/retry.ts"\n---\n\n只管一个文件。\n',
    '.claude/rules/api/always.md': '没有 frontmatter。\n',
    '.claude/rules/api/nothing.md': '---\npaths: "src/nope/*.ts"\n---\n\n匹配不到。\n',
    '.claude/rules/styling/long.md': `---\npaths: "src/styles/*.css"\n---\n\n${body}\n`,
  }));
  const of = (name) => r.findings.filter((f) => f.file.endsWith(name)).map((f) => f.msg).join('\n');
  assert.match(of('single.md'), /只匹配一个文件/);
  assert.match(of('always.md'), /没有 paths/);
  assert.match(of('nothing.md'), /匹配不到任何现存文件/);
  assert.match(of('long.md'), /正文 11 行/);
});

test('--comments 列出长注释块，已经是「重点 + 指针」的短注释不列', () => {
  const t = makeRepo({ ...CLEAN, 'src/api/long.ts': '// 以前是 5 次\n// 后来出了事故\n// 试过熔断\n// 放弃了\nconst A = 1;\n' });
  const r = check(t, ['--comments']);
  assert.ok(r.findings.some((f) => f.category === 'comment-block' && f.file === 'src/api/long.ts'));
  assert.ok(!r.findings.some((f) => f.file === 'src/api/retry.ts'));
});

test('带路径时只报告该路径下的问题', () => {
  const t = makeRepo({ ...CLEAN, 'src/api/b.ts': '// 改 B 前读 .context/api/missing.md\nconst B = 1;\n' });
  assert.equal(check(t, ['src/styles']).findings.length, 0);
  assert.equal(check(t, ['src/api']).findings.length, 1);
});
