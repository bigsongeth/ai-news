# ai-daily-digest (OpenClaw local fork)

This is a local clone of https://github.com/vigorX777/ai-daily-digest with small additions for our OpenClaw setup.

## What changed

- Added `scripts/openclaw_fetch.ts`: fetch RSS/Atom articles (no AI calls), output JSON.
- Added `scripts/openclaw_digest.ts`: use OpenAI-compatible API env vars to score/summarize and output Feishu-friendly Markdown.

These changes let us avoid Gemini + custom model setup in the original skill and instead rely on our own OpenClaw model provider config.

## Manual test

```bash
cd ai-daily-digest
mkdir -p output

# 1) fetch last 24h candidates
npx -y bun scripts/openclaw_fetch.ts --hours 24 --output ./output/candidates.json

# 2) generate digest
export OPENAI_API_KEY=... # (and optionally OPENAI_API_BASE / OPENAI_MODEL)
npx -y bun scripts/openclaw_digest.ts --input ./output/candidates.json --hours 24 --top-n 15 > ./output/digest.md
```

## Cron

We schedule an isolated cron job that runs daily at 08:00 Asia/Shanghai, and announces the output to the current Feishu chat.
