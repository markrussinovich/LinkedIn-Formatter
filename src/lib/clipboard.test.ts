import { describe, expect, it } from 'vitest';

import { prepareLinkedInClipboardText } from './clipboard';

describe('prepareLinkedInClipboardText', () => {
  it('makes authored blank lines survive LinkedIn paste handling', () => {
    expect(prepareLinkedInClipboardText('First\n\nSecond')).toBe('First\n\u200B\nSecond');
    expect(prepareLinkedInClipboardText('First\n\n\nSecond')).toBe('First\n\u200B\n\u200B\nSecond');
  });

  it('does not alter ordinary line breaks', () => {
    expect(prepareLinkedInClipboardText('First\nSecond')).toBe('First\nSecond');
  });
});