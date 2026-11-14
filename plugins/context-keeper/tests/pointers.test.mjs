import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANY_POINTER_RE, LEGACY_POINTER_RE, escapeLinkPath, isDocLink, lastSegmentIndex, linkDefs, linkPath, linksIn, maskLinkTargets, pointersIn, proseLines,
  resolveLink, resolvePointer, segmentIndex, splitLine, TRIGGER_RE,
} from '../scripts/lib/pointers.mjs';

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
  assert.deepEqual(pointersIn('// 改 X 前读 apps/web/context-docs/api/retry-policy.md（经过）'), ['apps/web/context-docs/api/retry-policy.md']);
  assert.deepEqual(pointersIn('详见context-docs/a.md 和 ./context-docs/b/c-d.md'), ['context-docs/a.md', 'context-docs/b/c-d.md']);
  assert.deepEqual(pointersIn('!context-docs/**/*.md'), []);
  assert.deepEqual(pointersIn('my-context-docs/a.md 和 src/build-context-docs/b.md'), []);
  assert.deepEqual(pointersIn('没有指针'), []);
});

test('resolvePointer 去掉紧贴在路径前面的中文', () => {
  const exists = (p) => p === '包/context-docs/a.md' || p === 'apps/context-docs/b.md';
  assert.equal(resolvePointer('见包/context-docs/a.md', exists), '包/context-docs/a.md');
  assert.equal(resolvePointer('apps/context-docs/b.md', exists), 'apps/context-docs/b.md');
  assert.equal(resolvePointer('apps/context-docs/missing.md', exists), null);
});

test('pointersIn 默认只认新目录；传入旧目录或两种都认的正则时按它认', () => {
  const line = '// 读 .context/a.md 和 pkg/context-docs/b.md，foo.context/c.md 不算';
  assert.deepEqual(pointersIn(line), ['pkg/context-docs/b.md']);
  assert.deepEqual(pointersIn(line, LEGACY_POINTER_RE), ['.context/a.md']);
  assert.deepEqual(pointersIn(line, ANY_POINTER_RE), ['.context/a.md', 'pkg/context-docs/b.md']);
});

test('segmentIndex / lastSegmentIndex 只认完整的目录名', () => {
  const p = 'a/context-docs/x/user-context-docs/context-docs/y.md';
  assert.equal(segmentIndex(p, 'context-docs/'), 2);
  assert.equal(lastSegmentIndex(p, 'context-docs/'), p.lastIndexOf('/context-docs/') + 1);
  assert.equal(lastSegmentIndex('user-context-docs/y.md', 'context-docs/'), -1);
  assert.equal(lastSegmentIndex('context-docs/y.md', 'context-docs/'), 0);
  assert.equal(segmentIndex('cat "user-context-docs/y.md"', 'context-docs/', true), -1);
  assert.equal(segmentIndex('cat "context-docs/y.md"', 'context-docs/', true), 5);
});

test('linksIn 认行内链接和引用式定义，行内代码里的不认', () => {
  const line = '- 改 X 前读 [0039](../targets/k.md) 和 [a [b]](<x y.md#s> "标题")，`[示例](no.md)`';
  assert.deepEqual(linksIn(line).map((l) => [l.text, l.target, line.slice(l.at, l.at + l.target.length)]), [
    ['0039', '../targets/k.md', '../targets/k.md'],
    ['a [b]', '<x y.md#s>', '<x y.md#s>'],
  ]);
  assert.deepEqual(linksIn('[id]: ../api/x.md').map((l) => l.target), ['../api/x.md']);
  assert.deepEqual(linksIn('没有链接 context-docs/a.md'), []);
});

test('maskLinkTargets 抹掉链接目标、长度不变，链接文字里的路径照样认', () => {
  const line = '[apps/m/context-docs/t/k.md](apps/m/context-docs/t/k.md)';
  const masked = maskLinkTargets(line);
  assert.equal(masked.length, line.length);
  assert.deepEqual(pointersIn(masked), ['apps/m/context-docs/t/k.md']);
  assert.match(masked.slice(masked.indexOf('](')), /^\]\( +\)$/);
});

test('resolveLink 按所在文件的目录解析，开头是 / 的按仓库根，外链和纯锚点不解析', () => {
  const f = 'apps/m/context-docs/models/a.md';
  assert.equal(resolveLink(f, '../targets/k.md'), 'apps/m/context-docs/targets/k.md');
  assert.equal(resolveLink(f, 'apps/m/context-docs/targets/k.md'), 'apps/m/context-docs/models/apps/m/context-docs/targets/k.md');
  assert.equal(resolveLink(f, '/apps/m/context-docs/targets/k.md#节'), 'apps/m/context-docs/targets/k.md');
  assert.equal(resolveLink(f, '<b c.md>'), 'apps/m/context-docs/models/b c.md');
  assert.equal(resolveLink(f, 'b%20c.md'), 'apps/m/context-docs/models/b c.md');
  assert.equal(resolveLink(f, 'https://x.com/context-docs/a.md'), null);
  assert.equal(resolveLink(f, '#节'), null);
  assert.equal(resolveLink('CLAUDE.md', '../x.md'), null);
});

test('isDocLink：落在文档目录里的 Markdown，或者目标里写了文档目录名', () => {
  assert.ok(isDocLink('context-docs/api/a.md', 'api/a.md'));
  assert.ok(isDocLink('x/context-docs/a.md', 'context-docs/a.md'));
  assert.ok(!isDocLink('docs/a.md', '../docs/a.md'));
  assert.ok(!isDocLink('context-docs/api/a.png', 'a.png'));
  assert.ok(!isDocLink(null, 'https://x.com/context-docs/a.md'));
});

test('linksIn 不把脚注定义当链接；引用式用法从 linkDefs 取目标', () => {
  assert.deepEqual(linksIn('[^1]: context-docs/a.md 说明'), []);
  const defs = linkDefs('[A]: ../x.md\n```\n[b]: ../y.md\n```\n');
  assert.deepEqual([...defs], [['a', '../x.md']]);
  assert.deepEqual(linksIn('读 [文字][a]、[a][]、[A] 和 [b]', defs).map((l) => [l.text, l.target, l.ref]), [
    ['文字', '../x.md', true], ['a', '../x.md', true], ['A', '../x.md', true],
  ]);
  assert.deepEqual(linksIn('[a]: ../x.md', defs).map((l) => l.def), [true]);
  assert.equal(maskLinkTargets('读 [文字][a]', linksIn('读 [文字][a]', defs)), '读 [文字][a]');
});

test('linksIn：反斜杠转义的方括号不是链接，缩进的定义行是定义不是引用式用法', () => {
  assert.deepEqual(linksIn('示例 \\[文字](context-docs/x.md)'), []);
  const defs = linkDefs('- 列表\n    [m]: ../x.md\n');
  assert.deepEqual([...defs], [['m', '../x.md']]);
  assert.deepEqual(linksIn('    [m]: ../x.md', defs).map((l) => l.def), [true]);
});

test('isDocLink 只认新目录，写了旧目录的链接另报旧版路径', () => {
  assert.ok(!isDocLink('.context/api/a.md', '.context/api/a.md'));
});

test('proseLines 跳过缩进代码块，列表项里缩进的续行不算代码块', () => {
  const idx = (text) => proseLines(text).filter(([l]) => l.trim()).map(([, i]) => i);
  // 空行之后缩进 4 格：代码块，到缩进不够的行为止
  assert.deepEqual(idx('正文\n\n    [r]: context-docs/x.md\n    第二行\n回到正文'), [0, 4]);
  // 没有空行隔开的缩进行是段落的续行
  assert.deepEqual(idx('正文\n    续行'), [0, 1]);
  // 列表项里从内容的缩进算起：缩进 4 格的定义是列表项的续行，缩进 6 格才是代码块
  assert.deepEqual(idx('- 列表\n\n    [m]: ../x.md\n\n      代码'), [0, 2]);
  // 空行之后缩进不够、不是列表项的，离开了列表
  assert.deepEqual(idx('- 列表\n\n正文\n\n    代码'), [0, 2]);
  // 源码不认代码块
  assert.deepEqual(proseLines('a\n\n    b', true).map(([, i]) => i), [0, 1, 2]);
});

test('linkDefs 不认缩进代码块里的定义', () => {
  assert.deepEqual([...linkDefs('正文\n\n    [r]: ../x.md\n')], []);
});

test('linkPath 逐段解码，%23、%3F 这类保留字符也解；escapeLinkPath 转义回去', () => {
  assert.equal(linkPath('api/c%23-notes.md#节'), 'api/c#-notes.md');
  assert.equal(linkPath('api/a%3Fb%20c.md'), 'api/a?b c.md');
  assert.equal(linkPath('api/100%.md'), 'api/100%.md'); // 解不开的段照留
  assert.equal(escapeLinkPath('../api/c# (v2)?.md'), '../api/c%23%20%28v2%29%3F.md');
  assert.equal(linkPath(escapeLinkPath('a/c# (v2)?%.md')), 'a/c# (v2)?%.md');
});

test('splitLine：链接带上按所在文件解析的 resolved，scan 抹掉链接目标；不是 Markdown 时不认链接', () => {
  const line = '改前读 [a](../api/x.md) 和 context-docs/api/y.md';
  const { links, scan } = splitLine('context-docs/models/m.md', line, new Map());
  assert.deepEqual(links.map((l) => l.resolved), ['context-docs/api/x.md']);
  assert.deepEqual(pointersIn(scan), ['context-docs/api/y.md']);
  assert.deepEqual(splitLine('src/a.ts', line, null), { links: [], scan: line });
});
