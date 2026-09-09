import { ExternalLink, X } from 'lucide-react';

import { useEscape } from '../lib/useEscape';
import type { Source } from '../lib/ai/sources';

interface SourcePreviewProps {
  source: Source;
  onClose: () => void;
}

const KIND_LABEL = { doc: 'File', url: 'Link', text: 'Pasted text' } as const;

// Read-only viewer for a file or page source's extracted text, opened by
// clicking it in the SourcesPanel. Uploaded files keep only their extracted text
// (not the original binary), so this shows exactly what the AI sees. Pasted text
// is edited inline in the panel instead. URL sources also expose a link out to
// the original page.
export function SourcePreview({ source, onClose }: SourcePreviewProps) {
  useEscape(onClose);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="source-preview-title" onMouseDown={onClose}>
      <div className="modal-card source-preview" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 id="source-preview-title">{source.title}</h2>
          <button type="button" className="card-icon-button" aria-label="Close preview" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <p className="modal-hint source-preview-meta">
          {KIND_LABEL[source.kind]}
          {source.status === 'ready' ? ` · ${source.charCount.toLocaleString()} chars` : ' · needs text'}
          {source.url ? (
            <>
              {' · '}
              <a className="source-preview-link" href={source.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" size={13} /> Open original
              </a>
            </>
          ) : null}
        </p>

        {source.text.trim() ? (
          <pre className="source-preview-body">{source.text}</pre>
        ) : (
          <p className="modal-hint">No text is available for this source yet.</p>
        )}
      </div>
    </div>
  );
}
