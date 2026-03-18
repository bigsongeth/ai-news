# AI Daily Digest — Pipeline v2.5

## Goal

Turn the digest from a single-pass summary into a staged newsroom pipeline:

1. Fetch candidates
2. Scout signals / missing stories
3. Verify canonical sources
4. Extract article bodies
5. Edit article cards
6. Render final Feishu digest

## Stage files

For each run id (`output/<runId>/`), the pipeline should aim to create:

- `plan.json` — shortlist + chunk plan
- `signals.json` — themes / missing candidates / duplicate clusters
- `validated_sources.json` — canonical source mapping + confidence
- `chunk-<n>.extracted.json` — extraction outputs per chunk
- `chunk-<n>.edited.json` — edited/scored outputs per chunk
- `digest.md` — final rendered digest

## Sub-agent roles

### 1) Scout
- Purpose: identify themes, missing important stories, and duplicate clusters
- Main guidance: use `search-layer` routing ideas (`Fresh`, `Evidence`, `Trace`) when deciding what to look up
- Output: `signals.json`

### 2) Verifier
- Purpose: map candidates to more canonical / official sources when possible
- Main guidance: use `search-layer` Evidence/Trace logic; prefer original source over commentary
- Output: `validated_sources.json`

### 3) Extractor
- Purpose: fetch article bodies reliably
- Main guidance: follow `content-extract` decision tree conceptually (`web_fetch` probe first, then heavier fallback when needed)
- Output: `chunk-<n>.extracted.json`
- Hard rule: do not silently skip extraction. Every item must record attempts, failure stage, failure reason, and content length.

### 4) Editor
- Purpose: produce digest-ready article cards
- Output: `chunk-<n>.edited.json`

### 5) Chief Editor (main agent)
- Purpose: merge, rank, write highlights, render Feishu markdown
- Output: `digest.md`

## Output contracts

### `signals.json`

```json
{
  "runId": "20260318-080000",
  "themes": [
    {
      "topic": "Mistral release",
      "importance": 0.92,
      "supporting_urls": ["https://..."],
      "notes": "why it matters"
    }
  ],
  "missing_candidates": [
    {
      "title": "...",
      "url": "https://...",
      "reason": "important story absent from RSS shortlist"
    }
  ],
  "duplicate_clusters": [
    {
      "label": "same release, multiple commentaries",
      "urls": ["https://...", "https://..."]
    }
  ]
}
```

### `validated_sources.json`

```json
{
  "runId": "20260318-080000",
  "items": [
    {
      "candidate_url": "https://...",
      "canonical_source_url": "https://...",
      "source_type": "official",
      "confidence": "high",
      "notes": "official blog post found"
    }
  ]
}
```

### `chunk-<n>.extracted.json`

```json
{
  "runId": "20260318-080000",
  "chunkId": 1,
  "items": [
    {
      "title": "...",
      "link": "https://...",
      "publishedAt": "...",
      "description": "...",
      "sourceName": "...",
      "sourceUrl": "...",
      "canonicalSourceUrl": "https://...",
      "extraction": {
        "ok": true,
        "engine": "web_fetch",
        "sources": ["https://..."],
        "notes": [],
        "attempts": [
          {"engine": "web_fetch", "ok": true, "content_chars": 4200}
        ],
        "failure_stage": null,
        "failure_reason": null,
        "content_chars": 4200,
        "markdown": "..."
      }
    }
  ]
}
```

Failure example:

```json
{
  "ok": false,
  "engine": "browser",
  "sources": ["https://..."],
  "notes": ["browser navigation timed out"],
  "attempts": [
    {"engine": "web_fetch", "ok": false, "failure_reason": "too_short", "content_chars": 84},
    {"engine": "browser", "ok": false, "failure_reason": "timeout", "content_chars": 0}
  ],
  "failure_stage": "browser",
  "failure_reason": "timeout",
  "content_chars": 0,
  "markdown": ""
}
```

### `chunk-<n>.edited.json`

```json
{
  "runId": "20260318-080000",
  "chunkId": 1,
  "items": [
    {
      "title": "...",
      "link": "https://...",
      "publishedAt": "...",
      "sourceName": "...",
      "sourceUrl": "...",
      "canonicalSourceUrl": "https://...",
      "score": 8.8,
      "dims": { "relevance": 9, "quality": 8, "timeliness": 9 },
      "category": "AI/ML",
      "keywords": ["Mistral", "MoE"],
      "titleZh": "...",
      "summaryZh": "...",
      "why": "...",
      "confidence": "medium",
      "sources": ["https://..."],
      "extractionOk": true,
      "extractionEngine": "web_fetch",
      "extractionFailureReason": null,
      "contentChars": 4200
    }
  ]
}
```

## Important rules

- Sub-agents should write files, not chatty summaries.
- Sub-agents should finish with exactly `ANNOUNCE_SKIP`.
- Main agent is responsible for the only user-visible / Feishu-visible final digest.
- If extraction fails, keep the article with conservative wording and lower confidence.
- If verification fails, keep the candidate source but mark confidence accordingly.
- Extractor is not allowed to emit `engine: "none"` without also including non-empty `attempts`, `failure_stage`, and `failure_reason`.
