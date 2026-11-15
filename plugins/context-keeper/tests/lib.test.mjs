// lib/ 里纯函数的单元测试：Markdown 正文行、路径段、源码里哪些位置是注释
import test from 'node:test';
import assert from 'node:assert/strict';
import { proseLines, segmentIndex, segmentIndexes } from '../scripts/lib/markdown.mjs';
import { analyzeComments, langFor, scanSource } from '../scripts/lib/comments.mjs';

// 旧版文档目录名拆开写，理由见 check.test.mjs
const DOCS = ['context', 'docs'].join('-');
const DOT = ['', 'context'].join('.');

test('segmentIndex 只认完整的目录名', () => {
  const p = `a/${DOCS}/x/user-${DOCS}/${DOCS}/y.md`;
  assert.equal(segmentIndex(p, `${DOCS}/`), 2);
  assert.equal(segmentIndex(`user-${DOCS}/y.md`, `${DOCS}/`), -1);
  assert.equal(segmentIndex(`cat "user-${DOCS}/y.md"`, `${DOCS}/`, true), -1);
  assert.equal(segmentIndex(`cat "${DOCS}/y.md"`, `${DOCS}/`, true), 5);
  assert.equal(segmentIndex(`见（${DOCS}/y.md）`, `${DOCS}/`, true), 2);
  // 一行里的每一处都要：同一行可以既有字符串里的路径，也有注释里的指针
  assert.deepEqual(segmentIndexes(`"${DOCS}/a" // ${DOCS}/b x-${DOCS}/c`, `${DOCS}/`, true), [1, DOCS.length + 8]);
  // 正则里转义的点后面的不是路径
  assert.equal(segmentIndex(`re = /\\${DOT}\//`, `${DOT}/`, true), -1);
  // 取属性再做除法不是路径；括号、引号里的路径照认
  assert.equal(segmentIndex(`const v = getApp()${DOT}/2;`, `${DOT}/`, true), -1);
  assert.equal(segmentIndex(`const v = a?${DOT}/n + b[0]${DOT}/n;`, `${DOT}/`, true), -1);
  assert.equal(segmentIndex(`[文档](${DOT}/api/x.md)`, `${DOT}/`, true), 5);
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

// 一行里有没有注释（1 / 0），以及某个位置是不是落在注释里
const scan = (file, text) => scanSource(text.split('\n'), langFor(file));
const flags = (file, text) => scan(file, text).spans.map((x) => (x.length ? 1 : 0)).join('');
const inComment = (file, text, mark = 'P') => {
  const lines = text.split('\n');
  const k = lines.findIndex((l) => l.includes(mark));
  const p = lines[k].indexOf(mark);
  return scan(file, text).spans[k].some(([from, to]) => p >= from && p < to);
};

test('scanSource 按语言的注释语法认：别的语言的注释符开头的行不是注释', () => {
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

test('scanSource：行尾注释的注释符要属于这门语言、前面是空白、不在字符串里', () => {
  assert.equal(inComment('a.ts', 'const A = 3; // 见 P'), true);
  assert.equal(inComment('a.ts', 'call(); /* 见 P */'), true);
  assert.equal(inComment('a.ts', "const A = 'P';"), false);
  assert.equal(inComment('a.ts', 'const A = base + " #see " + "P";'), false);
  assert.equal(inComment('a.ts', "const A = ' // P';"), false);
  assert.equal(inComment('a.ts', "f('x'); // don't 改，见 P"), true);
  // 块注释收了尾，后面的代码不算注释
  assert.equal(inComment('a.ts', "/* 说明 */ const A = 'P';"), false);
  // // 和 /* 紧贴在语句结尾后面的也认；# 前面要是空白
  assert.equal(inComment('a.ts', 'const A = 3;// 见 P'), true);
  assert.equal(inComment('a.ts', 'fn(a)/* 见 P */'), true);
  assert.equal(inComment('a.sh', 'echo a#见 P'), false);
  assert.equal(inComment('a.vue', '<div><!-- 见 P --></div>'), true);
  assert.equal(inComment('a.sh', 'rsync -a --exclude P src/ dst/'), false);
  assert.equal(inComment('a.sh', 'run x # 见 P'), true);
  assert.equal(inComment('a.sql', 'select 1; -- 见 P'), true);
  // 扩展名表里没有的文件：# 和 // 前面是空白才算，URL 里的 // 不算
  assert.equal(inComment('.env.example', 'LIMIT=3 # 见 P'), true);
  assert.equal(inComment('.env.example', 'URL=https://host/P'), false);
});

test('scanSource：配不上对的引号当作撇号，后面的行尾注释照认；位置落在没收尾的字符串里的不算', () => {
  assert.equal(inComment('a.rs', "fn f<'a>(x: &str) {} // 见 P"), true);
  assert.equal(inComment('a.yml', "title: Don't panic # 见 P"), true);
  assert.equal(inComment('a.yml', "title: 'it # P"), true); // 这一行里引号没配上对：不是字符串
  assert.equal(inComment('a.yml', "title: 'it # P' # 说明"), false);
});

test('scanSource：不从行首开始的块注释，续行也是注释；模板字符串里以 // 开头的行不是', () => {
  assert.equal(inComment('a.ts', 'const a = 1; /* 开头\n  见 P\n*/\nconst b = 2;'), true);
  assert.equal(flags('a.ts', 'const a = 1; /* 开头\n  见 P\n*/ const b = 2;\nconst c = 3;'), '1110');
  assert.equal(inComment('a.vue', '<p>文字 <!-- 开头\n见 P\n--></p>'), true);
  assert.equal(inComment('a.ts', 'const s = `\n// 见 P\n`;'), false);
  // 块注释里的反引号不是模板字符串的开头：后面的行注释照认
  assert.equal(inComment('a.ts', '/*\n * 用 ` 包起来\n */\n// 见 P'), true);
});

test('长注释块和信号词：只认独立成行的块，JSDoc 整块跳过，字符串里的不算', () => {
  const lines = (r) => r.blocks.map((b) => [b.start, b.end, b.lines, b.kind]);
  const block = analyzeComments('/*\n * 一\n * 二\n * 三\n * 以前是 5 次\n */\nconst a = 1;\n', 'a.ts');
  assert.deepEqual(lines(block), [[1, 6, 4, 'block']]);
  assert.deepEqual(block.signals.map((x) => x.line), [5]);
  // 行尾开头的块注释不是独立成段的注释
  const trailing = analyzeComments('const a = 1; /* 一\n 二\n 三\n 以前是 5 次\n*/\n', 'a.ts');
  assert.deepEqual([trailing.blocks, trailing.signals], [[], []]);
  const jsdoc = analyzeComments('/**\n * 一\n * 二\n * 三\n * 以前是 5 次\n */\nexport const a = 1;\n', 'a.ts');
  assert.deepEqual([jsdoc.blocks, jsdoc.signals], [[], []]);
  const tpl = analyzeComments('const s = `\n// 一\n// 二\n// 三\n// 以前是 5 次\n`;\n', 'a.ts');
  assert.deepEqual([tpl.blocks, tpl.signals], [[], []]);
  const html = analyzeComments('<!--\n一\n二\n三\n以前是 5 次\n-->\n<div></div>\n', 'a.vue');
  assert.deepEqual(lines(html), [[1, 6, 4, 'html']]);
  assert.deepEqual(html.signals.map((x) => x.line), [5]);
});
