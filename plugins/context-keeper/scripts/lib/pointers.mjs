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
// 认的是"…前 / …时 / …之后"。按排除来认：前、时后面跟什么动词都行（"前阅读""时对照""前确认"），
// 只排除它们属于别的词的情况——"以前""目前""超时""同时"（前面的字），"前端""前缀""时间""时序"（后面的字），"前 3 次"。
// 后面跟的字列不完，前、时开头的名词列得完。传进来的文本要先去掉指针路径本身
export const TRIGGER_RE = new RegExp([
  '(?<![以目从先此提当眼面日向往靠超空])前(?![端缀置面者后提景台方身述言任辈期夕往进驱沿锋线天年次]|\\s*[0-9一二两三四五六七八九十几])',
  '(?<![超同当实临暂及随定小平有届按准历耗即延何那顿]|运行)时(?![间候序刻期钟区长效代机延限段点速常而光])',
  '之后(?![的者])',
  '的时候|的话|如果|若(?!干)|涉及|遇到|碰到|一旦|先(?:阅?读|看|查|翻)',
  '\\b(?:before|when|whenever|if|prior to)\\b',
].join('|'), 'i');
