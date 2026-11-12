import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeRepo, guard, sessionStart, age, use, result, compact } from './helpers.mjs';

const DOC = '.context/api/retry-policy.md';
const POINTER = `改重试次数前读 ${DOC}`;

const repoWith = (files) => makeRepo({ [DOC]: '# 重试策略\n', ...files });

const RETRY_TS = `import x from 'y';

// 重试上限 3：网关会封 IP。${POINTER}
const MAX_RETRY = 3;

// ${POINTER}
export function retry() {
  for (let i = 0; i < MAX_RETRY; i++) {
    doIt();
  }
}

export function other() {
  return 1;
}
`;

test('改到指针下面的代码时拦下，消息里有指针原文和文档的绝对路径', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const msg = guard(t, { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' });
  assert.match(msg, /src\/retry\.ts:3/);
  assert.ok(msg.includes(path.join(t.repo, DOC)));
});

test('外层函数上方的指针也算附近；同一文件里别的函数不拦', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  assert.match(guard(t, { file: 'src/retry.ts', old: '    doIt();' }), /src\/retry\.ts:6/);
  assert.equal(guard(t, { file: 'src/retry.ts', old: '  return 1;', session: 's2' }), null);
});

test('拦下后 3 秒内对同一处继续拦，过后放行', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  assert.ok(guard(t, edit));
  assert.ok(guard(t, edit));
  age(t);
  assert.equal(guard(t, edit), null);
});

test('JSX 注释、不带 * 的块注释、Python docstring 里的指针都认', () => {
  const t = repoWith({
    'src/a.tsx': `export function C() {\n  return (\n    <div>\n      {/* ${POINTER} */}\n      <span>hi</span>\n    </div>\n  );\n}\n`,
    'src/a.css': `/*\n  颜色不能改。${POINTER}\n*/\n.a { color: red; }\n`,
    'src/header.py': `"""模块说明\n\n${POINTER}\n"""\nimport os\n\nTIMEOUT = 3\n`,
    'src/func.py': `def retry():\n    """重试。\n\n    ${POINTER}\n    """\n    return 3\n`,
  });
  assert.ok(guard(t, { file: 'src/a.tsx', old: '      <span>hi</span>', session: 'jsx' }));
  assert.ok(guard(t, { file: 'src/a.css', old: '.a { color: red; }', session: 'css' }));
  assert.ok(guard(t, { file: 'src/header.py', old: 'TIMEOUT = 3', session: 'pyh' }));
  assert.ok(guard(t, { file: 'src/func.py', old: '    return 3', session: 'pyf' }));
});

test('赋值给变量的三引号字符串不当成注释：收尾的三引号不会把后面的代码吞掉', () => {
  const t = repoWith({
    'src/k.py': `class K:\n    SQL = """\n    select 1\n    """\n    # ${POINTER}\n    def f(self):\n        return 1\n    X = """y"""\n`,
  });
  assert.match(guard(t, { file: 'src/k.py', old: '        return 1' }), /src\/k\.py:5/);
});

test('读过文档就不拦：Read 成功、Bash 里 cat 过', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const read = use('t1', 'Read', { file_path: path.join(t.repo, DOC) });
  assert.equal(guard(t, { ...edit, session: 'read', transcript: [read, result('t1')] }), null);
  const cat = use('t2', 'Bash', { command: `cd src && cat ../${DOC} | head -20` });
  assert.equal(guard(t, { ...edit, session: 'cat', transcript: [cat, result('t2')] }), null);
});

test('不算读过：读失败、结果还没回来、Bash 里只是提到路径', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  // 会话开在子目录里，按当前目录拼出了不存在的路径
  const wrong = use('t1', 'Read', { file_path: path.join(t.repo, 'src', DOC) });
  assert.ok(guard(t, { ...edit, session: 'err', transcript: [wrong, result('t1', true)] }));
  assert.ok(guard(t, { ...edit, session: 'pending', transcript: [use('t2', 'Read', { file_path: path.join(t.repo, DOC) })] }));
  for (const [i, command] of [`git add ${DOC}`, `ls -l ${DOC}`, `git check-ignore -q "${DOC}"`, `rm ${DOC}`].entries()) {
    assert.ok(guard(t, { ...edit, session: `bash${i}`, transcript: [use('t3', 'Bash', { command }), result('t3')] }), command);
  }
});

test('压缩之后重新算：读过的、拦过的都再拦一次', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const read = [use('t1', 'Read', { file_path: path.join(t.repo, DOC) }), result('t1')];
  assert.ok(guard(t, { ...edit, session: 'a', transcript: [...read, compact()] }));

  assert.ok(guard(t, { ...edit, session: 'b' }));
  age(t);
  assert.equal(guard(t, { ...edit, session: 'b' }), null);
  sessionStart(t, { session: 'b', source: 'resume' });
  assert.equal(guard(t, { ...edit, session: 'b' }), null);
  sessionStart(t, { session: 'b', source: 'compact' });
  assert.ok(guard(t, { ...edit, session: 'b' }));
});

test('主会话和子代理各算各的', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  assert.ok(guard(t, edit));
  age(t);
  assert.equal(guard(t, edit), null);
  assert.match(guard(t, { ...edit, agent: 'abc' }), /这个子代理/);
});

test('不拦：没有指针、指针失效、Markdown、.context/ 里的文件、环境变量关闭', () => {
  const t = repoWith({
    'src/retry.ts': RETRY_TS,
    'src/plain.ts': '// 普通注释\nconst A = 1;\n',
    'src/broken.ts': '// 改 A 前读 .context/api/missing.md\nconst A = 1;\n',
    'docs/a.md': `<!-- ${POINTER} -->\n正文\n`,
    '.context/api/other.md': `# 另一份\n\n${POINTER}\n`,
  });
  assert.equal(guard(t, { file: 'src/plain.ts', old: 'const A = 1;' }), null);
  assert.equal(guard(t, { file: 'src/broken.ts', old: 'const A = 1;' }), null);
  assert.equal(guard(t, { file: 'docs/a.md', old: '正文' }), null);
  assert.equal(guard(t, { file: '.context/api/other.md', old: '# 另一份' }), null);
  assert.equal(guard(t, { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;', env: { CONTEXT_KEEPER_POINTER_HOOK: '0' } }), null);
});
