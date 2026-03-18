#!/usr/bin/env bun
/**
 * Build a Feishu-friendly daily digest message from fetched RSS articles.
 *
 * Inputs:
 *  - --input <path> JSON produced by openclaw_fetch.ts
 *  - --hours <n> (optional; used in heading)
 *  - --top-n <n> (default 15)
 *
 * Behavior:
 *  - Uses OpenAI-compatible env vars if present (OPENAI_API_KEY / OPENAI_API_BASE / OPENAI_MODEL)
 *    to call an LLM for scoring + summarization.
 *  - If no env is present, falls back to SongKey provider config from OpenClaw.
 *
 * Output:
 *  - Prints Markdown optimized for Feishu (headings + lists) to stdout.
 */

import process from 'node:process';
import { readFile } from 'node:fs/promises';

type InArticle = {
  title: string;
  link: string;
  publishedAt: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
};

type InJson = {
  generatedAt: string;
  hours: number;
  totalFeeds: number;
  okFeeds: number;
  failedFeeds: Array<{ name: string; xmlUrl: string; error: string }>;
  totalArticles: number;
  articles: InArticle[];
};

type Picked = InArticle & {
  score: number;
  dims: { relevance: number; quality: number; timeliness: number };
  category: 'AI/ML' | '安全' | '工程' | '工具/开源' | '观点/杂谈' | '其他';
  keywords: string[];
  titleZh: string;
  summaryZh: string;
  why: string;
};

type LLMResult = {
  highlights: string[];
  picked: Picked[];
  categoryStats: Record<string, number>;
  keywordTop: Array<{ k: string; n: number }>;
};

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
};

const DEFAULT_MODEL = 'gpt-5.4';
const OPENCLAW_CONFIG_PATH = '/Users/bigsong/.openclaw/openclaw.json';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[k] = v;
    }
  }
  return args;
}

async function resolveOpenAIConfig(): Promise<{ apiKey: string; base: string; model: string }> {
  const envApiKey = process.env.OPENAI_API_KEY;
  const envBase = process.env.OPENAI_API_BASE;
  const envModel = process.env.OPENAI_MODEL;

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      base: (envBase || 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: envModel || DEFAULT_MODEL,
    };
  }

  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const provider: ProviderConfig | undefined = cfg?.models?.providers?.SongKey;
    if (provider?.apiKey && provider?.baseUrl) {
      return {
        apiKey: provider.apiKey,
        base: provider.baseUrl.replace(/\/$/, ''),
        model: envModel || DEFAULT_MODEL,
      };
    }
  } catch {
    // ignore and fall through
  }

  throw new Error('Missing OPENAI_API_KEY and unable to resolve SongKey provider from OpenClaw config');
}

async function callOpenAI(prompt: string): Promise<string> {
  const { apiKey, base, model } = await resolveOpenAIConfig();

  const url = `${base}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You are a careful analyst. Return strictly valid JSON when asked.' },
      { role: 'user', content: prompt },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 400)}`);
  }

  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('LLM returned empty content');
  return content;
}

function safeJsonParse(text: string): any {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m?.[1]) return JSON.parse(m[1]);
  throw new Error('Failed to parse JSON from LLM output');
}

function renderFeishuMarkdown(r: LLMResult, hours: number, generatedAt: string, totalFeeds: number, okFeeds: number, totalArticles: number) {
  const dt = new Date(generatedAt);
  const header = `# 🦞 AI Daily Digest（过去 ${hours} 小时）\n\n` +
    `> 生成时间：${dt.toLocaleString('zh-CN', { hour12: false })}  ｜抓取源：${okFeeds}/${totalFeeds}  ｜候选文章：${totalArticles}\n\n`;

  const highlights = `## 📝 今日看点\n\n` + r.highlights.map(x => `- ${x}`).join('\n') + '\n\n';

  const top = `## 🏆 今日必读（Top ${r.picked.length}）\n\n` +
    r.picked.map((a, i) => {
      const kw = a.keywords?.length ? a.keywords.slice(0, 6).map(k => `#${k}`).join(' ') : '';
      return [
        `### ${i + 1}. ${a.titleZh}`,
        `- 原文：${a.title}（${a.sourceName}）`,
        `- 链接：${a.link}`,
        `- 分类：${a.category} ｜综合评分：${a.score.toFixed(1)}（相关${a.dims.relevance}/质量${a.dims.quality}/时效${a.dims.timeliness}）`,
        a.summaryZh ? `- 摘要：${a.summaryZh}` : '',
        a.why ? `- 推荐理由：${a.why}` : '',
        kw ? `- 关键词：${kw}` : '',
        ''
      ].filter(Boolean).join('\n');
    }).join('\n');

  const statsLines = Object.entries(r.categoryStats || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `- ${k}：${n}`)
    .join('\n');

  const kwTop = (r.keywordTop || []).slice(0, 12).map(x => `- ${x.k}（${x.n}）`).join('\n');

  const stats = `\n\n## 📊 数据概览\n\n` +
    `**分类分布**\n\n${statsLines || '- （无）'}\n\n` +
    `**高频关键词**\n\n${kwTop || '- （无）'}\n`;

  return header + highlights + top + stats;
}

function buildPrompt(articles: InArticle[], topN: number, hours: number) {
  const compact = articles.map((a, idx) => ({
    i: idx,
    title: a.title,
    link: a.link,
    source: a.sourceName,
    publishedAt: a.publishedAt,
    desc: a.description,
  }));

  return `你要从一批技术博客文章里，筛选出“过去${hours}小时”最值得读的 Top ${topN}。\n\n` +
`要求：\n` +
`1) 输出语言：中文\n` +
`2) 每篇给出：titleZh(中文标题)、summaryZh(4-6句结构化摘要)、why(一句推荐理由)、category(六选一：AI/ML、安全、工程、工具/开源、观点/杂谈、其他)、keywords(3-8个中文或英文关键词)、score(1-10可含一位小数)、dims(相关性/质量/时效 1-10整数)\n` +
`3) 再给 3-5 条“今日看点”(highlights)，概括整体趋势\n` +
`4) 评分要相对拉开差距，真正筛掉水文/重复\n` +
`5) 仅基于给定信息（标题/简介/来源/时间）推断，别编造文章细节；如果信息不足，摘要要写成“这篇主要讨论/可能包含/预计会涉及…”的保守表述\n\n` +
`请严格输出 JSON（不要 markdown，不要解释），结构：\n` +
`{\n  "highlights": string[],\n  "picked": Array<{...Picked fields..., "index": number}>,\n  "categoryStats": Record<string, number>,\n  "keywordTop": Array<{"k": string, "n": number}>\n}\n\n` +
`其中 picked[].index 对应输入数组的 i。\n\n` +
`输入 articles：\n${JSON.stringify(compact)}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const input = args.input;
  const topN = Number(args['top-n'] ?? '15');

  if (!input) {
    console.error('Missing --input');
    process.exit(1);
  }

  const raw = await readFile(input, 'utf8');
  const data = JSON.parse(raw) as InJson;
  const hours = Number(args.hours ?? String(data.hours ?? 24));

  const prompt = buildPrompt(data.articles, topN, hours);
  const text = await callOpenAI(prompt);
  const parsed = safeJsonParse(text);

  const picked: Picked[] = (parsed.picked || []).map((p: any) => {
    const src = data.articles[p.index];
    return {
      ...src,
      score: Number(p.score),
      dims: {
        relevance: Number(p.dims?.relevance),
        quality: Number(p.dims?.quality),
        timeliness: Number(p.dims?.timeliness),
      },
      category: p.category,
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      titleZh: String(p.titleZh || ''),
      summaryZh: String(p.summaryZh || ''),
      why: String(p.why || ''),
    };
  });

  const out: LLMResult = {
    highlights: parsed.highlights || [],
    picked: picked.slice(0, topN),
    categoryStats: parsed.categoryStats || {},
    keywordTop: parsed.keywordTop || [],
  };

  const md = renderFeishuMarkdown(out, hours, data.generatedAt, data.totalFeeds, data.okFeeds, data.totalArticles);
  process.stdout.write(md + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
