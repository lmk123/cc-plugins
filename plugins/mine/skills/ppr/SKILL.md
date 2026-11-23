---
name: ppr
description: 推送到当前 PR 的远程分支，并让 PR 标题和描述跟上整个 PR 的改动
argument-hint: "[可选：PR 号，本地分支名和 PR head 分支名不一致时用]"
disable-model-invocation: true
allowed-tools:
  - Bash(git status:*)
  - Bash(git branch --show-current)
  - Bash(git rev-parse:*)
  - Bash(git config --get:*)
  - Bash(git remote -v)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git rev-list:*)
  - Bash(git fetch:*)
  - Bash(git push -u:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr edit:*)
---

# 推送并同步 PR 描述

用户输入 `/mine:ppr` 就是同意推送，也同意在需要时修改 PR 标题和描述，这两步都不用再问。

调用参数：`$ARGUMENTS`（可能为空）。

## 1. 找到当前分支的 PR

```bash
git status --short --branch
gh pr view [PR 号] --json number,url,title,body,state,baseRefName,headRefName,headRefOid,headRepository,isCrossRepository,maintainerCanModify
```

参数里给了 PR 号就带上；没给就不带，gh 会按当前分支去找。

- 找不到 PR：告诉用户，停下，不要替用户创建 PR。本地分支名和 PR 的 head 分支名不一样、又没设 upstream 时，gh 也会找不到，这时提示用户可以用 `/mine:ppr <PR 号>` 指定。
- PR 已合并或已关闭：告诉用户，停下。
- 工作区有未提交的改动：告诉用户这些改动不会被推送，问要不要先提交；用户说不用再继续。

## 2. 推送

**先确定推到哪个远程**（记作 `<head-remote>`，可能是远程名，也可能是 URL）。PR 的 head 仓库是 `headRepository.nameWithOwner`（`<owner>/<repo>`），下面说「指向 head 仓库」都是指 URL 里的 `<owner>/<repo>` 和它一致（不区分 SSH / HTTPS 写法，忽略末尾的 `.git`）：

1. 用 `git branch --show-current` 拿到当前分支名，再读它的跟踪配置：`git config --get branch.<当前分支>.remote` 和 `git config --get branch.<当前分支>.merge`。两项都有、merge 正好是 `refs/heads/<headRefName>`，**并且**这个 remote 指向 head 仓库（remote 是远程名时，到 `git remote -v` 里看它的 URL；`gh pr checkout` 检出 fork 的 PR 时 remote 可能直接是 URL），才用它。分支名对上但仓库对不上（比如 fork 的 `main` 发的 PR，本地 `main` 跟踪的却是上游的 `main`），不能用，走下一条。
2. 否则（没有 upstream、upstream 指向别的分支或别的仓库，或者是 `refs/pull/<n>/head`）：在 `git remote -v` 里找指向 head 仓库的远程。
3. 两步都找不到：告诉用户缺 `<owner>/<repo>` 的远程，停下。

**参数里给了 PR 号、而当前分支名不等于 `headRefName`、第 1 条也没匹配上时**，先确认推的是不是这个 PR 的提交：

```bash
git fetch <head-remote> <headRefName>
git log --oneline FETCH_HEAD..HEAD
```

把这些提交列给用户，说明会推到 PR #<number> 的 `<headRefName>` 分支，并把当前分支的 upstream 改过去，得到同意再推。用户在 `/mine:ppr` 里同意的是推送「这个 PR 的分支」，当前分支是不是它不确定时，这一步要问。

**然后推送**。不管 upstream 原来是什么，一律用这个固定形式；`-u` 会把 upstream 改成 PR 的 head 分支，这是有意的：

```bash
git push -u <head-remote> HEAD:<headRefName>
```

**从推送输出里记下推了几个提交**（第 5 步汇报要用）：

- 输出里有 `<old>..<new>  HEAD -> <headRefName>`：跑 `git rev-list --count <old>..<new>`。fast-forward 时 `<old>` 一定是 HEAD 的祖先，本地肯定有。
- 输出是 `[new branch]`：提交数按第 3 步 `git log` 列出的条数算。
- 输出是 `Everything up-to-date`：推了 0 个，照样做第 3 步，描述可能早就过时了。

**推送被拒时**先看报错属于哪一类，再决定怎么办，不要自己重试：

- **non-fast-forward**（`! [rejected] … (non-fast-forward)` 或 `(fetch first)`）：远程有本地没有的提交，或者本地 rebase 过。把报错告诉用户，问要 `git pull --rebase <head-remote> <headRefName>` 还是 `git push --force-with-lease <head-remote> HEAD:<headRefName>`，得到答复再执行。
- **没有权限**（`Permission … denied`、`403`、`protected branch hook declined`、`GH006` 等）：把报错告诉用户，停下，不要提 pull 或 force，它们解决不了。fork PR（`isCrossRepository` 为 true）且 `maintainerCanModify` 为 false 时，告诉用户 PR 作者没有允许维护者推送。
- 其他报错（网络、凭据等）：原样告诉用户，停下。

推送命令只能是上面那个固定形式，不要加 `--force`、`--force-with-lease` 或 `+` 前缀。免确认列表里的 `git push -u` 是按前缀匹配的，`-u` 后面再加强推参数也会被直接放行，所以用户选了强推时，一律写成上面那条**不带 `-u`** 的 `git push --force-with-lease …`：它和 `git pull --rebase` 都不在列表里，执行时会弹权限确认，这是有意的。

## 3. 核对标题和描述

推送成功后，看整个 PR 现在的改动，而不只是这次推上去的提交。以本地为准，不要依赖刚推送完的 GitHub 数据：

```bash
git fetch <base-remote 或 base 仓库 URL> <baseRefName>
git log --oneline FETCH_HEAD..HEAD
git diff --stat FETCH_HEAD...HEAD
git diff FETCH_HEAD...HEAD -- <需要细看的文件>
```

- `<base-remote>` 是 URL 指向 PR 目标仓库的远程（从 `url` 字段 `https://<host>/<owner>/<repo>/pull/<n>` 里取 `<owner>/<repo>`），fork 场景下通常是 `upstream` 而不是 `origin`。找不到这样的远程，就直接 fetch `https://<host>/<owner>/<repo>.git`，`<host>` 照 `url` 里的写（GitHub Enterprise 不是 github.com）。
- 改动很多时，先看 `--stat`，再挑有分量的文件细看，不要一次把整个 diff 读进来。
- 上面的 fetch 失败（比如私有仓库没有凭据）才退回 `gh pr diff <number>`。用之前先跑 `gh pr view <number> --json headRefOid`，确认它等于 `git rev-parse HEAD`。不相等说明 GitHub 还没处理完这次推送，稍等再查，不要拿旧 diff 做判断。

拿 PR 当前的标题和描述逐条对照，判断哪些已经不准：

- 描述了已被改掉、撤回或换了做法的内容
- 漏掉了现在 PR 里有分量的改动
- 标题概括的范围和现在的改动对不上

都还准确就不改，告诉用户「标题和描述仍然准确，未修改」即可。

## 4. 需要时直接改写

有过时的地方就直接改，不用先问：

- **在原处改写过时的句子和段落**，让描述读起来就像是对着现在这份最终改动写的。不要在末尾追加「更新」「后续改动」「补充」之类的段落，也不要用删除线保留旧说法。
- 仍然准确的部分原样保留，包括原有的结构、语言、关联 issue、截图、checklist 和末尾的署名行。
- 标题只在概括范围确实变了时才改，这时才加 `--title`。

新描述通过 heredoc 从标准输入传入，不写临时文件。结束标记要加引号，这样描述里的 `$`、反引号都会原样保留；正文里不能有单独一行的 `PR_BODY_EOF`：

```bash
gh pr edit <number> [--title "<新标题>"] --body-file - <<'PR_BODY_EOF'
<新描述全文>
PR_BODY_EOF
```

## 5. 汇报

用两三句话告诉用户：推到了哪个远程分支、推了几个提交（第 2 步从推送输出记下的数）、PR 链接；标题和描述改了没有，改了的话改了哪几处（一句话概括，不贴全文）。
