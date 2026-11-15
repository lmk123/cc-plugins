# context-keeper 模板

下面每个示例上方标注的是文件路径，不是文件内容。

## 代码注释

只和一个文件（或其中一段代码、一个配置条目）有关的，写在相关代码上方，1–3 行：一条结论，最多一句理由。`apps/web/src/api/client.ts`：

```ts
// 拦截器的注册顺序不能换：鉴权头要在签名之前补上，否则签名对不上，请求全部 401
export function setupInterceptors() {
```

约束调用方的（改这个文件的人不用知道、调用它的人要知道）不写成普通注释，写进 API 文档注释：

```ts
/** 必须在 setupInterceptors() 之后调用：拦截器里会补上鉴权头，顺序反了首个请求 401 */
export function createClient() {
```

长注释只留结论。改造前，`apps/web/src/api/retry.ts`：

```ts
// 重试次数固定为 3。以前是 5 次，但上游网关连续 5 次失败
// 会把客户端 IP 拉黑 10 分钟，线上出过一次事故。
// 首次 + 3 次重试 = 4 次，留一次余量。
// 试过在网关前加熔断，和网关限流叠加后导致长时间不可用，放弃了。
// 退避从 200ms 起指数增长。
const MAX_RETRY = 3;
```

改造后：

```ts
// 重试上限 3：网关连续 5 次失败会封 IP 10 分钟（首次 + 3 次重试，留一次余量）
// 别在网关前加熔断：和网关限流叠加后会长时间不可用
const MAX_RETRY = 3;
```

- "以前是 5 次，线上出过一次事故"是经过，留给 commit 和 PR
- 熔断方案怕以后有人重新提，写成一条「别做」
- "退避从 200ms 起指数增长"读代码就能看出来，删掉
- "连续 5 次封 IP"留着：网关规则一变，上限就该跟着变

外部系统的特性写在那个系统自己的配置条目旁边，「症状 → 原因 → 怎么办」，带观测日期。`apps/monitor/src/targets.ts`：

```ts
  {
    // 2026-11 实测：429 是业务报错（余额或分组问题），不是限流，别按限流退避重试
    // 2026-09 实测：不带 reasoning_effort: 'none' 会 400
    site: 'example-relay',
    protocol: 'openai',
```

不写的：怎么测出来的、测了几次、当时的耗时表、上线进度。

涉及整个文件的写在文件头注释里。

## rule

只给**几个文件共用**的内容，或没法写注释的文件（JSON、lockfile、生成物、二进制资源）用。只和一个能写注释的文件有关的，写成注释。

**frontmatter 的 `---` 必须是文件第一行**，前面不能有任何内容（包括注释和空行）。正文"做什么"在前，最多一句理由跟在后面，不超过 10 行（不算 frontmatter 和空行）。

包内 rule，glob 相对该包写。文件 `apps/web/.claude/rules/styling/tokens.md`：

```markdown
---
paths:
  - "src/styles/tokens/*.css"
---

改这里的 token 后必须跑 `pnpm tokens:build`，否则 `src/styles/generated/` 不会更新，但页面不报错。
```

根作用域的 rule（单仓库的所有 rule，或 monorepo 的跨包 rule），glob 从仓库根写完整路径。文件 `.claude/rules/db/schema-web-sync.md`：

```markdown
---
paths:
  - "packages/schema/src/tables/*.ts"
  - "apps/web/src/generated/db/*.ts"
---

改 schema 后必须跑 `pnpm db:generate` 重新生成 apps/web 的类型，生成物不能手改。
```

## skill

```markdown
---
name: release
description: 发布到生产环境。当用户要求发布、上线、打 tag 时使用。
---

# 发布

1. <步骤>
2. <步骤>
```

description 要写清"什么时候用"，它是启动时唯一常驻的部分。流程要用的参考资料放在 skill 目录下的其他文件里，正文写明哪一步读哪个文件；参考资料同样只写结论，不写经过。

## CLAUDE.md 索引小节

根 CLAUDE.md 末尾：

```markdown
## 更多上下文
- 各包和各模块的专属约定会按路径通过 rule 自动加载，不用手动查
- 记项目知识：只记 Claude 不知道就会做错、读代码推不出来、测试和 lint 拦不住、错了不报错或代价高的结论（被纠正过的做法、外部系统的实测特性、不可逆操作的约束），一条结论最多带一句理由。只涉及一个文件的写成紧贴代码的短注释，几个文件共用的写进 `.claude/rules/`，流程写成 skill（装了 context-keeper 插件就用 `record-context`）。经过、状态、实测流水留在 commit 和 PR 里，不写进仓库文件，也不留指针；不写成长注释，也不只记在自动记忆里。改动让已有的结论不再成立时，同一次改动里改掉或删掉
- 发布流程：用 `/release`
```

- 第二行是常驻的写入约定，**不要省**：没有它，Claude 会按默认习惯把背景写进长注释、文档或自动记忆。
- 单仓库去掉"各包"的说法。
- 索引里只列根作用域的 skill：包内 skill 要碰到该包的文件后才可用，名字也带目录前缀，写进根索引会指向一个调不到的命令。
