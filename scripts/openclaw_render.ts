#!/usr/bin/env bun
/**
 * openclaw_render.ts
 *
 * Aggregate enriched chunk outputs and render Feishu-friendly Markdown.
 */

import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';

type Enriched = {
  title: string;
  link: string;
  publishedAt: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
  fetched: { ok: boolean; status?: number; finalUrl?: string; bytes?: number; error?: string };
  llm: {
    score: number;
    dims: { relevance: number; quality: number; timeliness: number };
    category: string;
    keywords: string[];
    titleZh: string;
    summaryZh: string;
    why: string;
    confidence: 'high' | 'medium' | 'low';
  };
};

type ChunkOut = {
  runId: string;
  chunkId: number;
  generatedAt: string;
  model: string;
  enriched: Enriched[];
};

type Plan = {
  runId: string;
  hours: number;
  generatedAt: string;
  totalFeeds: number;
  okFeeds: number;
  failedFeeds: Array<{ name: string; xmlUrl: string; error: string }>;
  totalCandidates: number;
  shortlistSize: number;
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

function fmtBeijing(iso: string) {
  const d = new Date(iso);
  // Use system tz; cron runs on the machine which is already Asia/Shanghai.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render(plan: Plan, picked: Enriched[], highlights: string[], categoryStats: Record<string, number>, keywordTop: Array<{ k: string; n: number }>) {
  const failList = (plan.failedFeeds || []).slice(0, 8).map(f => f.name).join('、');
  const failLine = (plan.failedFeeds?.length)
    ? `｜失败源（${plan.failedFeeds.length}）：${failList}${plan.failedFeeds.length > 8 ? '…' : ''}`
    : '';

  const header = `# 🦞 AI 每日日报｜过去${plan.hours}小时（Top ${picked.length}）\n\n` +
    `生成时间：${fmtBeijing(new Date().toISOString())}｜抓取源：${plan.okFeeds}/${plan.totalFeeds}｜候选：${plan.totalCandidates}｜短名单：${plan.shortlistSize}` +
    `${failLine}\n\n`;

  const highlightsBlock = `## 📝 今日看点（3-5条）\n\n` + (highlights.length ? highlights.map(h => `- ${h}`).join('\n') : '- （暂无）') + '\n\n';

  const topBlock = `## 🏆 今日必读（Top ${picked.length}）\n\n` + picked.map((a) => {
    const meta = `${a.sourceName}｜${fmtBeijing(a.publishedAt)}｜${a.llm.category}｜${a.llm.score.toFixed(1)}（相关${a.llm.dims.relevance}/质量${a.llm.dims.quality}/时效${a.llm.dims.timeliness}）`;
    const kws = (a.llm.keywords || []).slice(0, 8).map(k => `\`${k}\``).join(' ');
    return [
      `### [${a.llm.titleZh || a.title}](${a.link})`,
      `> ${a.llm.summaryZh || '（摘要缺失）'}`,
      '',
      `${meta}`,
      a.llm.why ? `推荐理由：${a.llm.why}` : '',
      kws ? `关键词：${kws}` : '',
      ''
    ].filter(Boolean).join('\n');
  }).join('\n');

  const statsLines = Object.entries(categoryStats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}：${n}`).join('\n') || '- （无）';
  const kwLines = (keywordTop || []).slice(0, 10).map(x => `- ${x.k}（${x.n}）`).join('\n') || '- （无）';

  const statsBlock = `\n\n## 📊 数据概览（分类计数 + 高频关键词Top10）\n\n` +
    `**分类计数**\n\n${statsLines}\n\n` +
    `**高频关键词Top10**\n\n${kwLines}\n`;

  return header + highlightsBlock + topBlock + statsBlock;
}

function computeStats(items: Enriched[]) {
  const categoryStats: Record<string, number> = {};
  const kwCount: Record<string, number> = {};
  for (const a of items) {
    const c = a.llm.category || '其他';
    categoryStats[c] = (categoryStats[c] || 0) + 1;
    for (const k of (a.llm.keywords || [])) {
      const kk = String(k).trim();
      if (!kk) continue;
      kwCount[kk] = (kwCount[kk] || 0) + 1;
    }
  }
  const keywordTop = Object.entries(kwCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
  return { categoryStats, keywordTop };
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = args.runDir;
  const topN = Number(args.topN || '15');
  const planPath = args.plan;

  if (!runDir) {
    console.error('Missing --runDir <output/<runId>>');
    process.exit(1);
  }
  if (!planPath) {
    console.error('Missing --plan <plan.json>');
    process.exit(1);
  }

  const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;

  const files = await readdir(runDir);
  const chunkFiles = files.filter(f => f.endsWith('.enriched.json'));
  const outs: ChunkOut[] = [];
  for (const f of chunkFiles) {
    const p = `${runDir}/${f}`;
    outs.push(JSON.parse(await readFile(p, 'utf8')) as ChunkOut);
  }

  const enrichedAll = outs.flatMap(o => o.enriched || []);

  // Rank: score desc, then timeliness desc
  enrichedAll.sort((a, b) => {
    const ds = (b.llm.score || 0) - (a.llm.score || 0);
    if (ds !== 0) return ds;
    return String(b.publishedAt).localeCompare(String(a.publishedAt));
  });

  const picked = enrichedAll.slice(0, topN);

  // Highlights: cheap heuristic from top categories/keywords
  const { categoryStats, keywordTop } = computeStats(picked);
  const highlights: string[] = [];
  const catTop = Object.entries(categoryStats).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (catTop.length) highlights.push(`今天阅读重心集中在：${catTop.map(([c, n]) => `${c}（${n}）`).join('、')}。`);
  const kwTop = keywordTop.slice(0, 5).map(x => x.k);
  if (kwTop.length) highlights.push(`高频关键词：${kwTop.join(' / ')}。`);
  const lowConf = picked.filter(p => p.llm.confidence === 'low').length;
  if (lowConf) highlights.push(`其中有 ${lowConf} 篇为低置信摘要（页面抓取信息不足，已保守表述）。`);

  const md = render(plan, picked, highlights.slice(0, 5), categoryStats, keywordTop);
  process.stdout.write(md + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

