import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTextSource, type Source } from '../lib/ai/sources';
import { SourcesPanel } from './SourcesPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function noop() {}

describe('SourcesPanel', () => {
  it('opens a read-only preview for file sources on click', () => {
    const source: Source = {
      id: 'd1',
      kind: 'doc',
      title: 'notes.md',
      text: 'Ship the multi-platform editor on Tuesday.',
      charCount: 41,
      status: 'ready',
    };

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={noop} onRemoveSource={noop} />,
    );

    // No preview until the row is clicked.
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByText('notes.md'));

    expect(screen.getByRole('dialog')).toHaveTextContent('Ship the multi-platform editor on Tuesday.');
    expect(screen.queryByLabelText('Source text')).toBeNull();
  });

  it('opens a pasted text source in the inline editor and saves edits', () => {
    const source: Source = makeTextSource('Launch notes', 'Old text.');
    const onUpdateSource = vi.fn();

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={onUpdateSource} onRemoveSource={noop} />,
    );

    expect(screen.queryByLabelText('Source text')).toBeNull();

    fireEvent.click(screen.getByText('Launch notes'));

    // Editing happens inline in the same form used to add the source.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Source title')).toHaveValue('Launch notes');
    expect(screen.getByLabelText('Source text')).toHaveValue('Old text.');

    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'New text.' } });
    fireEvent.click(screen.getByRole('button', { name: /save source/i }));

    expect(onUpdateSource).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ id: source.id, title: 'Launch notes', text: 'New text.', charCount: 9 }),
    );
    // Saving closes the editor.
    expect(screen.queryByLabelText('Source text')).toBeNull();
  });

  it('closes the inline editor without saving on cancel', () => {
    const source: Source = makeTextSource('Launch notes', 'Old text.');
    const onUpdateSource = vi.fn();

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={onUpdateSource} onRemoveSource={noop} />,
    );

    fireEvent.click(screen.getByText('Launch notes'));
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'New text.' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onUpdateSource).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Source text')).toBeNull();
  });

  it('leaves the title field blank for an auto-titled source', () => {
    const source: Source = { ...makeTextSource('', 'Body'), title: 'AI generated title', needsTitle: true };

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={noop} onRemoveSource={noop} />,
    );

    fireEvent.click(screen.getByText('AI generated title'));

    expect(screen.getByLabelText('Source title')).toHaveValue('');
  });

  it('adds a pasted source with the same form', () => {
    const onAddSource = vi.fn();

    render(<SourcesPanel sources={[]} onAddSource={onAddSource} onUpdateSource={noop} onRemoveSource={noop} />);

    fireEvent.click(screen.getByRole('button', { name: /paste text/i }));
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: '  Reference body  ' } });
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));

    expect(onAddSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: 'Reference body', needsTitle: true }),
    );
    expect(screen.queryByLabelText('Source text')).toBeNull();
  });

  it('removes a source without opening the editor', () => {
    const source: Source = makeTextSource('Launch notes', 'Body');
    const onRemoveSource = vi.fn();

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={noop} onRemoveSource={onRemoveSource} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /remove launch notes/i }));

    expect(onRemoveSource).toHaveBeenCalledWith(source.id);
    expect(screen.queryByLabelText('Source text')).toBeNull();
  });

  it('exposes a link to the original page for URL sources', () => {
    const source: Source = {
      id: 'u1',
      kind: 'url',
      title: 'Example article',
      text: 'Body text',
      charCount: 9,
      status: 'ready',
      url: 'https://example.test/post',
    };

    render(
      <SourcesPanel sources={[source]} onAddSource={noop} onUpdateSource={noop} onRemoveSource={noop} />,
    );

    fireEvent.click(screen.getByText('Example article'));

    const link = screen.getByRole('link', { name: /open original/i });
    expect(link).toHaveAttribute('href', 'https://example.test/post');
  });
});
