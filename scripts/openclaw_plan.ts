#!/usr/bin/env bun
/**
 * openclaw_plan.ts
 *
 * Build a deterministic plan for a daily digest run:
 * - read candidates.json (from openclaw_fetch.ts)
 * - filter obvious spam/sponsor posts
 * - dedupe links
 * - select a shortlist (most recent first)
 * - split into chunks for sub-agents to enrich in parallel
 * - write plan.json to output/<runId>/plan.json
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

type InJson = {
  generatedAt: string;
  hours: number;
  totalFeeds: number;
  okFeeds: number;
  failedFeeds: Array<{ name: string; xmlUrl: string; error: string }>;
  totalArticles: number;
  articles: InArticle[];
};

type Plan = {
  runId: string;
  hours: number;
  generatedAt: string;
  candidatesPath: string;
  totalFeeds: number;
  okFeeds: number;
  failedFeeds: Array<{ name: string; xmlUrl: string; error: string }>;
  totalCandidates: number;
  filteredOut: number;
  dedupedOut: number;
  shortlistSize: number;
  chunkSize: number;
  chunks: Array<{
    chunkId: number;
    inputPath: string; // json file containing articles for this chunk
    outputPath: string; // where the subagent should write enriched results
    count: number;
  }>;
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

function toRunId(now = new Date()) {
  // 20260318-014105
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function canonicalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    // drop common tracking params
    const drop = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'utm_id', 'utm_name', 'utm_reader', 'utm_referrer',
      'ref', 'ref_src', 'ref_url',
      'spm', 's', 'mkt_tok',
    ]);
    for (const k of [...url.searchParams.keys()]) {
      if (drop.has(k.toLowerCase())) url.searchParams.delete(k);
    }
    // normalize empty query
    if ([...url.searchParams.keys()].length === 0) url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

function isSponsorOrAd(title: string): boolean {
  const t = (title || '').toLowerCase();
  return (
    t.includes('[sponsor]') ||
    t.includes('sponsor') ||
    t.includes('sponsored') ||
    t.includes('advertisement') ||
    t.startsWith('ad:')
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const input = args.input;
  const outDir = args.outDir || './output';

  const hours = Number(args.hours || '24');
  const shortlistMax = Number(args.shortlistMax || '48');
  const chunkSize = Number(args.chunkSize || '8');
  const runId = args.runId || toRunId();

  if (!input) {
    console.error('Missing --input <candidates.json>');
    process.exit(1);
  }
  if (!Number.isFinite(shortlistMax) || shortlistMax <= 0) {
    console.error('Invalid --shortlistMax');
    process.exit(1);
  }
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    console.error('Invalid --chunkSize');
    process.exit(1);
  }

  const raw = await readFile(input, 'utf8');
  const data = JSON.parse(raw) as InJson;

  const all = Array.isArray(data.articles) ? data.articles : [];
  const totalCandidates = all.length;

  // Filter obvious sponsor/ad posts.
  const filtered = all.filter((a) => !isSponsorOrAd(a.title));
  const filteredOut = totalCandidates - filtered.length;

  // Dedupe by canonical link.
  const seen = new Set<string>();
  const deduped: InArticle[] = [];
  for (const a of filtered) {
    const canon = canonicalizeUrl(a.link);
    if (seen.has(canon)) continue;
    seen.add(canon);
    deduped.push({ ...a, link: canon });
  }
  const dedupedOut = filtered.length - deduped.length;

  // Sort by recency.
  deduped.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  const shortlist = deduped.slice(0, shortlistMax);

  const runDir = `${outDir}/${runId}`;
  await mkdir(runDir, { recursive: true });

  // Write per-chunk inputs
  const chunks: Plan['chunks'] = [];
  for (let i = 0; i < shortlist.length; i += chunkSize) {
    const chunkId = Math.floor(i / chunkSize) + 1;
    const slice = shortlist.slice(i, i + chunkSize);
    const inputPath = `${runDir}/chunk-${chunkId}.input.json`;
    const outputPath = `${runDir}/chunk-${chunkId}.enriched.json`;
    await writeFile(inputPath, JSON.stringify({ runId, chunkId, hours, articles: slice }, null, 2), 'utf8');
    chunks.push({ chunkId, inputPath, outputPath, count: slice.length });
  }

  const plan: Plan = {
    runId,
    hours: Number.isFinite(hours) ? hours : Number(data.hours ?? 24),
    generatedAt: data.generatedAt,
    candidatesPath: input,
    totalFeeds: data.totalFeeds,
    okFeeds: data.okFeeds,
    failedFeeds: data.failedFeeds || [],
    totalCandidates,
    filteredOut,
    dedupedOut,
    shortlistSize: shortlist.length,
    chunkSize,
    chunks,
  };

  const planPath = `${runDir}/plan.json`;
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

  // Also print the plan path for convenience
  process.stdout.write(planPath + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
