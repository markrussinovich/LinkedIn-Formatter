import { generateJSON } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import type { EditorNode } from './exportText';
import { looksLikeMarkdown, markdownToTipTap } from './markdownToTipTap';
import { MentionHighlight } from './mentionHighlight';
import { sanitizePastedHTML } from './pastedHtml';

// Shared TipTap configuration used by both the master editor (EditorShell) and
// the per-platform pane editors (PaneEditor), so paste handling and formatting
// behave identically everywhere.
export const editorExtensions = [
  StarterKit.configure({
    codeBlock: false,
    heading: {
      levels: [2, 3],
    },
    // Configured explicitly below instead of using the kit's defaults.
    link: false,
    underline: false,
  }),
  Underline,
  Link.configure({
    autolink: true,
    defaultProtocol: 'https',
    openOnClick: true,
    HTMLAttributes: {
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
      title: 'Click to open. Use the Link toolbar button to edit.',
    },
  }),
  Placeholder.configure({
    placeholder: 'Paste or write your post draft...',
  }),
  CharacterCount,
  MentionHighlight,
];

// Sanitizes pasted content before it reaches the editor. Markdown-looking plain
// text becomes formatted content; HTML (e.g. Word/Office) is run through the
// sanitizer to strip empty paragraphs and Office noise. Runs in the capture
// phase and stops the event so ProseMirror's default paste does not also fire.
export function handleEditorPaste(editor: Editor, event: ClipboardEvent) {
  const plainText = event.clipboardData?.getData('text/plain') ?? '';
  const html = event.clipboardData?.getData('text/html') ?? '';

  if (plainText && looksLikeMarkdown(plainText)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    editor.commands.insertContent(markdownToTipTap(plainText).content ?? []);
    return;
  }

  if (html.trim()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    // Parse to nodes via generateJSON rather than passing the HTML string to
    // insertContent: insertContent treats whitespace between block tags as
    // empty paragraphs, reintroducing the blank lines we just stripped.
    const document = generateJSON(sanitizePastedHTML(html, plainText), editorExtensions) as EditorNode;
    editor.commands.insertContent(document.content ?? []);
  }
}
