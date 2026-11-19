# Running jev-mcp on Google's Decisions API

`JEV_PROVIDER=google` sends the same typed questions to Google's native `POST /v1beta/decisions` (`gemini-decision-1`) instead of TypeSafe Jev. Official docs: <https://aistudio.google.com/docs/decisions-api>, announcement: <https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/>.

```bash
JEV_PROVIDER=google GEMINI_API_KEY=... npx jev-mcp          # 12 Jev tools + decisions_ask
JEV_PROVIDER=google GEMINI_API_KEY=... JEV_MEDIA_ROOT=$PWD/media npx jev-mcp   # let decisions_ask read ./media
```

## The contract, and how this server maps onto it

| | Jev / OpenRouter `/alpha/decisions` | Google `/v1beta/decisions` |
|---|---|---|
| Auth | `Authorization: Bearer` | `x-goog-api-key` |
| Body | `{model, state, questions}` | `{model, input, questions}` |
| Shared input | `state`: any JSON | `input`: string, or typed content blocks (text, image, audio, video, document) |
| Question text | `instructions` may be an object | `instructions` must be text |
| `noul` criteria | `{true, false}` | `{true_description, false_description}` |
| `choice` criteria | `{id: description or null}` | `{id: description}`; `""` when the id says it all |
| `score` criteria | array of levels | array of levels (2 to 255) |
| Answers | typed answer per question | same, plus `confidence` on every answer |
| Usage | `input_tokens`, `output_tokens` | `total_input_tokens`, `total_output_tokens` (always 0), `input_tokens_by_modality` |

`toGoogleDecisionsBody()` in `src/provider.ts` does the rewrite and is unit tested. Google sorts `choice` keys alphabetically before scoring, so option order in a request never matters. `noul` probabilities are clamped to 0.01 to 0.99.

## `decisions_ask`

Registered only with `JEV_PROVIDER=google`. Input blocks:

| Block | Source | Notes |
|---|---|---|
| `text` | `text` | Adjacent text blocks are concatenated with no separator; end each with a newline. |
| `image` | `path`, `uri` or `data` | `resolution`: `low`, `medium`, `high`, `ultra_high`. |
| `audio` | same | wav, mp3, aiff, aac, ogg, flac, m4a, opus, webm. |
| `video` | same | mp4, mpeg, mov, avi, webm, wmv, flv, 3gp. `resolution` allowed. |
| `document` | same | PDF only. |

Local `path` files are read under `JEV_MEDIA_ROOT` (default: the working directory); anything resolving outside it, symlinks included, is refused. Files above `JEV_MEDIA_MAX_BYTES` (20 MiB) must go through Google's Files API and be passed as `uri`. `uri` must be https. Google's own limits: 100 MB inline (50 MB for PDFs), 15 MB per external URL, 262,144 tokens of context, 1 to 1,000 questions per request (this tool allows 200).

## What was measured (2026-11-19, `gemini-decision-1`, free tier)

One Grade 4 maths paper and two public KNEC documents; labels were set by hand. Small samples, so these are directions, not accuracy figures.

**Jev tools on Google**

| Tool | Result |
|---|---|
| `jev_noul` | 8 of 8 correct, all auto at 0.85 |
| `jev_classify` | 16 of 16 topics correct (15 auto, 1 review at 0.56) |
| `jev_compare` | 6 of 6; equal values (`2 3/4` and `11/4`) 0.95 to 0.98 same, different values 0.67 to 0.83 contradicts |
| `jev_screen` | 5 of 6; injection texts 0.94 to 0.98, a benign "Ignore the zeros when rounding" 0.08 |
| `jev_find` / `jev_rerank` | top-1 equal to Jev 1.14 on 24 of 26; the `exists` cut-offs need recalibrating |
| `jev_verify` | ranks true above false claims (AUC 0.86) but contradicted 4 of 14 correct arithmetic answers and auto-accepted none |
| `jev_decide` | weak on a clear arithmetic choice (0.55) and did not flag an ambiguous question |
| `jev_review`, `jev_gate` | order a good edit above a bad one, but accept neither |
| `jev_extract`, `jev_audit` | more overconfident than Jev on truncated values; keep extraction in code |

**Multimodal (`decisions_ask`)**

| Input | Result | Input tokens |
|---|---|---|
| 3-page PDF vs its extracted text | both 9 of 9 | 2,893 vs 1,255 |
| One page image at low / medium / high / ultra_high | 10 of 10 at every level | 266 / 520 / 1,102 / 2,173 image tokens |
| Image plus a text block (mixed) | 3 of 3 | 766 |
| Two PDFs in one input | noticed that a scheme belonged to a different exam (0.07), 2 of 2 | 4,172 |
| A 2-page scheme PDF, 4 true and 4 false claims | 8 of 8 | 2,092 |
| Text rendered inside an image | injection text 0.91, benign 0.10; read the digits correctly | 670 |
| Audio (text-to-speech clips) | place value word 4 of 4; which multi-digit number 1 of 4 | about 70 per 2 s clip |
| 4 s video made from the page | 4 of 5 | 392 (resolution did not change it) |
| Public https URIs: image, audio, video | accepted | 361, 2,120, 1,665 |

Per call, 0.65 to 2.1 s end to end from Nairobi for inline media, 3.2 s for a URI video. Output tokens were 0 everywhere.

**Not tested:** handwriting, real learner scans (kept off a free-tier key on purpose), noisy or accented speech, long video, the Files API upload path, thresholds beyond Jev's defaults.
