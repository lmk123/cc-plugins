import test from 'node:test';
import assert from 'node:assert/strict';
import { pointersIn, resolvePointer, TRIGGER_RE } from '../scripts/lib/pointers.mjs';

// 传给 TRIGGER_RE 的是去掉指针路径之后的那一行
test('TRIGGER_RE 认得写了"什么时候读"的指针', () => {
  for (const s of [
    '改重试次数或退避前读 （事故经过）',
    '改重试次数前阅读 ',
    '新增接口时对照 ',
    '改动前通读 ',
    '升级 SDK 前过一遍 ',
    '改这里前确认 ',
    '改 X 之前读 ',
    '排查 OOM 时可参考 ',
    '调用时注意，细节在 ',
    '改权限时读 ',
    '要改超时的话先读 ',
    '想调大并发先读 ',
    '改超时时间前最好读 ',
    '迁移之后核对 ',
    'Before changing the retry count, read ',
  ]) assert.ok(TRIGGER_RE.test(s), s);
});

test('TRIGGER_RE 不把话题式的指针当成写了触发条件', () => {
  for (const s of [
    '原因见 ',
    '详见 ',
    '以前是 5 次，详见 ',
    '目前的方案见 ',
    '超时的背景见 ',
    '同时参考 ',
    '前端约定见 ',
    '时间线见 ',
    '前 3 次失败的记录见 ',
    '运行时的行为见 ',
    'see ',
  ]) assert.ok(!TRIGGER_RE.test(s), s);
});

test('pointersIn 取出一行里的指针', () => {
  assert.deepEqual(pointersIn('// 改 X 前读 apps/web/.context/api/retry-policy.md（经过）'), ['apps/web/.context/api/retry-policy.md']);
  assert.deepEqual(pointersIn('详见.context/a.md 和 ./.context/b/c-d.md'), ['.context/a.md', '.context/b/c-d.md']);
  assert.deepEqual(pointersIn('!.context/**/*.md'), []);
  assert.deepEqual(pointersIn('没有指针'), []);
});

test('resolvePointer 去掉紧贴在路径前面的中文', () => {
  const exists = (p) => p === '包/.context/a.md' || p === 'apps/.context/b.md';
  assert.equal(resolvePointer('见包/.context/a.md', exists), '包/.context/a.md');
  assert.equal(resolvePointer('apps/.context/b.md', exists), 'apps/.context/b.md');
  assert.equal(resolvePointer('apps/.context/missing.md', exists), null);
});
