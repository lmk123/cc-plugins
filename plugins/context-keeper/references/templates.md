# context-keeper 模板

下面每个示例上方标注的是文件路径，不是文件内容。所有指向文档的路径都从仓库根写起。

## rule

**frontmatter 的 `---` 必须是文件第一行**，前面不能有任何内容（包括注释和空行）。正文"做什么"在前，原因、经过、数字跟在后面，不超过 20 行（不算 frontmatter 和空行）。

包内 rule，glob 相对该包写。文件 `apps/web/.claude/rules/styling/tokens.md`：

```markdown
---
paths:
  - "src/styles/tokens/*.css"
---

改这里的 token 后必须跑 `pnpm tokens:build`，否则 `src/styles/generated/` 不会更新，但页面不报错。
```

原因、经过几行能说完的，直接写在 rule 里。文件 `apps/web/.claude/rules/api/retry.md`：

```markdown
---
paths:
  - "src/api/retry.ts"
---

重试次数不能超过 3（首次加重试共 4 次请求），退避从 200ms 起指数增长。

原因：上游网关连续 5 次失败会把客户端 IP 拉黑 10 分钟，线上出过一次事故。上限 3 留出了一次余量。

试过在网关前加熔断，和网关自身的限流叠加后导致长时间不可用，已放弃。
```

背景放不下时（超过 20 行、实测数字的历史表格、几条 rule 共用），rule 留"做什么"和一行文档路径。根作用域的 rule（单仓库的所有 rule，或 monorepo 的跨包 rule），glob 从仓库根写完整路径。文件 `.claude/rules/db/schema-web-sync.md`：

```markdown
---
paths:
  - "packages/schema/src/tables/*.ts"
  - "apps/web/src/generated/db/*.ts"
---

改 schema 后必须跑 `pnpm db:generate` 重新生成 apps/web 的类型。原因见 .context/db/generated-types.md
```

## 领域索引 rule

给**能挂到代码上、但 rule 装不下**的文档用。每个有这类文档的领域一个，文件名固定为 `context-index.md`，`paths` 覆盖这个领域的代码。文件 `apps/web/.claude/rules/api/context-index.md`：

```markdown
---
paths:
  - "src/api/**"
  - "src/hooks/useRequest.ts"
---

api 相关的项目文档，改动前按需读：
- `apps/web/.context/api/upstream-gateway.md`：改请求频率、重试、超时前（网关限流与封禁规则、各接口实测延迟）
- `apps/web/.context/api/error-codes.md`：新增或改动错误码映射前
- `.context/auth-session-flow.md`：改登录态刷新、401 处理前
```

每份文档一行：仓库根起的路径 + 什么时候该读。不要把文档内容抄进来。

## 文档入口

给**挂不到代码上**的文档用（评估过但没做的需求、外部系统限制、还没有代码的决定）。每个有这类文档的作用域一个，固定为 `<作用域>/.context/README.md`，并由根 CLAUDE.md 指过来（见「CLAUDE.md 索引小节」）。文件 `apps/web/.context/README.md`：

```markdown
# 项目文档入口

挂不到具体代码上的项目文档。做新需求、评估方案前，先看有没有相关的：
- `apps/web/.context/payment/installments.md`：要做分期付款、或评估换支付渠道前
- `apps/web/.context/sso-provider-limits.md`：接入新的登录方式前
- `apps/web/.context/build/package-size.md`：新功能要引入依赖、二进制或大资源时，先估体积影响

只在改代码时才用得上的文档由各领域的 `.claude/rules/<领域>/context-index.md` 在碰到相关代码时带出来，不在这里列。
```

格式和领域索引一样，每份文档一行。最后一行是"两边都登记"的例子：`package-size.md` 同时登记在 `build` 的领域索引里，两处各写各的"什么时候该读"。

## 文档

没有固定模板，写什么、怎么分节按内容定。约束：

- 第一行是标题，说清这份文档讲的是什么主题
- 写现状，不按日期追加段落，情况变了就原地改
- 有条件成立的内容，在对应段落开头写明适用条件（如"仅 macOS："）
- 同一指标的多次实测用表格，新值追加一行，不覆盖旧值：

  ```markdown
  | 日期 | 改动 | 数值 | 测法 |
  |---|---|---|---|
  | 2026-09-05 | 引入路由级懒加载前 | 2.4s | Lighthouse 移动端 |
  | 2026-09-20 | 引入路由级懒加载后 | 1.1s | Lighthouse 移动端 |
  ```

能挂到代码上的长背景，示例文件 `apps/web/.context/api/upstream-gateway.md`（登记进 `api` 的领域索引 rule）：

```markdown
# 上游网关的限制

## 限流与封禁

- 单 IP 每秒 50 次，超出返回 429
- 连续 5 次失败（5xx 或超时）封禁客户端 IP 10 分钟，期间所有请求返回 403
- 封禁按出口 IP 算，同一机房的实例共用额度

## 接口延迟

| 日期 | 接口 | p95 | 测法 |
|---|---|---|---|
| 2026-08-12 | /orders | 380ms | 线上 APM 7 天数据 |
| 2026-10-03 | /orders | 210ms | 线上 APM 7 天数据（网关升级后） |
```

挂不到代码上的，示例文件 `apps/web/.context/payment/installments.md`（登记进 `apps/web/.context/README.md`）：

```markdown
# 分期付款

2026-08 评估过，没做：现用的支付渠道只对企业商户开放分期接口，我们是个人商户，升级要重新走资质审核（约 2 个月）。

值得重新评估的条件：账户升级为企业商户，或换了支付渠道。
```

文档只写背景。能挂到代码上的"做什么"写成 rule，rule 里留一行文档路径。

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

description 要写清"什么时候用"，它是启动时唯一常驻的部分。

## CLAUDE.md 索引小节

根 CLAUDE.md 末尾：

```markdown
## 更多上下文
- 各包和各模块的专属约定、背景会按路径通过 rule 自动加载，不用手动查
- 做新需求、评估方案前，先看 `.context/README.md` 和 `apps/web/.context/README.md`：以前评估过但没做的需求、外部系统限制、还没有代码的决定
- 记下读代码看不出来的项目知识（原因、踩坑、实测数字、外部约束）：写进 `.claude/rules/`，放不下或挂不到代码上的写进 `.context/`（装了 context-keeper 插件就用 `record-context`），不写成长注释，也不只记在自动记忆里
- 发布流程：用 `/release`
```

- 第二行（文档入口）列出**所有作用域**里存在的 `.context/README.md`，没有任何入口时省掉这一行。
- 第三行是常驻的写入约定，**不要省**：没有它，Claude 会按默认习惯把背景写进注释或自动记忆。
- 单仓库去掉"各包"的说法。
- 索引里只列根作用域的 skill：包内 skill 要碰到该包的文件后才可用，名字也带目录前缀，写进根索引会指向一个调不到的命令。
