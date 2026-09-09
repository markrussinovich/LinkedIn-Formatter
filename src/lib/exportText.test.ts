import { describe, expect, it } from 'vitest';

import { exportLinkedInText } from './exportLinkedInText';
import { exportText, type EditorNode } from './exportText';
import { styleText } from './unicodeStyles';

function doc(content: EditorNode[]): EditorNode {
  return { type: 'doc', content };
}

function paragraph(content: EditorNode[]): EditorNode {
  return { type: 'paragraph', content };
}

function text(value: string, marks: EditorNode['marks'] = []): EditorNode {
  return { type: 'text', text: value, marks };
}

const STYLED_FIXTURES: EditorNode[] = [
  doc([paragraph([text('First')]), paragraph([text('Second')])]),
  doc([
    paragraph([
      text('Bold', [{ type: 'bold' }]),
      text(' and '),
      text('italic', [{ type: 'italic' }]),
      text('.'),
    ]),
  ]),
  doc([{ type: 'heading', attrs: { level: 2 }, content: [text('Launch notes')] }]),
  doc([paragraph([text('Underlined', [{ type: 'underline' }])])]),
  doc([paragraph([text('Thanks @[Scott Hanselman] again', [{ type: 'bold' }])])]),
  doc([
    paragraph([
      text('Read the guide', [{ type: 'link', attrs: { href: 'https://example.com/guide' } }]),
    ]),
  ]),
  doc([
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph([text('First')])] },
        { type: 'listItem', content: [paragraph([text('Second')])] },
      ],
    },
  ]),
  doc([
    { type: 'blockquote', content: [paragraph([text('Quoted')])] },
    { type: 'horizontalRule' },
    paragraph([text('After')]),
  ]),
];

describe('exportText', () => {
  it('is byte-identical to exportLinkedInText when unicodeStyling is on', () => {
    for (const fixture of STYLED_FIXTURES) {
      expect(exportText(fixture, { unicodeStyling: true })).toBe(exportLinkedInText(fixture));
    }
  });

  it('emits raw text instead of styled Unicode when unicodeStyling is off', () => {
    const document = doc([
      paragraph([text('Bold', [{ type: 'bold' }]), text(' plain'), text(' italic', [{ type: 'italic' }])]),
    ]);

    expect(exportText(document, { unicodeStyling: true })).toBe(
      `${styleText('Bold', { bold: true })} plain${styleText(' italic', { italic: true })}`,
    );
    expect(exportText(document, { unicodeStyling: false })).toBe('Bold plain italic');
  });

  it('drops heading bold styling when unicodeStyling is off but keeps block structure', () => {
    const document = doc([
      { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
      paragraph([text('Body')]),
    ]);

    expect(exportText(document, { unicodeStyling: false })).toBe('Title\nBody');
  });

  it('hugs a list to adjacent paragraphs with a single newline (no blank lines around bullets)', () => {
    const document = doc([
      paragraph([text('Here is what shipped:')]),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph([text('Faster sync')])] },
          { type: 'listItem', content: [paragraph([text('Dark mode')])] },
        ],
      },
      paragraph([text('More soon.')]),
    ]);

    expect(exportText(document, { unicodeStyling: false })).toBe(
      'Here is what shipped:\n• Faster sync\n• Dark mode\nMore soon.',
    );
  });

  it('preserves author-inserted blank lines (empty paragraphs) as extra newlines', () => {
    const oneBlank = doc([
      paragraph([text('First')]),
      paragraph([]),
      paragraph([text('Second')]),
    ]);
    // Each empty paragraph is exactly one blank line (literal mapping).
    expect(exportText(oneBlank, { unicodeStyling: false })).toBe('First\n\nSecond');

    const twoBlanks = doc([
      paragraph([text('First')]),
      paragraph([]),
      paragraph([]),
      paragraph([text('Second')]),
    ]);
    expect(exportText(twoBlanks, { unicodeStyling: false })).toBe('First\n\n\nSecond');

    // Leading/trailing blank lines are still trimmed away.
    const edged = doc([paragraph([]), paragraph([text('Only')]), paragraph([])]);
    expect(exportText(edged, { unicodeStyling: false })).toBe('Only');
  });

  it('keeps link rendering and mention tokens intact regardless of styling', () => {
    const document = doc([
      paragraph([
        text('Guide', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        text(' for @[Ada Lovelace]'),
      ]),
    ]);

    expect(exportText(document, { unicodeStyling: false })).toBe('Guide (https://example.com) for @[Ada Lovelace]');
  });

  it('renders a full code span as monospace even around @handles and URLs', () => {
    // Repro of the bug where the @handle and URL portions of code-marked text
    // stayed plain ASCII, leaving the preview half-monospace.
    const handleDoc = doc([
      paragraph([text('/plugin add ai-native-dev-skills@webmaxru-ai-native-dev', [{ type: 'code' }])]),
    ]);
    const urlDoc = doc([
      paragraph([
        text('<link rel="ai-catalog" href="https://webmaxru.github.io/.well-known/ai-catalog.json">', [
          { type: 'code' },
        ]),
      ]),
    ]);

    // The whole span is code, so no raw ASCII letters/digits should leak through.
    expect(exportText(handleDoc, { unicodeStyling: true })).not.toMatch(/[A-Za-z0-9]/);
    expect(exportText(urlDoc, { unicodeStyling: true })).not.toMatch(/[A-Za-z0-9]/);
  });
});
