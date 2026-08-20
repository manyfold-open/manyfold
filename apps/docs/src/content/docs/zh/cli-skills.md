---
title: 用 CLI 管理 Skill
description: 使用 mf 发现、安装、创建、分享、导出和分发 Agent skill。
order: 9
---

# 用 CLI 管理 Skill

Skill 是 Agent 可复用的 instruction package。CLI 覆盖 installed skill、公共或
repository catalog，以及 personal skill library。

安装前先检查 skill 的 `SKILL.md` 和 supporting file。Skill 可以指示 Agent 使用
你的 authority 调用 tool 和外部系统。

## 发现和安装

```sh
mf skills discover --q review
mf skills install --skill-id skl_xxx --agent-id agt_xxx
mf skills installed --agent-id agt_xxx
```

批量安装到多个 Agent：

```sh
mf skills install --skill-id skl_xxx --agent-ids agt_one,agt_two
```

Installation state 与 enabled 分开：

- `installing` —— materialization 仍在进行
- `installed` —— skill 已落地，`SKILL.md` 可加载
- `failed` —— materialization 失败；检查 sanitized reason 后重试

不要把 `installing` 当作已经可用。

## 启用、禁用或卸载

```sh
mf skills update usk_xxx --enabled
mf skills update usk_xxx --disabled
mf skills delete usk_xxx --yes
```

这里使用 `skills installed` 返回的 installed user-skill ID，不是 catalog skill ID。
卸载不可恢复，并且必须显式传入 `--yes`。

## Personal library

```sh
mf skills library list
mf skills library get skl_xxx
mf skills library create --name my-review --content-file ./SKILL.md
mf skills library update skl_xxx --content-file ./SKILL.md
```

可从 GitHub、catalog entry、unlisted share link 或 `.skill`/zip archive 导入：

```sh
mf skills library import --url https://github.com/example/skills/tree/main/review
mf skills library import --file ./review.skill
mf skills library import --share https://manyfold.ai/skills/shared/lss_xxx
```

Supporting file 单独管理：

```sh
mf skills library files set skl_xxx \
  --path references/guide.md \
  --content-file ./guide.md
mf skills library files delete skl_xxx skf_xxx
```

## 分享、导出和 push

```sh
mf skills library share skl_xxx
mf skills library export skl_xxx -o ./review.skill
mf skills library push skl_xxx
```

Share link 是 unlisted link，不是 private authentication boundary。不应继续允许导入时
请 revoke。`push` 会更新已经安装该 library skill 的 Agent；一个 stopped Agent
不会阻塞其它 Agent，因此需要检查 per-agent result。

`mf skills repos` 用于管理 skill repository，需要 admin 或 `api.full` access，
普通用户很少需要。

## 另请参阅

- [使用工作区](../workspace/)
- [用 mf 编写脚本](../scripting/)
- [CLI 命令参考](../cli-reference/)
