---
name: ppr
description: 推送到当前 PR 的远程分支，并让 PR 标题和描述跟上整个 PR 的改动
disable-model-invocation: true
allowed-tools: Bash(git status:*) Bash(git branch:*) Bash(git rev-parse:*) Bash(git remote:*) Bash(git log:*) Bash(git diff:*) Bash(git fetch:*) Bash(git push:*) Bash(gh pr view:*) Bash(gh pr diff:*) Bash(gh pr edit:*)
---

# 推送并同步 PR 描述

用户输入 `/mine:ppr` 就是同意推送，也同意在需要时修改 PR 标题和描述，这两步都不用再问。

## 1. 找到当前分支的 PR

```bash
git status --short --branch
gh pr view --json number,url,title,body,state,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository
```

- 当前分支没有 PR：告诉用户，停下。不要替用户创建 PR。
- PR 已合并或已关闭：告诉用户，停下。
- 工作区有未提交的改动：告诉用户这些改动不会被推送，问要不要先提交；用户说不用再继续。

## 2. 推送

推到 PR 的 head 分支（`headRefName`）：

- 当前分支已设 upstream，且指向的正是这个 head 分支：直接 `git push`。
- 没有 upstream：用 `git remote -v` 找到对应 PR head 仓库的远程（`isCrossRepository` 为 true 时是 fork，按 `headRepositoryOwner` / `headRepository` 匹配），执行 `git push -u <remote> HEAD:<headRefName>`。

推送被拒（non-fast-forward 等）时不要强推：把 git 的报错告诉用户，说明原因（通常是远程有本地没有的提交，或本地 rebase 过），问用户要 `git pull --rebase` 还是 `git push --force-with-lease`，得到答复再继续。

## 3. 核对标题和描述

推送成功后，看整个 PR 现在的改动，而不只是这次推上去的提交：

```bash
git fetch <base-remote> <baseRefName>
git log --oneline <base-remote>/<baseRefName>..HEAD
gh pr diff <number>
```

`<base-remote>` 是指向 PR 目标仓库的远程，fork 场景下通常是 `upstream` 而不是 `origin`。

拿 PR 当前的标题和描述逐条对照，判断哪些已经不准：

- 描述了已被改掉、撤回或换了做法的内容
- 漏掉了现在 PR 里有分量的改动
- 标题概括的范围和现在的改动对不上

都还准确就不改，告诉用户「标题和描述仍然准确，未修改」即可。

## 4. 需要时直接改写

有过时的地方就直接改，不用先问：

- **在原处改写过时的句子和段落**，让描述读起来就像是对着现在这份最终改动写的。不要在末尾追加「更新」「后续改动」「补充」之类的段落，也不要用删除线保留旧说法。
- 仍然准确的部分原样保留，包括原有的结构、语言、关联 issue、截图、checklist 和末尾的署名行。
- 标题只在概括范围确实变了时才改。

把新描述写到临时文件，再更新：

```bash
gh pr edit <number> --title "<新标题>" --body-file <临时文件>
```

## 5. 汇报

用两三句话告诉用户：推到了哪个远程分支、推了几个提交、PR 链接；标题和描述改了没有，改了的话改了哪几处（一句话概括，不贴全文）。
