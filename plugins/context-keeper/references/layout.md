# context-keeper 规范

`organize-context` 和 `record-context` 共用这份规范。目标只有一个：**常驻 context 尽量小，其余按需加载**。

## 加载机制（2026-09 已核实，直接按此执行，不要自己推测，也不必为此单独查证；实际观察到的行为与某条矛盾时以观察为准，并在计划或报告里指出）

1. `.claude/rules/*.md`，frontmatter 带 `paths:` glob → 只有读/改到匹配文件时才进 context。`.claude/rules/` 是**递归发现**的，可以用子目录组织。
2. 子目录里的 `CLAUDE.md` → 从仓库根启动时，只有碰到那个目录的文件时才加载。但**一旦触发是整文件加载**，没有分段，也**不支持 `paths:` frontmatter**。
3. Skill（`.claude/skills/<name>/SKILL.md`）→ 根级的启动时只加载 description；**子包里的 `.claude/skills/` 也支持**，且整体懒加载（碰到该目录文件时才可用，重名时用 `apps/web:deploy` 这种目录限定名）。
4. **子包里的 `.claude/rules/` 同样有效，且 `paths:` glob 相对该子包解析。** 例如 `apps/web/.claude/rules/styling.md` 里写 `src/**/*.css`，匹配的是 `apps/web/src/`。这一条官方文档没有写，但已实测确认，直接按此执行。
5. **`@path/to/file` import 是 eager 的**，启动就展开进 context，完全不省 token。**禁止**用 `@` 引用来"拆分"。需要指路时用自然语言写一行索引，让未来的 Claude 自己去 read/grep。
6. 自动记忆（auto memory）位置在 `~/.claude/projects/<project>/memory/`，不在项目仓库里。`<project>` 由 git 仓库派生，同一仓库的所有 worktree 和子目录共用一份；不在 git 仓库里时用项目根目录派生。目录名是该路径把所有非字母数字字符替换成 `-` 的结果（如 `/Users/a/my.app` → `-Users-a-my-app`），超过 200 字符时截断并追加哈希。设了环境变量 `CLAUDE_CONFIG_DIR` 时 `~/.claude` 换成它；同时设了 `CLAUDE_CODE_PROJECT_DIR_NAME` 时，`<project>` 直接用这个名字。`MEMORY.md` 是索引，只有它的**前 200 行或前 25KB** 会在每次会话开始时进 context；旁边的 topic 文件带 YAML frontmatter，`type` 取值为 `user` / `feedback` / `project` / `reference`，不自动加载。若任一 settings 作用域设了 `autoMemoryDirectory`，以它为准：按优先级从高到低依次是企业 policy、命令行 `--settings`、`.claude/settings.local.json`、`.claude/settings.json`、`~/.claude/settings.json`，取最先出现的那个。项目里的 `.claude/settings.json` / `.claude/settings.local.json` 设的值要在工作区受信任后才生效；开了 `permissions.blockReadsOutsideWorkingDirectories` 时，仓库自带 settings 指定的目录一律不读不写。

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

- `.claude/` 只放 Claude Code 要从这里加载的东西。本规范往里写的只有 `rules/`、`skills/`；已有的 `.claude/CLAUDE.md`、`settings*.json`、`commands/`、`agents/`、hook 脚本等也属于 Claude Code 配置，原样保留，不要当成沉淀文档搬走
- 项目根的 CLAUDE.md 可以是 `CLAUDE.md`，也可以是 `.claude/CLAUDE.md`，两者等价。本规范说的「根 CLAUDE.md」指实际存在的那个；两个都存在时，写进计划的「需要拍板」，由用户决定是否合并
- `context/` 放项目文档（标签 `DOC`）。**不要放进 `.claude/`**——Claude 偶尔会把 `.claude/` 下的文件当成敏感配置而拒绝编辑，文档需要经常修改
- `context/` 这个名字很常见，项目可能早就拿它放代码（如 React 的 `context/AuthContext.tsx`）。只有里面全是 Markdown 文档的 `context/` 才算本规范的文档目录；作用域根已有的 `context/` 里有代码或其他非文档文件时，不要往里写文档，也不要把里面的文件当文档处理——写进计划的「需要拍板」，让用户另选一个目录名（如 `docs/context/`），并在该作用域的 CLAUDE.md 索引或指路行里写明。之后本规范说的该作用域的 `context/` 都指这个目录

| 形态 | 作用域 |
|---|---|
| 单仓库 | 只有一个：仓库根。rules / skills 放根 `.claude/`，文档放根 `context/` |
| monorepo | 仓库根 + 每个包。包的 `.claude/`、`context/` 只在真有内容时才建，不要为了对称建空目录 |

归属判定：

- 内容涉及的文件全在某个包内 → 该包的作用域
- 涉及两个及以上包（跨包联动、跨包通用） → 根作用域
- 单仓库 → 一律根作用域

### 目录级 CLAUDE.md

单仓库里也可能有子目录 `CLAUDE.md`（如 `src/server/CLAUDE.md`），monorepo 的包内也可能有更深层的。它们和包级 CLAUDE.md 一样"触发即全量加载"，按同样标准瘦身：只留"该目录内任何任务都适用"的内容，其余拆出去。**不要**在这些目录下另建 `.claude/` 或 `context/`——它们拆出来的 rules 放进所属作用域（单仓库即根）的 `.claude/`，文档放进所属作用域的 `context/`，rule 的 `paths` 指向该目录下的具体文件。

## 标签与去处

| 标签 | 判据 | 去处 |
|---|---|---|
| `ALWAYS` | 任何任务都可能违反的硬约束（commit 规则、语言/风格约定、绝对禁止做的事） | 全仓通用 → 根 `CLAUDE.md`；只在某包内成立且其中**任何任务都适用** → 该包的 `CLAUDE.md`；只在某个**已有**目录级 CLAUDE.md 所在目录内成立且其中任何任务都适用 → 该目录的 `CLAUDE.md`（不要为此新建目录级 CLAUDE.md，没有的走 `PATH-RULE`）。一条写一行 |
| `HOOK` | 能被脚本/lint/CI 确定性校验的（commit message 格式、禁改文件、必须跑的检查） | 建议改成 hook 或 lint 配置。**只提建议，不要自己改 CI**。检查落地之前文字不删，继续按判据阶梯归类放好；用户确认检查已经加上后，才从 prose 里删掉 |
| `PATH-RULE` | 触发条件比"整个作用域"更窄——只在碰到特定文件、目录或文件类型时才需要知道的（"改 A 必须同步 B"、某个模块的坑、某类文件的专属约定） | `<作用域>/.claude/rules/<领域>/<name>.md`，`paths` 相对作用域根写；跨包联动规则放根，glob 写从仓库根算起的完整路径 |
| `SKILL` | 有步骤的流程性知识（发布、迁移、排障 playbook），平时不需要 | `<作用域>/.claude/skills/<name>/SKILL.md` |
| `DOC` | 读代码得不到、但以后做事需要知道的信息（commit message 里写过的也算：Claude 平时不会去翻 git 历史）。内容不设限：设计原因与权衡、放弃过的方案、实测数字、外部系统的约束、踩坑经过、领域知识……Claude 觉得值得留下的都行 | `<作用域>/context/[<领域>/]YYYY-MM-DD-<slug>.md`，一主题一文件，按领域分目录（规则见「硬约束」）；数字类内容也可以指出它更该放在代码常量 / CHANGELOG / benchmark 输出里 |
| `DERIVABLE` | 删掉也不会让 Claude 犯错的：读代码就能知道的（目录结构说明、逐文件描述、标准语言惯例、框架官方用法），以及只是复述某次需求做了什么、改了哪些文件的（这是 commit 的职责） | **删除** |
| `STALE` | 已不成立、与现状矛盾、或引用了不存在的文件 | **删除**，但必须单独列出让用户确认 |

不属于项目仓库的两类：

| 标签 | 判据 | 去处 |
|---|---|---|
| `PERSONAL` | 用户个人的偏好、对 Claude 的纠正、个人工作习惯 | 留在自动记忆里，不进仓库——仓库可能被别人看到，写进项目是污染。用户希望对所有项目生效时，给出可粘贴到用户级 `~/.claude/CLAUDE.md` 的文本，**不许直接改那个文件** |
| `ENV-BOUND` | 换一台电脑、换一个网络、换一个操作系统就不成立的：本机绝对路径、本机装的版本、端口占用、代理/DNS/网络限制、只在某台机器上出现的怪现象、任何凭据或 token | 留在自动记忆里，不进仓库 |

有条件成立的环境相关内容（"在 macOS 上 X 会失败"、"Node 20 以下会报 Y"）不算 `ENV-BOUND`——换台同类环境照样遇到，按上表正常归类，但**正文第一行写明适用条件**（如"仅 macOS："）。

### 敏感信息

以下内容**一律不写进项目仓库**，不论它原本打了什么标签：API key / token / 密码 / 私有仓库地址 / 内网 IP 或域名 / 含用户名的绝对路径（`/Users/<name>/...`、`/home/<name>/...`）/ 任何用户没打算公开的信息。需要向用户报告时只说类型和所在位置，不要把值本身打出来。

## 判据阶梯

按顺序问，第一个"是"就停。一条内容混着"做什么"和"为什么/数字/背景"时先拆开，各自走阶梯——"做什么"的部分通常落到 `PATH-RULE` 或 `ALWAYS`，原因、数字、背景落到 `DOC`，rule 里留一行路径指过去：

0. 它属于这个项目吗？个人偏好 → `PERSONAL`；换台机器就不成立 → `ENV-BOUND`
1. 删掉这条，Claude 会不会犯错？不会 → `DERIVABLE`。读代码就能直接看出来的算不会；只有翻 `git log` 才能查到的不算——Claude 平时不会去翻历史
2. 能不能写成脚本自动校验？能 → 同时打上 `HOOK`，但**不停**，继续往下问，定出检查落地之前文字放在哪
3. 它有步骤、平时用不上吗？是 → `SKILL`
4. 它是背景信息（原因、数字、经过、外部约束等），而不是"做什么"的指令吗？是 → `DOC`。**坑不算背景**：「X 在 Y 情况下会出错」直接决定碰到相关文件时该怎么做，按"做什么"处理，继续往下走（通常在第 5 步落到 `PATH-RULE`）；只有它的来龙去脉（怎么发现的、排查经过、试过的绕法）较长时才拆一份 `DOC`，rule 里留一行路径
5. 它的触发条件比"整个作用域"更窄吗？是 → 先看例外：它适用于某个**已有**目录级 CLAUDE.md 所在目录内的任何任务 → `ALWAYS`，留在（或放进）那个目录级 CLAUDE.md；否则 → `PATH-RULE`（这一步要严格，能提取的都提取）
6. 剩下的才是 `ALWAYS`，再按归属判定放进根或包的 CLAUDE.md

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
    ├── YYYY-MM-DD-<slug>.md      # 跨领域的，或所属领域还没攒够几份的
    └── <领域>/YYYY-MM-DD-<slug>.md
```

monorepo：

```
.
├── CLAUDE.md                     # 全仓 ALWAYS + 索引
├── .claude/
│   ├── rules/<领域>/<name>.md     # 跨包 rule，paths 写仓库根起的完整路径
│   └── skills/                   # 跨包 skill
├── context/                      # 跨包文档，按领域分目录
└── apps/web/
    ├── CLAUDE.md                 # 该包 ALWAYS + 一行指路
    ├── .claude/
    │   ├── rules/<领域>/<name>.md # paths 相对 apps/web/
    │   └── skills/
    └── context/                  # 该包的文档，按领域分目录
```

`<领域>` 是"讲的是系统哪一块"的子目录（`db/`、`api/`、`styling/`），rules 和 context 共用同一套领域名。一个作用域只有寥寥几个 rule 时可以直接平铺在 `rules/` 下；context 什么时候建领域目录见「硬约束」。

## 硬约束

- **禁止 `@` import**，指路一律用自然语言。
- **`paths` 要窄到能真正起过滤作用。** 不许写 `**/*`、`src/**`、`packages/**` 这种一碰作用域就全中的写法；glob 必须至少匹配到一个现存文件——校验时以 rule 所属作用域的根为基准（包内 rule 在包目录下跑 Glob，根 rule 在仓库根跑），否则包相对的 glob 会被误判为失效。例外：glob 指向生成物或被 `.gitignore` 忽略的文件（如 `src/generated/`）时，干净 checkout 里可能不存在，Glob 也可能过滤掉它们；这时改为核对 glob 与生成脚本的输出路径或 `.gitignore` 条目一致，不判为失效。
- **CLAUDE.md 一条一行。** 凡是能被 `paths` 限定触发条件的，一律走 rule；凡是带"因为/当初/以前"的，一律走文档。rule 正文写"做什么"，不写"为什么"，为什么归文档，正文里用一行路径指过去。
- **一件事只写一处。** 同一件事散在两个文件里比记在一个长文件里更糟。
- **CLAUDE.md 末尾的「更多上下文」索引**用自然语言写（格式见模板）。包级 CLAUDE.md 所在的包有自己的 `context/` 时，也在末尾加一行同样性质的指路。
- **代码注释守本分：** 只收"读这段代码的人此刻需要知道的"。历史沿革、数字、长篇原因写进 `context/`（或 `.claude/rules/`），在原处留一行带路径的指针，路径从仓库根算起，方便 grep：

  ```ts
  // 这里的重试次数固定为 3，原因见 apps/web/context/api/2026-09-05-retry-policy.md
  ```

  不要留空白，也不要留一句没有信息量的 `// 见文档`。
- **不碰用户级配置：** 不改 `~/.claude/CLAUDE.md`、`~/.claude/settings.json`。
- **文档按主题组织，不按需求组织。** 不要每做一个需求就落一个文档——"这次做了什么"由 commit 记录。只有以后做事需要知道、且读代码得不到的信息才写文档（只写在 commit message 里的也算读代码得不到），并且优先改已有的同主题文档，而不是新建。
- **文档写的是现状。** 情况变了就原地改写，不要追加"更新：……"、不要另建新文件再把旧的标成作废，旧版本交给 git。被放弃的方案只在"怕以后有人重新提"时才留，一两句话写明放弃了什么、为什么。
- **文档文件名用 `YYYY-MM-DD-<slug>.md`**，让目录按创建顺序排列。slug 用英文小写短横线，概括主题（`retry-policy`，不是 `fix-bug`）。
  - 日期是文档**创建**的日期：新建用当天；从 CLAUDE.md、注释、记忆迁移来的，用 `git log -S` / `git blame` 查原文首次出现的日期，查不到就用迁移当天。之后原地更新内容时**不改文件名**，否则所有指向它的指针都会失效。几份文档合并成一份时，沿用其中最早的日期。
  - 不用递增编号：用户会在多个 worktree 里并发做任务，递增编号会让多个 PR 各自新建同一个号的文件而冲突。
  - 日期前缀挡不住并发的重复：两个 worktree 在不同日期为同一主题各建一份（`2026-09-05-retry-policy.md` 和 `2026-09-07-retry-policy.md`），合并时不会冲突，「一主题一文件」就被打破了。新建前按 slug 和主题关键词在整个 `context/` 里查一遍（不只看目标目录），能防住同一分支内的重复；跨分支的重复由 organize-context 体检的「同一主题散在多个文档里」发现并合并。
- **文档按领域分目录，不按信息类型分。** 不建 `decisions/`、`data/`、`pitfalls/` 这类按"是什么信息"分的目录——类型永远列不全，查找时也不是按类型找的：要改支付模块时，想看的是支付相关的一切，不管它是原因、数字还是坑。领域指"讲的是系统哪一块"：
  - **领域名取自项目已有的叫法，不自造。** 优先用同一作用域 `.claude/rules/<领域>/` 已在用的名字，其次用代码里的模块名、目录名。同一块在 rules 和 context 里用同一个名字。
  - **先平铺，攒够再分。** 某领域在 `context/` 顶层攒到 3 份及以上文档时才建 `<领域>/` 子目录，不要为一两份文档开目录。子目录里的文件同样带日期，目录内按时间排序。
  - **跨领域的留在顶层。** 涉及两块及以上、或说不清属于哪块的文档，放 `context/` 顶层，不硬塞进某个领域。
  - **只分一层，不嵌套。** monorepo 的包级 `context/` 已经按包分开，领域目录是包内这一层。
  - **移动文件要同步改指针。** 把文档收进子目录或给领域改名，会让指向它的指针注释、rule 里的路径、CLAUDE.md 索引失效，移动时必须一并更新；有指针落在本次不可写的文件里（如带参数运行时的只读文件或范围外的代码）就不移动，只在计划里建议。移动只在 organize-context 里做；record-context 日常记录时不挪已有文件。
