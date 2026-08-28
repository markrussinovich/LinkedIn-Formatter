import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Settings, Sparkles } from 'lucide-react';

import { SourcesPanel } from './SourcesPanel';
import type { Source } from '../lib/ai/sources';
import { appendPrompt, loadPromptHistory, savePromptHistory } from '../lib/ai/promptHistory';

interface AiAssistProps {
  ready: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (instruction: string) => void;
  onOpenSettings: () => void;
  // Whether the master draft has content — quick "rewrite" prompts need something
  // to act on, so they only show when there's a draft.
  hasDraft: boolean;
  // The configured style guidance, if any — enables the "apply style" suggestion.
  stylePrompt: string;
  // Reference sources live inside the AI area.
  sources: Source[];
  onAddSource: (source: Source) => void;
  onUpdateSource: (id: string, source: Source) => void;
  onRemoveSource: (id: string) => void;
}

interface Suggestion {
  label: string;
  prompt: string;
}

// Styles that affect where text wraps, copied onto the measuring mirror so it
// lays out identically to the textarea.
const MIRROR_STYLE_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'wordBreak',
  'overflowWrap',
  'tabSize',
] as const;

interface CaretLineInfo {
  isFirstLine: boolean;
  isLastLine: boolean;
}

// Which *visual* line the caret sits on — soft-wrapped lines count too, so a long
// prompt without newlines still lets ↑/↓ move within it. Measured by mirroring the
// textarea's text into an off-screen div and reading a zero-width marker's offset.
function getCaretLineInfo(el: HTMLTextAreaElement): CaretLineInfo {
  const value = el.value;
  const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');

  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop];
  }

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = style.overflowWrap === 'normal' ? 'break-word' : style.overflowWrap;
  mirror.style.boxSizing = 'content-box';
  mirror.style.height = 'auto';
  // Match the text-holding width of the textarea (client width minus padding).
  const contentWidth =
    el.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  mirror.style.width = `${Math.max(contentWidth, 0)}px`;

  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(document.createTextNode(value.slice(0, caret)));
  mirror.appendChild(marker);
  // A trailing zero-width space keeps a final newline from collapsing.
  mirror.appendChild(document.createTextNode(`${value.slice(caret)}\u200b`));
  document.body.appendChild(mirror);

  const parsedLineHeight = parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight)
    ? parsedLineHeight
    : parseFloat(style.fontSize) * 1.2;
  const caretTop = marker.offsetTop;
  const contentHeight = mirror.offsetHeight;

  mirror.remove();

  if (!Number.isFinite(lineHeight) || lineHeight <= 0 || contentHeight <= 0) {
    // Measurement unavailable (e.g. detached/hidden): fall back to newline checks.
    return {
      isFirstLine: value.lastIndexOf('\n', caret - 1) === -1,
      isLastLine: value.indexOf('\n', caret) === -1,
    };
  }

  return {
    isFirstLine: caretTop < lineHeight / 2,
    isLastLine: caretTop + lineHeight * 1.5 > contentHeight,
  };
}

export function AiAssist({ ready, busy, error, onSubmit, onOpenSettings, hasDraft, stylePrompt, sources, onAddSource, onUpdateSource, onRemoveSource }: AiAssistProps) {
  const [instruction, setInstruction] = useState('');
  // Seeded from storage so the ↑/↓ recall survives reloads, and persisted on change.
  const [history, setHistory] = useState<string[]>(loadPromptHistory);
  // -1 means "live input"; otherwise an index into history.
  const [historyIndex, setHistoryIndex] = useState(-1);
  const prevBusy = useRef(busy);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Caret position to apply after a history recall re-renders the textarea.
  const pendingCaretRef = useRef<number | null>(null);

  // Grow the box to fit its content (typed or recalled from history), capped by a
  // max-height in CSS beyond which it scrolls. scrollHeight excludes the border,
  // and box-sizing is border-box, so add the border back — otherwise the content
  // is ~2px too tall for the height we set and a scrollbar appears on one line.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }

    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const maxHeight = parseFloat(style.maxHeight);
    const fullHeight = el.scrollHeight + border;
    const capped = Number.isFinite(maxHeight) ? Math.min(fullHeight, maxHeight) : fullHeight;

    el.style.height = `${capped}px`;
    // Only show a scrollbar once the content actually exceeds the max height.
    el.style.overflowY = Number.isFinite(maxHeight) && fullHeight > maxHeight ? 'auto' : 'hidden';

    if (pendingCaretRef.current !== null) {
      const caret = Math.min(pendingCaretRef.current, el.value.length);
      el.setSelectionRange(caret, caret);
      pendingCaretRef.current = null;
    }
  }, [instruction]);

  useEffect(() => {
    savePromptHistory(history);
  }, [history]);

  // Clear the box once a generation finishes (busy goes true -> false).
  useEffect(() => {
    if (prevBusy.current && !busy) {
      setInstruction('');
      setHistoryIndex(-1);
    }
    prevBusy.current = busy;
  }, [busy]);

  const suggestions: Suggestion[] = [
    { label: 'Rewrite for clarity', prompt: 'Rewrite this post for clarity.' },
    { label: 'Make more concise', prompt: 'Make this post more concise.' },
  ];
  if (stylePrompt.trim()) {
    suggestions.push({ label: 'Apply style', prompt: 'Rewrite this post to apply my style guidance.' });
  }

  function submitPrompt(text: string) {
    const trimmed = text.trim();

    if (!trimmed || busy) {
      return;
    }

    setHistory((prev) => appendPrompt(prev, trimmed));
    setHistoryIndex(-1);
    onSubmit(trimmed);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    submitPrompt(instruction);
  }

  function recallPrompt(index: number, value: string) {
    setHistoryIndex(index);
    setInstruction(value);
    // Park the caret at the end so the next ↑/↓ keeps walking history instead of
    // moving within the recalled multi-line prompt.
    pendingCaretRef.current = value.length;
  }

  // Enter submits; Shift+Enter inserts a newline. Up/Down walk previously
  // submitted prompts (most recent first), but only when the caret is already on
  // the first/last line — otherwise they move within a multi-line prompt.
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitPrompt(instruction);
      return;
    }

    if (event.key === 'ArrowUp') {
      if (history.length === 0 || !getCaretLineInfo(event.currentTarget).isFirstLine) {
        return;
      }
      event.preventDefault();
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      recallPrompt(next, history[next]);
    } else if (event.key === 'ArrowDown') {
      if (historyIndex === -1 || !getCaretLineInfo(event.currentTarget).isLastLine) {
        return;
      }
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        recallPrompt(-1, '');
      } else {
        recallPrompt(next, history[next]);
      }
    }
  }

  if (!ready) {
    return (
      <div className="ai-assist is-disabled">
        <Sparkles aria-hidden="true" size={16} />
        <span>Connect an AI endpoint to write and auto-fit posts.</span>
        <button type="button" className="ai-assist-link" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={14} /> Set up
        </button>
      </div>
    );
  }

  return (
    <div className="ai-assist">
      <form className="ai-assist-form" onSubmit={handleSubmit}>
        <div className="ai-assist-row">
          <Sparkles aria-hidden="true" size={16} className="ai-assist-icon" />
          <textarea
            ref={textareaRef}
            rows={1}
            value={instruction}
            placeholder="Ask AI to write or improve this post… (↑/↓ for history)"
            aria-label="AI instruction"
            disabled={busy}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type="submit" className="primary-action ai-assist-submit" disabled={busy || !instruction.trim()}>
            {busy ? 'Working…' : 'Generate'}
          </button>
        </div>
        {hasDraft ? (
          <div className="ai-suggestions">
            {suggestions.map((suggestion) => (
              <button key={suggestion.label} type="button" className="ai-suggestion" disabled={busy} onClick={() => submitPrompt(suggestion.prompt)}>
                {suggestion.label}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="ai-assist-error" role="status">
            <AlertTriangle aria-hidden="true" size={14} /> {error}
          </p>
        ) : null}
      </form>
      <SourcesPanel
        sources={sources}
        onAddSource={onAddSource}
        onUpdateSource={onUpdateSource}
        onRemoveSource={onRemoveSource}
      />
    </div>
  );
}
