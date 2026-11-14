// lib/ 里纯函数的单元测试：Markdown 正文行、路径段、一行源码是不是注释
import test from 'node:test';
import assert from 'node:assert/strict';
import { proseLines, segmentIndex } from '../scripts/lib/markdown.mjs';
import { commentLines, langFor, trailingCommentBefore } from '../scripts/lib/comments.mjs';

// 旧版文档目录名拆开写，理由见 check.test.mjs
const DOCS = ['context', 'docs'].join('-');

test('segmentIndex 只认完整的目录名', () => {
  const p = `a/${DOCS}/x/user-${DOCS}/${DOCS}/y.md`;
  assert.equal(segmentIndex(p, `${DOCS}/`), 2);
  assert.equal(segmentIndex(`user-${DOCS}/y.md`, `${DOCS}/`), -1);
  assert.equal(segmentIndex(`cat "user-${DOCS}/y.md"`, `${DOCS}/`, true), -1);
  assert.equal(segmentIndex(`cat "${DOCS}/y.md"`, `${DOCS}/`, true), 5);
  assert.equal(segmentIndex(`见（${DOCS}/y.md）`, `${DOCS}/`, true), 2);
});

test('proseLines 跳过缩进代码块，列表项里缩进的续行不算代码块', () => {
  const idx = (text) => proseLines(text).filter(([l]) => l.trim()).map(([, i]) => i);
  // 空行之后缩进 4 格：代码块，到缩进不够的行为止
  assert.deepEqual(idx('正文\n\n    示例\n    第二行\n回到正文'), [0, 4]);
  // 没有空行隔开的缩进行是段落的续行
  assert.deepEqual(idx('正文\n    续行'), [0, 1]);
  // 列表项里从内容的缩进算起：缩进 4 格的是列表项的续行，缩进 6 格才是代码块
  assert.deepEqual(idx('- 列表\n\n    续行\n\n      代码'), [0, 2]);
  // 空行之后缩进不够、不是列表项的，离开了列表
  assert.deepEqual(idx('- 列表\n\n正文\n\n    代码'), [0, 2]);
  // 嵌套列表之后空一行回到父项：父项的段落按父项内容的缩进算，缩进 4 格还是段落
  assert.deepEqual(idx('- 父项\n  - 子项\n\n  父项第二段\n\n    父项第三段'), [0, 1, 3, 5]);
  // 列表后面不空行直接接标题，列表结束：后面空行之后缩进 4 格的是代码块
  assert.deepEqual(idx('- a\n# 标题\n\n    代码'), [0, 1]);
});

test('proseLines：`- - -`、`* * *` 是分隔线不是列表项；标题、分隔线、围栏结束之后不空行也能开始缩进代码块', () => {
  const idx = (t) => proseLines(t).map(([, i]) => i);
  assert.deepEqual(idx('* * *\n\n    代码'), [0, 1]);
  assert.deepEqual(idx('- - -\n\n    代码'), [0, 1]);
  assert.deepEqual(idx('## 示例\n    代码\n正文'), [0, 2]);
  assert.deepEqual(idx('***\n    代码'), [0]);
  assert.deepEqual(idx('```\nx\n```\n    代码\n正文'), [4]);
});

test('commentLines 按语言的注释语法认：别的语言的注释符开头的行不是注释', () => {
  const flags = (file, text) => commentLines(text.split('\n'), langFor(file)).map((x) => (x ? 1 : 0)).join('');
  // shell 只认 #：折行的 `--flag`、通配符开头的行都是命令
  assert.equal(flags('a.sh', '# 说明\ntar czf x \\\n  --exclude y \\\n  *.md'), '1000');
  // SQL 认 --
  assert.equal(flags('a.sql', '-- 说明\nselect 1;'), '10');
  // TS：行注释、块注释的每一行、JSX 注释；# 开头的不是
  assert.equal(flags('a.tsx', '// 一\n/*\n 二\n*/\n{/* 三\n四 */}\n#x = 1;'), '1111110');
  // 没闭合的块注释不算，免得把后面整份文件当成注释
  assert.equal(flags('a.ts', '/* 没收尾\nconst a = 1;'), '00');
  // Python：行首的三引号是 docstring；赋值的三引号字符串不是，但收尾的那一行不会被当成新的开头
  assert.equal(flags('a.py', '"""\n文档\n"""\nx = """\n数据\n"""\n# 注释'), '1110001');
  // 扩展名表里没有的文件只认 # 和 //：ignore 规则不是注释
  assert.equal(flags('.prettierignore', '# 说明\n**/dist/\n/*\n*/tmp'), '1000');
  assert.equal(flags('Caddyfile', '# 说明\nreverse_proxy x'), '10');
});

test('trailingCommentBefore：注释符要属于这门语言、前面是空白、不在字符串里', () => {
  const at = (line) => line.indexOf('P');
  const trailing = (file, line) => trailingCommentBefore(line, at(line), langFor(file));
  assert.equal(trailing('a.ts', 'const A = 3; // 见 P'), true);
  assert.equal(trailing('a.ts', 'call(); /* 见 P */'), true);
  assert.equal(trailing('a.ts', "const A = 'P';"), false);
  assert.equal(trailing('a.ts', 'const A = base + " #see " + "P";'), false);
  assert.equal(trailing('a.ts', "const A = ' // P';"), false);
  assert.equal(trailing('a.ts', "f('x'); // don't 改，见 P"), true);
  assert.equal(trailing('a.sh', 'rsync -a --exclude P src/ dst/'), false);
  assert.equal(trailing('a.sh', 'run x # 见 P'), true);
  assert.equal(trailing('a.sql', 'select 1; -- 见 P'), true);
  // 扩展名表里没有的文件：# 和 // 前面是空白才算，URL 里的 // 不算
  assert.equal(trailing('.env.example', 'LIMIT=3 # 见 P'), true);
  assert.equal(trailing('.env.example', 'URL=https://host/P'), false);
});
