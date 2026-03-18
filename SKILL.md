---
name: ai-daily-digest
description: >
  Generate an AI/tech daily digest from RSS candidates. Use when the user asks to run the digest,
  update the digest pipeline, inspect digest outputs, or operate the scheduled AI news workflow.
  Supports staged pipeline work: fetch candidates, verify sources, extract article bodies, edit article cards,
  and render a Feishu-friendly digest.
---

# AI Daily Digest

本 skill 是本地维护版的 AI 日报流水线，当前重点是：
- 抓取候选 RSS 文章
- 做来源核验
- 提取正文
- 生成展开版中文总结
- 输出适配飞书的日报

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
   - 输出最终飞书日报

## 输出约束

### Extractor
Extractor 不能只说“提取失败”，必须记录：
- `attempts`
- `failure_stage`
- `failure_reason`
- `content_chars`

### Editor
Editor 输出的 `summaryZh` 必须是：
- 展开版中文总结
- 不是正文摘抄
- 不是一句话短摘要
- 默认覆盖：主题、关键点、观点/结论、意义、边界（至少其中 3 项）

如果正文未完整拿到：
- 必须明确保守
- 不允许伪装成读过全文

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
- 如果需要保留上游仓库的人类说明，可单独看 README；但对 OpenClaw 运行来说，`SKILL.md + scripts/` 才是主入口。
