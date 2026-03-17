#!/usr/bin/env bun
/**
 * openclaw_render_v25.ts
 *
 * Render final digest from edited chunk outputs and optional signals/source validation.
 */

import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';

type EditedItem = {
  title: string;
  link: string;
  publishedAt: string;
  sourceName: string;
  sourceUrl: string;
  canonicalSourceUrl?: string;
  score: number;
  dims: { relevance: number; quality: number; timeliness: number };
  category: string;
  keywords: string[];
  titleZh: string;
  summaryZh: string;
  why: string;
  confidence: 'high' | 'medium' | 'low';
  sources?: string[];
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

type Signals = {
  themes?: Array<{ topic: string; importance?: number; supporting_urls?: string[]; notes?: string }>;
  missing_candidates?: Array<{ title: string; url: string; reason?: string }>;
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function computeStats(items: EditedItem[]) {
  const categoryStats: Record<string, number> = {};
  const kwCount: Record<string, number> = {};
  for (const a of items) {
    const c = a.category || '其他';
    categoryStats[c] = (categoryStats[c] || 0) + 1;
    for (const k of (a.keywords || [])) {
      const kk = String(k).trim();
      if (!kk) continue;
      kwCount[kk] = (kwCount[kk] || 0) + 1;
    }
  }
  const keywordTop = Object.entries(kwCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ k, n }));
  return { categoryStats, keywordTop };
}

function buildHighlights(items: EditedItem[], signals?: Signals) {
  const out: string[] = [];
  if (signals?.themes?.length) {
    const topThemes = signals.themes.slice(0, 3).map(t => t.topic).filter(Boolean);
    if (topThemes.length) out.push(`今天的核心主题集中在：${topThemes.join('、')}。`);
  }
  const lowConf = items.filter(x => x.confidence === 'low').length;
  if (lowConf) out.push(`其中有 ${lowConf} 篇为低置信摘要，已使用保守措辞处理。`);
  const officialCount = items.filter(x => x.canonicalSourceUrl).length;
  if (officialCount) out.push(`有 ${officialCount} 篇条目补到了更原始或更官方的来源。`);
  if (signals?.missing_candidates?.length) {
    out.push(`搜索补漏发现 ${signals.missing_candidates.length} 条潜在重要候选，但未全部纳入最终 Top 榜单。`);
  }
  return out.slice(0, 5);
}

async function main() {
  const args = parseArgs(process.argv);
  const runDir = args.runDir;
  const planPath = args.plan;
  const topN = Number(args.topN || '15');

  if (!runDir || !planPath) {
    console.error('Missing --runDir or --plan');
    process.exit(1);
  }

  const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
  let signals: Signals | undefined;
  try {
    signals = JSON.parse(await readFile(`${runDir}/signals.json`, 'utf8')) as Signals;
  } catch {}

  const files = await readdir(runDir);
  const editedFiles = files.filter(f => f.endsWith('.edited.json'));

  const items: EditedItem[] = [];
  for (const f of editedFiles) {
    const obj = JSON.parse(await readFile(`${runDir}/${f}`, 'utf8')) as { items?: EditedItem[] };
    if (Array.isArray(obj.items)) items.push(...obj.items);
  }

  items.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return String(b.publishedAt).localeCompare(String(a.publishedAt));
  });

  const picked = items.slice(0, topN);
  const { categoryStats, keywordTop } = computeStats(picked);
  const highlights = buildHighlights(picked, signals);

  const failList = (plan.failedFeeds || []).slice(0, 8).map(f => f.name).join('、');
  const failLine = plan.failedFeeds?.length ? `\n> 失败源（${plan.failedFeeds.length}）：${failList}${plan.failedFeeds.length > 8 ? '…' : ''}` : '';

  let md = '';
  md += `# 🦞 AI Daily Digest｜过去${plan.hours}小时（Top ${picked.length}）\n\n`;
  md += `> 生成时间：${fmtBeijing(new Date().toISOString())}｜抓取源：${plan.okFeeds}/${plan.totalFeeds}｜候选：${plan.totalCandidates}｜短名单：${plan.shortlistSize}${failLine}\n\n`;
  md += `## 📝 今日看点（3-5条）\n\n`;
  md += (highlights.length ? highlights.map(x => `- ${x}`).join('\n') : '- （暂无）') + '\n\n';
  md += `## 🏆 今日必读（Top ${picked.length}）\n\n`;

  for (const a of picked) {
    const meta = `${a.sourceName}｜${fmtBeijing(a.publishedAt)}｜${a.category}｜${a.score.toFixed(1)}（相关${a.dims.relevance}/质量${a.dims.quality}/时效${a.dims.timeliness}）`;
    const kws = (a.keywords || []).slice(0, 8).map(k => `\`${k}\``).join(' ');
    md += `### [${a.titleZh || a.title}](${a.link})\n`;
    md += `> ${a.summaryZh || '（摘要缺失）'}\n`;
    md += `${meta}\n`;
    if (a.why) md += `推荐理由：${a.why}\n`;
    if (a.canonicalSourceUrl) md += `原始/更权威来源：${a.canonicalSourceUrl}\n`;
    if (kws) md += `关键词：${kws}\n`;
    md += `\n`;
  }

  md += `## 📊 数据概览（分类计数 + 高频关键词Top10）\n\n`;
  md += `**分类计数**\n\n`;
  md += Object.entries(categoryStats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}：${n}`).join('\n') || '- （无）';
  md += `\n\n**高频关键词Top10**\n\n`;
  md += keywordTop.slice(0, 10).map(x => `- ${x.k}（${x.n}）`).join('\n') || '- （无）';
  md += `\n`;

  process.stdout.write(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
