// 指向 .context/ 文档的指针，供 check.mjs 和 pointer-guard.mjs 共用。
// 指针一律写仓库根起的路径（`<作用域>/.context/<领域>/<slug>.md`）。这个文件会随 check.mjs 复制进项目，注释里不写具体示例路径，免得被当成失效指针。

// 路径段允许中文等非 ASCII 字符；前面紧贴的字符只排除 ASCII 的路径字符，这样"详见.context/…"这种紧贴中文的写法也能认出来
export const POINTER_RE = /(?<![\w./-])((?:[\p{L}\p{N}_.-]+\/)*\.context\/[\p{L}\p{N}_./-]*?[\p{L}\p{N}_-]\.md)(?![\p{L}\p{N}_.-])/gu;

// 一行里的指针原文（去重，去掉开头的 ./）
export function pointersIn(line) {
  const out = [];
  if (!line.includes('.context/')) return out;
  for (const m of line.matchAll(POINTER_RE)) {
    const raw = m[1].replace(/^\.\//, '');
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

// 中文正文紧贴路径时（"见包/.context/…"），前面的字会被并进第一段：逐个去掉开头的非 ASCII 字符再试，
// 第一段至少留一个字符，免得退化成根作用域的 `.context/`。exists(p) 判断仓库根起的路径是否存在，都不存在时返回 null
export function resolvePointer(raw, exists) {
  for (let q = raw; ; q = q.replace(/^[^\x00-\x7f]/u, '')) {
    if (exists(q)) return q;
    if (!/^[^\x00-\x7f][^/]/u.test(q)) return null;
  }
}

// 指针有没有写"什么时候读"。没写的（"原因见 X""详见 X"）只能靠 Claude 猜要不要读。
// 认的是收尾的"…前 / …时 / …之后"：后面要么断句，要么紧跟"读 / 看 / 先…"这类字，或"最好 / 一定 / 记得 / 也 / 都…"这类修饰词；
// "以前""目前""超时""同时"这类词里的前、时不算。传进来的文本要先去掉指针路径本身
const AFTER = '(?=\\s*(?:$|[\\n，,、：:；;。（(）)]|先|再|必|要|请|务|应|需|须|得|去|读|看|查|参|翻|最好|一定|记得|建议|首先|重新|也|都|可|别|还|就|均))';
export const TRIGGER_RE = new RegExp([
  `(?<![以目从先此提当眼面])前${AFTER}`,
  `(?<![超同当实临暂及随定小平有届按准历耗])时${AFTER}`,
  `之后${AFTER}`,
  '的时候|如果|若(?!干)|涉及|遇到|碰到|一旦',
  '\\b(?:before|when|whenever|if|prior to)\\b',
].join('|'), 'i');
