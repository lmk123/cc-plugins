import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, commentHook } from './helpers.mjs';

const created = { type: 'create', structuredPatch: [] };

test('新写的 4 行注释块会提醒，3 行的不提醒', () => {
  const t = makeRepo({
    'src/long.ts': '// 一\n// 二\n// 三\n// 四\nconst A = 1;\n',
    'src/short.ts': '// 一\n// 二\n// 三\nconst A = 1;\n',
  });
  assert.match(commentHook(t, { file: 'src/long.ts', response: created }), /第 1–4 行/);
  assert.equal(commentHook(t, { file: 'src/short.ts', response: created }), null);
});

test('JSDoc、license 头不提醒', () => {
  const t = makeRepo({
    'src/doc.ts': '/**\n * 一\n * 二\n * 三\n * 四\n */\nexport function f() {}\n',
    'src/license.ts': '// Copyright 2026\n// Licensed under MIT\n// 三\n// 四\nconst A = 1;\n',
  });
  assert.equal(commentHook(t, { file: 'src/doc.ts', response: created }), null);
  assert.equal(commentHook(t, { file: 'src/license.ts', response: created }), null);
});

test('已有的长注释里只改一行不提醒，一半以上是新写的才提醒', () => {
  const t = makeRepo({ 'src/a.ts': '// 一\n// 二\n// 三\n// 改过的\nconst A = 1;\n' });
  const patch = (lines) => ({ type: 'update', structuredPatch: [{ oldStart: 1, newStart: 1, lines }] });
  assert.equal(commentHook(t, { file: 'src/a.ts', tool: 'Edit', response: patch([' // 一', ' // 二', ' // 三', '-// 四', '+// 改过的']) }), null);
  assert.ok(commentHook(t, { file: 'src/a.ts', tool: 'Edit', response: patch([' // 一', '+// 二', '+// 三', '+// 改过的']) }));
});

test('context-docs/ 和 .claude/ 下的文件不管', () => {
  const t = makeRepo({ '.claude/hooks/a.sh': '# 一\n# 二\n# 三\n# 四\necho 1\n' });
  assert.equal(commentHook(t, { file: '.claude/hooks/a.sh', response: created }), null);
});
