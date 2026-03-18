---
name: ai-daily-digest
description: >
  Generate an AI/tech daily digest from RSS candidates. Use when the user asks to run the digest,
  update the digest pipeline, inspect digest outputs, or operate the scheduled AI news workflow.
  Supports staged pipeline work: fetch candidates, verify sources, extract article bodies, edit article cards,
  and render a Feishu-friendly digest.
---

# AI Daily Digest

本 skill 是当前本地维护版的 AI 日报流水线说明。目标是让不同能力的模型都能按同一套规范稳定完成：
- 抓取候选 RSS 文章
- 做来源核验
- 提取正文
- 生成展开版中文总结
- 输出适配飞书/聊天的日报

## 什么时候用

当用户提到以下需求时使用：
- 跑 AI 日报 / tech digest / RSS digest
- 看日报产物
- 调整 cron 日报流程
- 排查日报为什么抓取失败 / 摘要变差 / 产出异常
- 优化提取、编辑、排序、飞书投递

## 目录结构

- `scripts/openclaw_fetch.ts`：抓取 RSS 候选，输出 `output/candidates.json`
- `scripts/openclaw_plan.ts`：过滤、去重、分片，输出 `output/<runId>/plan.json`
- `scripts/openclaw_render_v25.ts`：读取分片编辑结果，渲染最终日报
- `output/<runId>/...`：每次运行的中间产物

## 当前推荐流水线

1. **fetch**
   - 运行 `scripts/openclaw_fetch.ts`
   - 产出 `output/candidates.json`

2. **plan**
   - 运行 `scripts/openclaw_plan.ts`
   - 产出：
     - `output/<runId>/plan.json`
     - `chunk-<n>.input.json`

3. **scout / verifier / extractor / editor**
   - 可由主 agent + sub-agents 完成
   - 推荐中间文件：
     - `signals.json`
     - `validated_sources.json`
     - `chunk-<n>.extracted.json`
     - `chunk-<n>.edited.json`

4. **render**
   - 运行 `scripts/openclaw_render_v25.ts`
   - 输出最终日报

## 输出约束

### Extractor
Extractor 不能只说“提取失败”，必须记录：
- `attempts`
- `failure_stage`
- `failure_reason`
- `content_chars`

如果失败，必须能回答：
- 试过哪些步骤
- 卡在哪一步
- 为什么失败

### Editor
Editor 输出的 `summaryZh` 必须是：
- 展开版中文总结
- 不是正文摘抄
- 不是一句话短摘要
- 默认覆盖：主题、关键点、观点/结论、意义、边界（至少其中 3 项）

如果正文未完整拿到：
- 必须明确保守
- 不允许伪装成读过全文

## 最终日报格式规范（重要）

这是当前**强约束格式**。低能力模型也必须照这个格式输出，不要自由发挥。

### 整体结构

最终日报按这个顺序输出：

1. 标题
2. 顶部概览信息
3. `## 📝 今日看点`
4. `## 🏆 今日必读`
5. `## 📊 数据概览`

### 顶部概览信息格式

标题下方先写 1 行或 2 行概览，例如：

```md
# 🦞 AI Daily Digest｜过去24小时（Top 15）

> 生成时间：2026-03-18 08:05｜抓取源：87/92｜候选：19｜短名单：19
> 失败源（5）：idiallo.com、jeffgeerling.com、micahflee.com、rachelbythebay.com、tedunangst.com
```

规则：
- 顶部概览信息可以用引用块 `>`
- 这里允许 1-2 行
- 不要在这里写大段说明

### 每篇条目的固定格式

每篇条目统一使用下面结构：

```md
### [中文标题](URL)
> 展开版摘要（只有摘要使用引用块）
来源｜时间｜类别｜评分
推荐理由：...
原始/更权威来源：...
关键词：`词1` `词2` `词3`
```

### 强制规则

- **只有摘要**使用引用块 `>`
- **来源 / 时间 / 类别 / 评分 / 推荐理由 / 原始来源 / 关键词** 一律用普通正文
- 不要把整条内容都写成 blockquote
- 不要混用伪列表、奇怪缩进、表格
- 不要把元信息塞进摘要里

### 元信息行格式

元信息单独一行，格式固定为：

```md
来源｜时间｜类别｜评分
```

示例：

```md
simonwillison.net｜2026-03-18 03:39｜AI/ML｜9.4（相关9/质量8/时效9）
```

规则：
- 用全角竖线样式 `｜`
- 时间放在来源后面
- 类别放在时间后面
- 评分最后
- 不要把“推荐理由”塞进这行

### 摘要格式

摘要必须是：
- 展开版中文总结
- 6-10 句为主
- 有信息密度，但不注水
- 有结构，不是正文拼接

摘要内容建议覆盖：
- 文章在讲什么
- 核心事实/论点/例子是什么
- 为什么重要
- 哪些地方仍需保守

如果正文不完整：
- 必须明确这是保守总结
- 不允许伪装成看过全文

### 推荐理由 / 原始来源 / 关键词

这三项都单独成行：

```md
推荐理由：这是过去24小时里最明确的模型发布线索之一。
原始/更权威来源：https://openai.com/index/introducing-gpt-5-4-mini-and-nano/
关键词：`OpenAI` `GPT-5.4` `mini` `nano`
```

规则：
- `推荐理由：` 单独一行
- `原始/更权威来源：` 单独一行（如果有）
- `关键词：` 后面用行内 code tag
- 不要把这些内容放进引用块

### 今日看点格式

`## 📝 今日看点` 下使用普通 bullet list：

```md
## 📝 今日看点

- 今天的核心主题集中在：...
- 正文提取结果：成功 X 篇，失败 Y 篇。
- 主要提取失败原因：blocked（2）、too_short（1）。
```

规则：
- 今日看点用 `- ` 列表
- 这里不要写成每条一大段散文
- 如果提取失败较多，要明确报统计和原因

### 数据概览格式

```md
## 📊 数据概览

**分类计数**

- AI/ML：8
- 工程：3
- 观点/杂谈：2

**高频关键词Top10**

- OpenAI（3）
- Agents（2）
```

规则：
- 不用 Markdown 表格
- 不用 Mermaid
- 直接 bullet list，保证各平台稳定

## 运行与排查

### 手动跑 cron
如果日报由 cron 托管，可用 OpenClaw CLI 手动触发对应 job：
- `openclaw cron run <job-id>`

### 看最近产物
优先查看：
- `output/<latest-run>/signals.json`
- `output/<latest-run>/validated_sources.json`
- `output/<latest-run>/chunk-*.extracted.json`
- `output/<latest-run>/chunk-*.edited.json`
- `output/<latest-run>/final.txt` 或最终 digest 文件

### 出现问题时先看哪层
- 没候选：先看 fetch
- 来源乱：先看 verifier
- 正文为空：先看 extractor
- 摘要像摘抄：先看 editor
- 飞书排版不对：先看 renderer

## 注意

- 这个 skill 以当前本地流水线为准，不再以旧版 Gemini 交互流程为主。
- 对 OpenClaw 运行来说，`SKILL.md + scripts/` 才是主入口。
- 输出格式以本文件中的“最终日报格式规范”为准。