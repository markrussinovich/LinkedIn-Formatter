import type { EditorNode } from '../exportText';
import { WARNING_MARGIN } from '../constants';
import { lastUrlInText } from '../linkPreview';
import { markdownToTipTap } from '../markdownToTipTap';
import { renderForPlatform } from '../platforms';
import type { PlatformSpec } from '../platforms/types';
import type { LlmConfig } from './config';
import { generateText } from './llmClient';
import { buildFitRequest, buildOverLimitFeedback } from './prompts';

export interface FitResult {
  doc: EditorNode;
  text: string;
  count: number;
  withinLimit: boolean;
  attempts: number;
}

export interface FitOptions {
  config: LlmConfig;
  spec: PlatformSpec;
  masterText: string;
  style?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
}

// Measures a candidate exactly the way its preview card will (same render path),
// so the deterministic check matches what the user sees.
function measure(text: string, spec: PlatformSpec): { doc: EditorNode; count: number } {
  // Parse Markdown so **bold**/*italic*/lists become real marks; platforms that
  // don't allow styling flatten them back to plain text at render time.
  const doc = markdownToTipTap(text);
  return { doc, count: renderForPlatform(doc, spec).summary.count };
}

// Generates a platform-fitted version, then deterministically checks the length
// and re-prompts the model to shorten until it fits (or attempts run out). The
// model isn't trusted to count — we verify and feed the real overage back.
export async function generateFit({ config, spec, masterText, style, signal, maxAttempts = 4 }: FitOptions): Promise<FitResult> {
  const effectiveLimit = Math.max(0, Math.min(spec.warningThreshold - 1, spec.charLimit - WARNING_MARGIN - 1));
  const base = buildFitRequest(spec, masterText, style, effectiveLimit);
  let best: { doc: EditorNode; text: string; count: number } | null = null;
  let feedback = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = feedback ? `${base.prompt}\n\n${feedback}` : base.prompt;
    const text = await generateText({ config, system: base.system, prompt, signal });
    const { doc, count } = measure(text, spec);

    if (count <= effectiveLimit) {
      return { doc, text, count, withinLimit: true, attempts: attempt };
    }

    if (!best || count < best.count) {
      best = { doc, text, count };
    }

    // `attempt` == the number of times the model has now gone over the limit,
    // so the feedback escalates to an aggressive cut after the second miss.
    feedback = buildOverLimitFeedback(spec, text, count, effectiveLimit, attempt);

    if (signal?.aborted) {
      break;
    }
  }

  // The model couldn't get fully under the limit in the allotted attempts.
  // Deterministically trim its shortest attempt so autofit never leaves a card
  // over the limit (e.g. a Threads post stuck at 502/500).
  const fallback = best ?? measureToResult('', spec);
  const trimmed = trimToLimit(fallback.text, spec, effectiveLimit);
  return { ...trimmed, withinLimit: trimmed.count <= effectiveLimit, attempts: maxAttempts };
}

function measureToResult(text: string, spec: PlatformSpec): { doc: EditorNode; text: string; count: number } {
  const { doc, count } = measure(text, spec);
  return { doc, text, count };
}

// Last-resort deterministic shortener: finds the longest prefix of `text` that
// renders within `limit` (binary search on the platform's real counting), then
// backs off to the nearest word boundary so it doesn't cut mid-word. A URL the
// author referenced is never what gets cut — when the prefix loses the post's
// final link, the text is shortened further to make room for it.
function trimToLimit(text: string, spec: PlatformSpec, limit: number): { doc: EditorNode; text: string; count: number } {
  const initial = measure(text, spec);

  if (initial.count <= limit) {
    return { doc: initial.doc, text, count: initial.count };
  }

  const trimmed = longestPrefixWithin(text, spec, limit, '');
  const lastUrl = lastUrlInText(text);

  if (!lastUrl || trimmed.includes(lastUrl)) {
    return measureToResult(trimmed, spec);
  }

  // Only re-add the link if the platform's budget can actually hold it.
  if (measure(lastUrl, spec).count > limit) {
    return measureToResult(trimmed, spec);
  }

  const suffix = `\n\n${lastUrl}`;
  return measureToResult(`${longestPrefixWithin(trimmed, spec, limit, suffix)}${suffix}`.trimStart(), spec);
}

// Longest word-boundary prefix of `text` that still fits `limit` once `suffix`
// (which is kept in full) is appended.
function longestPrefixWithin(text: string, spec: PlatformSpec, limit: number, suffix: string): string {
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const fits = measure(`${chars.slice(0, mid).join('')}${suffix}`, spec).count <= limit;

    if (fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  let slice = chars.slice(0, lo).join('').replace(/\s+$/u, '');
  const lastSpace = slice.lastIndexOf(' ');

  if (lastSpace > lo * 0.7) {
    slice = slice.slice(0, lastSpace).replace(/\s+$/u, '');
  }

  return slice;
}
