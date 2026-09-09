import { describe, expect, it } from 'vitest';

import { applyStrikethrough, applyUnderline, styleText } from './unicodeStyles';

describe('styleText', () => {
  it('maps ASCII letters and digits to sans-serif bold Unicode characters', () => {
    expect(styleText('Abc 123', { bold: true })).toBe('𝗔𝗯𝗰 𝟭𝟮𝟯');
  });

  it('maps italic text to sans-serif italic Unicode characters', () => {
    expect(styleText('Ahz', { italic: true })).toBe('𝘈𝘩𝘻');
  });

  it('maps bold italic text to sans-serif characters while leaving punctuation alone', () => {
    expect(styleText('Hi!', { bold: true, italic: true })).toBe('𝙃𝙞!');
  });

  it('maps code text to monospace Unicode characters', () => {
    expect(styleText('Code 9', { code: true })).toBe('𝙲𝚘𝚍𝚎 𝟿');
  });

  it('styles the whole code span, including @handles, #tags, and URLs', () => {
    // Inside code these are literal samples (npm scope, CSS id, sample link),
    // not real LinkedIn tokens, so the whole span must render monospace instead
    // of being left half-plain ASCII.
    for (const sample of ['add pkg@1.0', 'id="x" href="https://a.test"', 'tag #main']) {
      expect(styleText(sample, { code: true })).not.toMatch(/[A-Za-z0-9]/);
    }
  });

  it('keeps hashtags, mentions, and URLs parseable when styling surrounding text', () => {
    expect(styleText('Post #LinkedIn @Ada https://example.com', { bold: true })).toBe(
      '𝗣𝗼𝘀𝘁 #LinkedIn @Ada https://example.com',
    );
  });

  it('can apply experimental strikethrough to non-whitespace characters', () => {
    expect(applyStrikethrough('a b')).toBe('a̶ b̶');
  });

  it('can apply experimental underline to non-whitespace characters', () => {
    expect(applyUnderline('a b')).toBe('a̲ b̲');
    expect(styleText('Underlined #LinkedIn', { underline: true })).toBe('U̲n̲d̲e̲r̲l̲i̲n̲e̲d̲ #LinkedIn');
  });

  it('preserves emoji when applying combining styles', () => {
    expect(styleText('Ship 🚀 now', { underline: true, strike: true })).toBe('S̶̲h̶̲i̶̲p̶̲ 🚀 n̶̲o̶̲w̶̲');
  });

  it('leaves ZWJ emoji sequences intact when striking through', () => {
    // No U+0336 may be inserted anywhere inside the family sequence.
    expect(applyStrikethrough('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(applyStrikethrough('a 👨‍👩‍👧 b')).toBe('a̶ 👨‍👩‍👧 b̶');
  });

  it('leaves keycap sequences intact when underlining', () => {
    expect(applyUnderline('1️⃣')).toBe('1️⃣');
    expect(applyUnderline('go 1️⃣ go')).toBe('g̲o̲ 1️⃣ g̲o̲');
  });

  it('leaves flags and skin-tone emoji intact when striking through', () => {
    expect(applyStrikethrough('🇺🇸')).toBe('🇺🇸');
    expect(applyStrikethrough('👍🏽')).toBe('👍🏽');
  });

  it('leaves keycap and flag emoji intact when bolding', () => {
    // Mapping the base digit of 1️⃣ to a mathematical bold digit shatters the keycap.
    expect(styleText('1️⃣', { bold: true })).toBe('1️⃣');
    expect(styleText('top 1️⃣ pick', { bold: true })).toBe('𝘁𝗼𝗽 1️⃣ 𝗽𝗶𝗰𝗸');
    expect(styleText('🇺🇸 usa', { bold: true })).toBe('🇺🇸 𝘂𝘀𝗮');
    expect(styleText('#️⃣ tag', { code: true })).toBe('#️⃣ 𝚝𝚊𝚐');
  });
});