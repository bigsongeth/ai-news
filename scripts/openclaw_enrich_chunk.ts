#!/usr/bin/env bun
/**
 * openclaw_enrich_chunk.ts
 *
 * For a chunk of articles, fetch page bodies (best-effort) and produce enriched JSON
 * that the final aggregator can rank + render.
 *
 * IMPORTANT: This script is designed to be run by sub-agents (or locally) and uses
 * OPENAI-compatible env vars for LLM calls.
 */

import process from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type InArticle = {
  title: string;
  link: string;
  publishedAt: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
};

type ChunkInput = {
  runId: string;
  chunkId: number;
  hours: number;
  articles: InArticle[];
};

type Enriched = InArticle & {
  fetched: {
    ok: boolean;
    status?: number;
    finalUrl?: string;
    bytes?: number;
    error?: string;
  };
  extracted: {
    title?: string;
    text: string; // truncated
  };
  llm: {
    score: number;
    dims: { relevance: number; quality: number; timeliness: number };
    category: 'AI/ML' | '安全' | '工程' | '工具/开源' | '观点/杂谈' | '其他';
    keywords: string[];
    titleZh: string;
    summaryZh: string;
    why: string;
    confidence: 'high' | 'medium' | 'low';
  };
};

type Out = {
  runId: string;
  chunkId: number;
  generatedAt: string;
  model: string;
  enriched: Enriched[];
};

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

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function callOpenAI(prompt: string): Promise<{ content: string; model: string }> {
  const apiKey = mustEnv('OPENAI_API_KEY');
  const base = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 600)}`);
  }

  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('LLM returned empty content');
  return { content, model };
}

function safeJsonParse(text: string): any {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m?.[1]) return JSON.parse(m[1]);
  throw new Error('Failed to parse JSON from LLM output');
}

function truncateText(s: string, max: number) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

async function fetchPageText(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; finalUrl?: string; text: string; bytes?: number; error?: string; title?: string }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'OpenClaw ai-daily-digest enrich (+https://openclaw.ai)'
      }
    });
    const status = res.status;
    const finalUrl = res.url;
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      return { ok: false, status, finalUrl, text: '', error: `HTTP ${status}` };
    }
    // Only attempt text/html
    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      const buf = await res.arrayBuffer();
      return { ok: false, status, finalUrl, text: '', bytes: buf.byteLength, error: `Unsupported content-type: ${ct}` };
    }
    const html = await res.text();
    const bytes = Buffer.byteLength(html, 'utf8');

    // naive extraction: strip scripts/styles + tags
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ')?.trim();

    return { ok: true, status, finalUrl, text: cleaned, bytes, title };
  } catch (e: any) {
    return { ok: false, text: '', error: String(e?.message ?? e) };
  } finally {
    clearTimeout(id);
  }
}

function buildPrompt(a: InArticle, pageText: string, pageTitle?: string) {
  const input = {
    title: a.title,
    link: a.link,
    source: a.sourceName,
    publishedAt: a.publishedAt,
    desc: a.description,
    pageTitle: pageTitle || null,
    pageText: truncateText(pageText, 8000),
  };

  return `你是「AI Daily Digest」的编辑助理。请对单篇文章做评分、分类、中文标题与摘要。

` +
`硬规则：
` +
`- 只允许基于给定输入（title/desc/pageText/source/time）；不要编造文章里不存在的细节。
` +
`- 如果 pageText 信息不足，摘要必须用保守措辞（可能/主要讨论/预计涉及），并降低 confidence。
` +
`- 输出必须是严格 JSON（不要 markdown，不要解释）。

` +
`输出结构：
` +
`{
  "score": number, // 1-10 可含 1 位小数
  "dims": {"relevance": int1-10, "quality": int1-10, "timeliness": int1-10},
  "category": "AI/ML"|"安全"|"工程"|"工具/开源"|"观点/杂谈"|"其他",
  "keywords": string[], // 3-8
  "titleZh": string,
  "summaryZh": string, // 4-6 句
  "why": string, // 1 句
  "confidence": "high"|"medium"|"low"
}

输入：
${JSON.stringify(input)}
`;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = args.input;
  const outputPath = args.output;
  const fetchTimeoutMs = Number(args.fetchTimeoutMs || '15000');

  if (!inputPath) {
    console.error('Missing --input <chunk.input.json>');
    process.exit(1);
  }
  if (!outputPath) {
    console.error('Missing --output <chunk.enriched.json>');
    process.exit(1);
  }

  const raw = await readFile(inputPath, 'utf8');
  const chunk = JSON.parse(raw) as ChunkInput;

  const enriched: Enriched[] = [];
  let modelUsed = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  for (const a of chunk.articles || []) {
    const fetched = await fetchPageText(a.link, fetchTimeoutMs);
    const prompt = buildPrompt(a, fetched.text, fetched.title);

    try {
      const { content, model } = await callOpenAI(prompt);
      modelUsed = model;
      const p = safeJsonParse(content);
      enriched.push({
        ...a,
        fetched: {
          ok: fetched.ok,
          status: fetched.status,
          finalUrl: fetched.finalUrl,
          bytes: fetched.bytes,
          error: fetched.error,
        },
        extracted: {
          title: fetched.title,
          text: truncateText(fetched.text, 12000),
        },
        llm: {
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
          confidence: p.confidence || 'low',
        }
      });
    } catch (e: any) {
      // If LLM fails for one item, keep a stub so aggregator can proceed.
      enriched.push({
        ...a,
        fetched: {
          ok: fetched.ok,
          status: fetched.status,
          finalUrl: fetched.finalUrl,
          bytes: fetched.bytes,
          error: fetched.error,
        },
        extracted: {
          title: fetched.title,
          text: truncateText(fetched.text, 12000),
        },
        llm: {
          score: 0,
          dims: { relevance: 0, quality: 0, timeliness: 0 },
          category: '其他',
          keywords: [],
          titleZh: '',
          summaryZh: '',
          why: `LLM error: ${String(e?.message ?? e)}`,
          confidence: 'low',
        }
      });
    }
  }

  const out: Out = {
    runId: chunk.runId,
    chunkId: chunk.chunkId,
    generatedAt: new Date().toISOString(),
    model: modelUsed,
    enriched,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(out, null, 2), 'utf8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
