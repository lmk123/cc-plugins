# context-keeper 规范

`organize-context` 和 `record-context` 共用这份规范。目标只有一个：**常驻 context 尽量小，其余按需加载**。

## 加载机制（已核实，直接按此执行，不要自己推测，也不要去查证）

1. `.claude/rules/*.md`，frontmatter 带 `paths:` glob → 只有读/改到匹配文件时才进 context。`.claude/rules/` 是**递归发现**的，可以用子目录组织。
2. 子目录里的 `CLAUDE.md` → 从仓库根启动时，只有碰到那个目录的文件时才加载。但**一旦触发是整文件加载**，没有分段，也**不支持 `paths:` frontmatter**。
3. Skill（`.claude/skills/<name>/SKILL.md`）→ 根级的启动时只加载 description；**子包里的 `.claude/skills/` 也支持**，且整体懒加载（碰到该目录文件时才可用，重名时用 `apps/web:deploy` 这种目录限定名）。
4. **子包里的 `.claude/rules/` 同样有效，且 `paths:` glob 相对该子包解析。** 例如 `apps/web/.claude/rules/styling.md` 里写 `src/**/*.css`，匹配的是 `apps/web/src/`。这一条官方文档没有写，但已实测确认，直接按此执行。
5. **`@path/to/file` import 是 eager 的**，启动就展开进 context，完全不省 token。**禁止**用 `@` 引用来"拆分"。需要指路时用自然语言写一行索引，让未来的 Claude 自己去 read/grep。
6. 自动记忆（auto memory）位置在 `~/.claude/projects/<project>/memory/`，不在项目仓库里。`<project>` 由 git 仓库派生，同一仓库的所有 worktree 共用一份。`MEMORY.md` 是索引，只有它的**前 200 行或前 25KB** 会在每次会话开始时进 context；旁边的 topic 文件带 YAML frontmatter，`type` 取值为 `user` / `feedback` / `project` / `reference`，不自动加载。若 `~/.claude/settings.json` 或项目 `.claude/settings.json` 设了 `autoMemoryDirectory`，以它为准。

由此得出：**根 CLAUDE.md 和子目录/子包 CLAUDE.md 都要瘦**。根的因为常驻，子目录的因为触发即全量加载——一个 400 行的包级 CLAUDE.md，Claude 碰了包里任意一个文件就全进来，哪怕只有 30 行相关。

## 仓库形态与作用域

### 判断形态

命中下列任一信号即为 **monorepo**，否则为**单仓库**：

- `pnpm-workspace.yaml`、根 `package.json` 的 `workspaces` 字段、`lerna.json`、`nx.json`、`turbo.json`、`rush.json`
- `Cargo.toml` 里有 `[workspace]`、`go.work`、`settings.gradle(.kts)` 里有 `include`、`pom.xml` 里有 `<modules>`
- 以上都没有，但仓库里有多个带独立清单文件（`package.json` / `pyproject.toml` / `go.mod` 等）且各自独立构建的目录——这种情况拿不准，在计划里说明判断依据，让用户确认

monorepo 的**包**是 workspace 配置实际匹配到的成员目录，以配置为准，不要凭目录名猜。

### 作用域

**作用域**是一套 `CLAUDE.md` + `.claude/` + `context/` 的挂载点：

- `.claude/` 只放 Claude Code 要从这里加载的东西：`rules/`、`skills/`
- `context/` 放沉淀文档：`decisions/`、`data/`。**不要放进 `.claude/`**——Claude 偶尔会把 `.claude/` 下的文件当成敏感配置而拒绝编辑，沉淀文档需要经常追加和修改

| 形态 | 作用域 |
|---|---|
| 单仓库 | 只有一个：仓库根。rules / skills 放根 `.claude/`，decisions / data 放根 `context/` |
| monorepo | 仓库根 + 每个包。包的 `.claude/`、`context/` 只在真有内容时才建，不要为了对称建空目录 |

归属判定：

- 内容涉及的文件全在某个包内 → 该包的作用域
- 涉及两个及以上包（跨包联动、跨包通用） → 根作用域
- 单仓库 → 一律根作用域

### 目录级 CLAUDE.md

单仓库里也可能有子目录 `CLAUDE.md`（如 `src/server/CLAUDE.md`），monorepo 的包内也可能有更深层的。它们和包级 CLAUDE.md 一样"触发即全量加载"，按同样标准瘦身：只留"该目录内任何任务都适用"的内容，其余拆出去。**不要**在这些目录下另建 `.claude/` 或 `context/`——它们拆出来的 rules 放进所属作用域（单仓库即根）的 `.claude/`，decisions / data 放进所属作用域的 `context/`，rule 的 `paths` 指向该目录下的具体文件。

## 标签与去处

| 标签 | 判据 | 去处 |
|---|---|---|
| `ALWAYS` | 任何任务都可能违反的硬约束（commit 规则、语言/风格约定、绝对禁止做的事） | 全仓通用 → 根 `CLAUDE.md`；只在某包/某目录内成立且其中**任何任务都适用** → 该包/该目录的 `CLAUDE.md`。一条写一行 |
| `HOOK` | 能被脚本/lint/CI 确定性校验的（commit message 格式、禁改文件、必须跑的检查） | 建议改成 hook 或 lint 配置，从 prose 里删掉。**只提建议，不要自己改 CI** |
| `PATH-RULE` | 触发条件比"整个作用域"更窄——只在碰到特定文件、目录或文件类型时才需要知道的（"改 A 必须同步 B"、某个模块的坑、某类文件的专属约定） | `<作用域>/.claude/rules/<领域>/<name>.md`，`paths` 相对作用域根写；跨包联动规则放根，glob 写从仓库根算起的完整路径 |
| `SKILL` | 有步骤的流程性知识（发布、迁移、排障 playbook），平时不需要 | `<作用域>/.claude/skills/<name>/SKILL.md` |
| `DECISION` | 历史决策、"为什么现在是这样"、曾经的方案与放弃原因 | `<作用域>/context/decisions/YYYY-MM-DD-<slug>.md`，一决策一文件 |
| `DATA` | 数字/事实型记录（性能对比、价格变更历史、benchmark、容量实测） | `<作用域>/context/data/<name>.md`，或指出它更该放在代码常量 / CHANGELOG / benchmark 输出里 |
| `DERIVABLE` | 读代码就能知道的（目录结构说明、逐文件描述、标准语言惯例、框架官方用法） | **删除** |
| `STALE` | 已不成立、与现状矛盾、或引用了不存在的文件 | **删除**，但必须单独列出让用户确认 |

不属于项目仓库的两类：

| 标签 | 判据 | 去处 |
|---|---|---|
| `PERSONAL` | 用户个人的偏好、对 Claude 的纠正、个人工作习惯 | 用户级 `~/.claude/CLAUDE.md`。**只给出可粘贴的文本，不许直接改那个文件**——它对用户所有项目生效。仓库可能被别人看到，写进项目是污染 |
| `ENV-BOUND` | 换一台电脑、换一个网络、换一个操作系统就不成立的：本机绝对路径、本机装的版本、端口占用、代理/DNS/网络限制、只在某台机器上出现的怪现象、任何凭据或 token | 留在自动记忆里，不进仓库 |

有条件成立的环境相关内容（"在 macOS 上 X 会失败"、"Node 20 以下会报 Y"）不算 `ENV-BOUND`——换台同类环境照样遇到，按上表正常归类，但**正文第一行写明适用条件**（如"仅 macOS："）。

## 判据阶梯

按顺序问，第一个"是"就停：

0. 它属于这个项目吗？个人偏好 → `PERSONAL`；换台机器就不成立 → `ENV-BOUND`
1. 删掉这条，Claude 会不会犯错？不会 → `DERIVABLE`
2. 能不能写成脚本自动校验？能 → `HOOK`
3. 它有步骤、平时用不上吗？是 → `SKILL`
4. 它的触发条件比"整个作用域"更窄吗？是 → `PATH-RULE`（这一步要严格，能提取的都提取）
5. 它是"为什么这么定"吗？是 → `DECISION`
6. 它是数字吗？是 → `DATA`
7. 剩下的才是 `ALWAYS`，再按归属判定放进根或包/目录的 CLAUDE.md

## 目录结构

单仓库：

```
.
├── CLAUDE.md                     # 只有 ALWAYS，末尾一个「更多上下文」索引
├── src/server/CLAUDE.md          # 可选：该目录内任何任务都适用的约束
├── .claude/
│   ├── rules/<领域>/<name>.md     # paths 相对仓库根
│   └── skills/<name>/SKILL.md
└── context/
    ├── decisions/YYYY-MM-DD-<slug>.md
    └── data/<name>.md
```

monorepo：

```
.
├── CLAUDE.md                     # 全仓 ALWAYS + 索引
├── .claude/
│   ├── rules/<领域>/<name>.md     # 跨包 rule，paths 写仓库根起的完整路径
│   └── skills/                   # 跨包 skill
├── context/
│   └── decisions/  data/         # 跨包沉淀
└── apps/web/
    ├── CLAUDE.md                 # 该包 ALWAYS + 一行指路
    ├── .claude/
    │   ├── rules/<领域>/<name>.md # paths 相对 apps/web/
    │   └── skills/
    └── context/
        └── decisions/  data/
```

`<领域>` 是按主题分的子目录（`db/`、`api/`、`styling/`）。一个作用域只有寥寥几个 rule 时可以直接平铺在 `rules/` 下。

## 硬约束

- **禁止 `@` import**，指路一律用自然语言。
- **`paths` 要窄到能真正起过滤作用。** 不许写 `**/*`、`src/**`、`packages/**` 这种一碰作用域就全中的写法；glob 必须至少匹配到一个现存文件。
- **CLAUDE.md 一条一行。** 凡是能被 `paths` 限定触发条件的，一律走 rule；凡是带"因为/当初/以前"的，一律走 decision。rule 正文写"做什么"，不写"为什么"，为什么归 decision，正文里用一行路径指过去。
- **一件事只写一处。** 同一件事散在两个文件里比记在一个长文件里更糟。
- **CLAUDE.md 末尾的「更多上下文」索引**用自然语言写（格式见模板）。包/目录级 CLAUDE.md 有自己的 decisions/data 时，也在末尾加一行同样性质的指路。
- **代码注释守本分：** 只收"读这段代码的人此刻需要知道的"。历史沿革、数字、长篇原因写进 `context/`（或 `.claude/rules/`），在原处留一行带路径的指针，路径从仓库根算起，方便 grep：

  ```ts
  // 这里的重试次数固定为 3，原因见 apps/web/context/decisions/2026-09-05-retry-count.md
  ```

  不要留空白，也不要留一句没有信息量的 `// 见文档`。
- **不碰用户级配置：** 不改 `~/.claude/CLAUDE.md`、`~/.claude/settings.json`。
- **decision 文件名用 `YYYY-MM-DD-<slug>.md`，不用递增编号。** 用户会在多个 worktree 里并发做任务，递增编号会让多个 PR 各自新建同一个号的文件而冲突；日期 + slug 只有同一天记同一件事才会撞上，而那本来就是真冲突。日期取决定做出的那天：新记录用当天；从 CLAUDE.md、注释、记忆迁移来的，用 `git log -S` / `git blame` 查原文首次出现的日期，查不到就用迁移当天。slug 用英文小写短横线，概括决定本身（`retry-count`，不是 `fix-bug`）。
