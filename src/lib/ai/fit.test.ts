import { describe, expect, it, vi } from 'vitest';

import { getCharacterCountStatus } from '../constants';
import { threadsSpec } from '../platforms/threads';
import { xSpec } from '../platforms/x';
import { defaultLlmConfig } from './config';

vi.mock('./llmClient', () => ({ generateText: vi.fn() }));
import { generateText } from './llmClient';
import { generateFit } from './fit';

const mockGenerate = vi.mocked(generateText);

const config = { ...defaultLlmConfig(), enabled: true, apiKey: 'k' };

describe('generateFit deterministic length check', () => {
  it('accepts the first attempt when it is already within the limit', async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce('Short enough for X.');

    const result = await generateFit({ config, spec: xSpec, masterText: 'a'.repeat(600) });

    expect(result.withinLimit).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.count).toBeLessThanOrEqual(xSpec.charLimit);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('retries an under-cap result that would still leave the card in warning state', async () => {
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce('x'.repeat(240)) // Under 280, but inside the 50-character warning margin.
      .mockResolvedValueOnce('x'.repeat(220));

    const result = await generateFit({ config, spec: xSpec, masterText: 'long' });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(220);
    expect(getCharacterCountStatus(result.count, xSpec.charLimit, xSpec.warningThreshold)).toBe('normal');
    expect(mockGenerate.mock.calls[1][0].prompt).toContain('over the 229-character limit for your text');
  });

  it('does not accept a 488/500 warning-state Threads result', async () => {
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce('x'.repeat(488))
      .mockResolvedValueOnce('x'.repeat(440));

    const result = await generateFit({ config, spec: threadsSpec, masterText: 'long' });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(440);
    expect(getCharacterCountStatus(result.count, threadsSpec.charLimit, threadsSpec.warningThreshold)).toBe('normal');
    expect(mockGenerate.mock.calls[1][0].prompt).toContain('over the 449-character limit for your text');
  });

  it('regenerates when the model returns an over-limit version, then succeeds', async () => {
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce('x'.repeat(400)) // 400 > 280 → retry
      .mockResolvedValueOnce('Now it fits.'); // within limit

    const result = await generateFit({ config, spec: xSpec, masterText: 'long', maxAttempts: 3 });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.withinLimit).toBe(true);
    expect(result.text).toBe('Now it fits.');
    // The retry prompt must carry the over-limit feedback.
    expect(mockGenerate.mock.calls[1][0].prompt).toContain('over the 229');
  });

  it('deterministically trims to fit when every attempt exceeds the limit', async () => {
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce('x'.repeat(500))
      .mockResolvedValueOnce('x'.repeat(320)) // shortest
      .mockResolvedValueOnce('x'.repeat(400));

    const result = await generateFit({ config, spec: xSpec, masterText: 'long', maxAttempts: 3 });

    expect(mockGenerate).toHaveBeenCalledTimes(3);
    // Autofit must never leave a card over the limit, even when the model can't.
    expect(result.withinLimit).toBe(true);
    expect(result.count).toBeLessThanOrEqual(xSpec.charLimit);
  });

  it('keeps the referenced link when it has to trim the model\'s best effort', async () => {
    mockGenerate.mockReset();
    const overLimit = `${'word '.repeat(80)}https://example.test/reference-article`;
    mockGenerate
      .mockResolvedValueOnce(overLimit)
      .mockResolvedValueOnce(overLimit)
      .mockResolvedValueOnce(overLimit);

    const result = await generateFit({ config, spec: xSpec, masterText: 'long', maxAttempts: 3 });

    expect(result.withinLimit).toBe(true);
    expect(result.count).toBeLessThanOrEqual(xSpec.charLimit);
    // A deterministic prefix cut would have dropped the trailing URL.
    expect(result.text).toContain('https://example.test/reference-article');
    expect(result.text.endsWith('https://example.test/reference-article')).toBe(true);
  });

  it('escalates to an aggressive cut after two failed attempts', async () => {
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce('x'.repeat(400)) // attempt 1 over
      .mockResolvedValueOnce('x'.repeat(360)) // attempt 2 over
      .mockResolvedValueOnce('Fits now.'); // attempt 3 within

    await generateFit({ config, spec: xSpec, masterText: 'long', maxAttempts: 4 });

    // The 2nd retry prompt (after two misses) carries the firmer instruction.
    expect(mockGenerate.mock.calls[1][0].prompt).not.toContain('Be aggressive');
    expect(mockGenerate.mock.calls[2][0].prompt).toContain('Be aggressive');
  });

  it('preserves a word boundary when trimming a best effort with spaces', async () => {
    mockGenerate.mockReset();
    const overLimit = `${'word '.repeat(80)}END`; // 400+ chars, well over 280
    mockGenerate
      .mockResolvedValueOnce(overLimit)
      .mockResolvedValueOnce(overLimit)
      .mockResolvedValueOnce(overLimit);

    const result = await generateFit({ config, spec: xSpec, masterText: 'long', maxAttempts: 3 });

    expect(result.withinLimit).toBe(true);
    expect(result.count).toBeLessThanOrEqual(xSpec.charLimit);
    // Trimmed at a space, so it doesn't end mid-word.
    expect(result.text.endsWith('word')).toBe(true);
  });
});
