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

// 指针有没有写"什么时候读"。没写的（"原因见 X""详见 X"）只能靠 Claude 猜要不要读
export const TRIGGER_RE = /(前|时|之前|之后|如果|若|涉及|\bbefore\b|\bwhen\b|\bif\b)/i;
