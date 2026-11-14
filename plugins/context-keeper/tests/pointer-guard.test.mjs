import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, guard, sessionStart, age, use, result, compact } from './helpers.mjs';

const DOC = 'context-docs/api/retry-policy.md';
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

test('查得到消息 id 时按消息算：同一条消息里隔多久都继续拦，换了一条消息 3 秒内也放行', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const call = (id, msg) => use(id, 'Edit', { file_path: path.join(t.repo, 'src/retry.ts') }, msg);
  // 一条消息里两个 Edit，中间夹了一个跑了 5 秒的命令
  const same = [call('e1', 'm1'), call('e2', 'm1')];
  assert.ok(guard(t, { ...edit, session: 'slow', transcript: same, toolUseId: 'e1' }));
  age(t);
  assert.ok(guard(t, { ...edit, session: 'slow', transcript: same, toolUseId: 'e2' }));
  // Claude 看到拦截消息后马上重试：新的一条消息，不用等 3 秒
  assert.ok(guard(t, { ...edit, session: 'fast', transcript: [call('e1', 'm1')], toolUseId: 'e1' }));
  const retry = [call('e1', 'm1'), result('e1', true), call('e3', 'm2')];
  assert.equal(guard(t, { ...edit, session: 'fast', transcript: retry, toolUseId: 'e3' }), null);
});

test('文件头前面的 <?php、use client 指令、<script> 标签不算代码', () => {
  const t = repoWith({
    'src/a.php': `<?php\ndeclare(strict_types=1);\n// ${POINTER}\n\nnamespace App;\n\nfunction f() {\n  return 1;\n}\n`,
    'src/a.tsx': `'use client';\n// ${POINTER}\n\nimport x from 'x';\n\nexport function C() {\n  return 1;\n}\n`,
    'src/a.vue': `<script setup lang="ts">\n// ${POINTER}\n\nimport x from 'x';\nconst a = 1;\n</script>\n`,
    // 指令下面紧贴着声明的注释是那个声明的，不算文件头
    'src/b.tsx': `'use client';\n// ${POINTER}\nconst A = 1;\n\nexport function C() {\n  return 1;\n}\n`,
  });
  assert.ok(guard(t, { file: 'src/a.php', old: '  return 1;', session: 'php' }));
  assert.ok(guard(t, { file: 'src/a.tsx', old: '  return 1;', session: 'tsx' }));
  assert.ok(guard(t, { file: 'src/a.vue', old: 'const a = 1;', session: 'vue' }));
  assert.equal(guard(t, { file: 'src/b.tsx', old: '  return 1;', session: 'decl' }), null);
});

test('不是 git 仓库时拿启动会话的目录当项目根，文件不在它下面就不管', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  fs.rmSync(path.join(t.repo, '.git'), { recursive: true });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  assert.ok(guard(t, { ...edit, session: 'in', env: { CLAUDE_PROJECT_DIR: t.repo } }));
  assert.equal(guard(t, { ...edit, session: 'out', env: { CLAUDE_PROJECT_DIR: path.join(t.repo, 'other') } }), null);
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

test('领域目录名以 context-docs 结尾时，读了别的同名文档不算读过这份', () => {
  const doc = 'context-docs/user-context-docs/notes.md';
  const t = makeRepo({ [doc]: '# 会话\n', 'context-docs/notes.md': '# 别的\n', 'src/s.ts': `// 改会话前读 ${doc}\nconst S = 1;\n` });
  const edit = { file: 'src/s.ts', old: 'const S = 1;' };
  const other = use('t1', 'Bash', { command: 'cat context-docs/notes.md' });
  assert.ok(guard(t, { ...edit, session: 'other', transcript: [other, result('t1')] }));
  const own = use('t2', 'Bash', { command: `cat ${doc}` });
  assert.equal(guard(t, { ...edit, session: 'own', transcript: [own, result('t2')] }), null);
});

test('Bash 里用重定向读过也算读过', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const cat = use('t1', 'Bash', { command: `head -20 <${DOC}` });
  assert.equal(guard(t, { ...edit, session: 'redir', transcript: [cat, result('t1')] }), null);
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

test('不拦：没有指针、指针失效、Markdown、context-docs/ 里的文件、环境变量关闭', () => {
  const t = repoWith({
    'src/retry.ts': RETRY_TS,
    'src/plain.ts': '// 普通注释\nconst A = 1;\n',
    'src/broken.ts': '// 改 A 前读 context-docs/api/missing.md\nconst A = 1;\n',
    'docs/a.md': `<!-- ${POINTER} -->\n正文\n`,
    'context-docs/api/other.md': `# 另一份\n\n${POINTER}\n`,
  });
  assert.equal(guard(t, { file: 'src/plain.ts', old: 'const A = 1;' }), null);
  assert.equal(guard(t, { file: 'src/broken.ts', old: 'const A = 1;' }), null);
  assert.equal(guard(t, { file: 'docs/a.md', old: '正文' }), null);
  assert.equal(guard(t, { file: 'context-docs/api/other.md', old: '# 另一份' }), null);
  assert.equal(guard(t, { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;', env: { CONTEXT_KEEPER_POINTER_HOOK: '0' } }), null);
});

test('Bash 里读的路径只是以文档路径结尾、目录名不同的，不算读过', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const other = use('t1', 'Bash', { command: `cat src/user-${DOC}` });
  assert.ok(guard(t, { ...edit, session: 'suffix', transcript: [other, result('t1')] }));
});

test('Windows 路径（反斜杠）Read 过文档也算读过', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const read = use('t1', 'Read', { file_path: path.join(t.repo, DOC).split('/').join('\\') });
  assert.equal(guard(t, { ...edit, session: 'win', transcript: [read, result('t1')] }), null);
});

test('Windows 路径（反斜杠）Bash 里 cat 过文档也算读过', () => {
  const t = repoWith({ 'src/retry.ts': RETRY_TS });
  const edit = { file: 'src/retry.ts', old: 'const MAX_RETRY = 3;' };
  const cat = use('t1', 'Bash', { command: `cat ${DOC.split('/').join('\\')}` });
  assert.equal(guard(t, { ...edit, session: 'win-bash', transcript: [cat, result('t1')] }), null);
});

test('改名前的旧目录 .context/ 里的指针照样拦，并提示改名', () => {
  const old = ['.context', 'api/retry-policy.md'].join('/');
  const t = makeRepo({ [old]: '# 重试策略\n', 'src/r.ts': `// 改重试次数前读 ${old}\nconst R = 3;\n` });
  const edit = { file: 'src/r.ts', old: 'const R = 3;' };
  const msg = guard(t, edit);
  assert.match(msg, /src\/r\.ts:1/);
  assert.match(msg, /organize-context/);
  const read = use('t1', 'Read', { file_path: path.join(t.repo, old) });
  assert.equal(guard(t, { ...edit, session: 'read-old', transcript: [read, result('t1')] }), null);
});
