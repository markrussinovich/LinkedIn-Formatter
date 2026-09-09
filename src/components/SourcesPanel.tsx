import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, FileText, Globe, Loader, Plus, Type, X } from 'lucide-react';

import { getAcceptedDocumentTypes } from '../lib/importDocument';
import {
  makeDocumentSource,
  makeTextSource,
  withEditedText,
  withPastedText,
  type Source,
} from '../lib/ai/sources';
import { SourcePreview } from './SourcePreview';

interface SourcesPanelProps {
  sources: Source[];
  onAddSource: (source: Source) => void;
  onUpdateSource: (id: string, source: Source) => void;
  onRemoveSource: (id: string) => void;
}

type AddMode = 'text' | null;

const KIND_ICON = { doc: FileText, url: Globe, text: Type } as const;

export function SourcesPanel({ sources, onAddSource, onUpdateSource, onRemoveSource }: SourcesPanelProps) {
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Which pasted-text source is open in the inline editor. Only one text editor
  // is open at a time (adding closes editing and vice versa).
  const [editingId, setEditingId] = useState<string | null>(null);

  // Resolved from props (not stored) so an open viewer follows updates such as
  // an AI-generated title arriving, and closes if the source is removed.
  const previewSource = sources.find((source) => source.id === previewId) ?? null;

  function handleAddText(title: string, text: string) {
    onAddSource(makeTextSource(title, text));
    setAddMode(null);
  }

  function handleOpen(source: Source) {
    // Pasted text is the user's own content, so it opens for editing inline in
    // the same form that created it. Files and pages open in the read-only viewer.
    if (source.kind === 'text') {
      setAddMode(null);
      setEditingId((current) => (current === source.id ? null : source.id));
      return;
    }

    setPreviewId(source.id);
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      onAddSource(await makeDocumentSource(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="sources-panel">
      <summary>
        Reference sources for AI{sources.length ? ` (${sources.length})` : ''}
      </summary>
      <p className="sources-hint">Give the AI material to use as its context for its generation.</p>

      <div className="sources-actions">
        <label className="secondary-action sources-file" title="Add a .txt, .md, or .docx file">
          <FileText aria-hidden="true" size={14} /> Add file
          <input type="file" accept={getAcceptedDocumentTypes()} disabled={busy} onChange={handleFile} />
        </label>
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setAddMode((mode) => (mode === 'text' ? null : 'text'));
          }}
        >
          <Type aria-hidden="true" size={14} /> Paste text
        </button>
        {busy ? <Loader aria-hidden="true" size={14} className="spin sources-busy" /> : null}
      </div>

      {addMode === 'text' ? (
        <SourceTextForm submitLabel="Add source" onSubmit={handleAddText} onCancel={() => setAddMode(null)} />
      ) : null}

      {error ? (
        <p className="sources-error" role="status">
          <AlertTriangle aria-hidden="true" size={14} /> {error}
        </p>
      ) : null}

      {sources.length ? (
        <ul className="sources-list">
          {sources.map((source) => (
            <SourceItem
              key={source.id}
              source={source}
              editing={editingId === source.id}
              onUpdate={onUpdateSource}
              onRemove={onRemoveSource}
              onOpen={handleOpen}
              onCloseEdit={() => setEditingId(null)}
            />
          ))}
        </ul>
      ) : null}

      {previewSource ? <SourcePreview source={previewSource} onClose={() => setPreviewId(null)} /> : null}
    </details>
  );
}

interface SourceItemProps {
  source: Source;
  editing: boolean;
  onUpdate: (id: string, source: Source) => void;
  onRemove: (id: string) => void;
  onOpen: (source: Source) => void;
  onCloseEdit: () => void;
}

function SourceItem({ source, editing, onUpdate, onRemove, onOpen, onCloseEdit }: SourceItemProps) {
  const [paste, setPaste] = useState('');
  const needsText = source.status === 'needs-text';

  return (
    <li className={`source-item${needsText ? ' is-pending' : ''}`}>
      <div
        className="source-item-head is-openable"
        role="button"
        tabIndex={0}
        aria-expanded={source.kind === 'text' ? editing : undefined}
        title={source.kind === 'text' ? 'Click to edit' : 'Click to open'}
        onClick={() => onOpen(source)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(source);
          }
        }}
      >
        <SourceIcon source={source} />
        <span className="source-title" title={source.url ?? source.title}>{source.title}</span>
        <span className="source-meta">{source.status === 'ready' ? `${source.charCount.toLocaleString()} chars` : 'needs text'}</span>
        <button
          type="button"
          className="source-remove"
          aria-label={`Remove ${source.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(source.id);
          }}
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      {editing ? (
        <SourceTextForm
          // A title the AI generated stays blank in the field so leaving it
          // alone keeps the title automatic.
          initialTitle={source.needsTitle ? '' : source.title}
          initialText={source.text}
          submitLabel="Save source"
          submitIcon={<Check aria-hidden="true" size={14} />}
          onSubmit={(title, text) => {
            onUpdate(source.id, withEditedText(source, title, text));
            onCloseEdit();
          }}
          onCancel={onCloseEdit}
        />
      ) : null}
      {needsText ? (
        <div className="source-fallback">
          <p className="source-fallback-note">
            <AlertTriangle aria-hidden="true" size={13} /> Preview is available, but this site blocks browser text import. Paste the article text here.
          </p>
          <textarea
            value={paste}
            placeholder="Paste the page text…"
            aria-label={`Pasted text for ${source.title}`}
            rows={3}
            onChange={(event) => setPaste(event.target.value)}
          />
          <button type="button" className="secondary-action" disabled={!paste.trim()} onClick={() => onUpdate(source.id, withPastedText(source, paste))}>
            <Plus aria-hidden="true" size={14} /> Use this text
          </button>
        </div>
      ) : null}
    </li>
  );
}

// The one text editor used both to add a pasted source and to edit an existing
// one, so both paths look and behave identically.
interface SourceTextFormProps {
  initialTitle?: string;
  initialText?: string;
  submitLabel: string;
  submitIcon?: ReactNode;
  onSubmit: (title: string, text: string) => void;
  onCancel: () => void;
}

function SourceTextForm({
  initialTitle = '',
  initialText = '',
  submitLabel,
  submitIcon = <Plus aria-hidden="true" size={14} />,
  onSubmit,
  onCancel,
}: SourceTextFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);

  function submit() {
    if (text.trim()) {
      onSubmit(title, text);
    }
  }

  return (
    <div
      className="sources-text-row"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        type="text"
        value={title}
        placeholder="Title (optional)"
        aria-label="Source title"
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        value={text}
        placeholder="Paste reference text…"
        aria-label="Source text"
        rows={6}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="sources-text-actions">
        <button type="button" className="secondary-action" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary-action" disabled={!text.trim()} onClick={submit}>
          {submitIcon} {submitLabel}
        </button>
      </div>
    </div>
  );
}

// URL sources show the site's favicon; docs/text use a lucide glyph. The favicon
// falls back to the globe icon if it can't load.
function SourceIcon({ source }: { source: Source }) {
  const [failed, setFailed] = useState(false);

  if (source.kind === 'url' && source.url && !failed) {
    let host = '';
    try {
      host = new URL(source.url).hostname;
    } catch {
      host = '';
    }

    if (host) {
      return (
        <img
          src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
          alt=""
          className="source-favicon"
          width={14}
          height={14}
          onError={() => setFailed(true)}
        />
      );
    }
  }

  const Icon = source.kind === 'url' ? Globe : KIND_ICON[source.kind];
  return <Icon aria-hidden="true" size={14} className="source-icon" />;
}
