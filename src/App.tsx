import { useEffect, useMemo, useRef, useState } from 'react';
import { HelpCircle, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from 'lucide-react';

import { AiAssist } from './components/AiAssist';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DraftHistoryPanel } from './components/DraftHistoryPanel';
import { EditorShell } from './components/EditorShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HelpModal } from './components/HelpModal';
import { ImageAttachmentControl } from './components/ImageAttachmentControl';
import { InstallButton } from './components/InstallButton';
import { LlmSettings } from './components/LlmSettings';
import { PolypostMark } from './components/PolypostMark';
import { UpdatePrompt } from './components/UpdatePrompt';
import { PlatformRail } from './components/PlatformRail';
import { PlatformToggleChips } from './components/PlatformToggleChips';
import { loadTheme, saveTheme, type Theme } from './lib/theme';
import { selectAutofit } from './lib/ai/autofit';
import { isLlmReady, loadLlmConfig, saveLlmConfig, type LlmConfig } from './lib/ai/config';
import { docToMarkdown, docToPlainText } from './lib/ai/docText';
import { buildSourcesBlock, cleanSourceTitle, loadSources, saveSources, MAX_TITLE_CHARS, type Source } from './lib/ai/sources';
import { markdownToTipTap } from './lib/markdownToTipTap';
import { fetchLinkPreview, lastUrlInText, shouldRefreshLinkPreview } from './lib/linkPreview';
import { restoreDraftAttachments, revokeAttachment, serializeAttachmentsForDraft, type Attachment, type LinkPreview } from './lib/media';
import { clearActiveAttachment, loadActiveAttachment, putActiveAttachment } from './lib/attachmentStore';
import { generateFit } from './lib/ai/fit';
import { generateText } from './lib/ai/llmClient';
import { buildAuthorRequest, buildSourceTitleRequest } from './lib/ai/prompts';
import { APP_NAME } from './lib/constants';
import type { EditorNode } from './lib/exportText';
import {
  DEFAULT_ENABLED_PLATFORMS,
  PLATFORMS,
  PLATFORMS_BY_ID,
  renderForPlatform,
} from './lib/platforms';
import type { PlatformId, PlatformRender } from './lib/platforms/types';
import {
  deleteDraftSnapshot,
  loadDraftHistory,
  loadWorkspace,
  saveDraftSnapshot,
  saveWorkspace,
  type DraftSnapshot,
} from './lib/storage';
import {
  applyMasterEdit,
  applyPaneEdit,
  dormantPlatforms,
  resyncPlatform,
  togglePlatform,
  type Workspace,
} from './lib/workspace';

const AUTOFIT_IDLE_MS = 3000;
// Titles are one short line, but reasoning-class models spend tokens thinking
// before they answer, so the cap has to leave room for that.
const TITLE_MAX_TOKENS = 256;
// Start blank rather than with sample content; the editor shows its placeholder.
const EMPTY_DOCUMENT: EditorNode = { type: 'doc', content: [{ type: 'paragraph' }] };

// Destructive actions that replace or discard the current draft ask first via
// an integrated dialog (never a browser confirm popup).
type ConfirmAction =
  | { kind: 'resync'; id: PlatformId }
  | { kind: 'reset' }
  | { kind: 'replace'; document: EditorNode }
  | { kind: 'restore'; draft: DraftSnapshot };

function App() {
  const [initialLoad] = useState(loadWorkspace);
  const [workspace, setWorkspace] = useState<Workspace>(() => ({
    master: initialLoad.workspace?.master ?? EMPTY_DOCUMENT,
    overrides: initialLoad.workspace?.overrides ?? {},
    enabledPlatforms: initialLoad.workspace?.enabledPlatforms ?? DEFAULT_ENABLED_PLATFORMS,
  }));
  const [editorVersion, setEditorVersion] = useState(0);
  // Bumped on every master content change; keys non-forked pane editors so they
  // reseed from the updated master.
  const [masterVersion, setMasterVersion] = useState(0);
  const [activePaneEditor, setActivePaneEditor] = useState<PlatformId | null>(null);
  const [draftHistory, setDraftHistory] = useState<DraftSnapshot[]>(loadDraftHistory);
  const [storageNotice, setStorageNotice] = useState<string | null>(() => initialLoad.error ?? null);

  // AI state. aiVersions holds session-only LLM-fitted versions (not persisted);
  // they take effect only for platforms the user hasn't manually forked.
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(loadLlmConfig);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  // Collapse the editor column to give the preview rail the full width (2 columns).
  // Only offered when more than 2 platforms are enabled.
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [aiVersions, setAiVersions] = useState<Map<PlatformId, EditorNode>>(() => new Map());
  const [generating, setGenerating] = useState<Set<PlatformId>>(() => new Set());
  const [aiError, setAiError] = useState<string | null>(null);
  const [authorBusy, setAuthorBusy] = useState(false);
  const [authorError, setAuthorError] = useState<string | null>(null);

  // Reference material handed to the AI as background (persisted).
  const [sources, setSources] = useState<Source[]>(loadSources);
  const [imageAttachment, setImageAttachment] = useState<Attachment | null>(null);
  const [linkPreviews, setLinkPreviews] = useState<Map<string, LinkPreview>>(() => new Map());
  const [debouncedPlatformPreviewUrls, setDebouncedPlatformPreviewUrls] = useState<string[]>([]);

  const aiReady = isLlmReady(llmConfig);

  const aiVersionsRef = useRef(aiVersions);
  useEffect(() => {
    aiVersionsRef.current = aiVersions;
  }, [aiVersions]);
  // Latest workspace for async completions: AI results are applied only if the
  // content they were generated from is still what is on screen.
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  const fitAbortRef = useRef<AbortController | null>(null);
  // An explicit sparkle-click fit in flight. The idle auto-adapt pass must not
  // abort it (the user asked for it) — it works around it instead.
  const manualFitRef = useRef<{ id: PlatformId; controller: AbortController } | null>(null);
  const authorAbortRef = useRef<AbortController | null>(null);
  // What each platform's current AI version was generated from (master +
  // style), so an idle pause after an unrelated change (a fork edit, a chip
  // toggle) doesn't re-generate cards whose input hasn't changed.
  const adaptedKeyRef = useRef<Map<PlatformId, string>>(new Map());
  // Link preview states whose fetch has already been kicked off, so failed or
  // low-value metadata can retry once without looping forever.
  const startedPreviewKeys = useRef<Set<string>>(new Set());

  // Apply + persist the color theme.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    saveTheme(theme);
  }, [theme]);

  // Persist the whole workspace whenever it changes (debounce-free, as the
  // single-document autosave was). saveWorkspace is idempotent.
  useEffect(() => {
    const result = saveWorkspace(workspace);

    if (!result.ok) {
      setStorageNotice(result.message);
    }
  }, [workspace]);

  // Persist AI sources.
  useEffect(() => {
    saveSources(sources);
  }, [sources]);

  // Restore a persisted image/video attachment so it survives reload/restart
  // (PWA). Yields to any attachment the user adds before the load resolves.
  useEffect(() => {
    let cancelled = false;

    void loadActiveAttachment().then((restored) => {
      if (!restored) {
        return;
      }

      if (cancelled) {
        revokeAttachment(restored);
        return;
      }

      setImageAttachment((prev) => {
        if (prev) {
          revokeAttachment(restored);
          return prev;
        }

        return restored;
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // One render + seed document per enabled platform. The document each platform
  // renders/edits from: a user fork wins, then an AI-fitted version, then master.
  const { platformRenders, platformDocuments } = useMemo(() => {
    const renders = new Map<PlatformId, PlatformRender>();
    const documents = new Map<PlatformId, EditorNode>();

    for (const id of workspace.enabledPlatforms) {
      const spec = PLATFORMS_BY_ID[id];

      if (spec) {
        const doc = workspace.overrides[id] ?? aiVersions.get(id) ?? workspace.master;
        documents.set(id, doc);
        renders.set(id, renderForPlatform(doc, spec));
      }
    }

    return { platformRenders: renders, platformDocuments: documents };
  }, [workspace, aiVersions]);

  const platformPreviewUrls = useMemo(() => {
    if (imageAttachment) {
      return [];
    }

    const urls = new Set<string>();

    for (const id of workspace.enabledPlatforms) {
      const spec = PLATFORMS_BY_ID[id];
      const render = platformRenders.get(id);
      const url = spec?.linkPreview && render ? lastUrlInText(render.text) : undefined;

      if (url) {
        urls.add(url);
      }
    }

    return [...urls];
  }, [imageAttachment, platformRenders, workspace.enabledPlatforms]);

  useEffect(() => {
    if (imageAttachment) {
      setDebouncedPlatformPreviewUrls([]);
      return;
    }

    const handle = window.setTimeout(() => {
      setDebouncedPlatformPreviewUrls(platformPreviewUrls);
    }, AUTOFIT_IDLE_MS);

    return () => window.clearTimeout(handle);
  }, [imageAttachment, platformPreviewUrls]);

  // Fetch link-unfurl previews for the last URL shown in each platform card that
  // supports URL previews, after the same idle delay used by autofit.
  useEffect(() => {
    const pending = debouncedPlatformPreviewUrls.filter((url) => {
      const preview = linkPreviews.get(url);
      return shouldRefreshLinkPreview(preview, url) && !startedPreviewKeys.current.has(previewFetchKey(url, preview));
    });

    if (pending.length === 0) {
      return;
    }

    for (const url of pending) {
      const preview = linkPreviews.get(url);
      startedPreviewKeys.current.add(previewFetchKey(url, preview));
      setLinkPreviews((prev) => new Map(prev).set(url, { status: 'loading' }));

      void fetchLinkPreview(url).then((nextPreview) => {
        startedPreviewKeys.current.add(previewFetchKey(url, nextPreview));
        setLinkPreviews((prev) => {
          if (prev.get(url)?.status === 'manual') {
            return prev;
          }

          return new Map(prev).set(url, nextPreview);
        });
      });
    }
  }, [debouncedPlatformPreviewUrls, linkPreviews]);

  const enabledSpecs = PLATFORMS.filter((spec) => workspace.enabledPlatforms.includes(spec.id));
  const forkedIds = useMemo(() => new Set(Object.keys(workspace.overrides) as PlatformId[]), [workspace.overrides]);
  const aiAdaptedIds = useMemo(() => {
    const ids = new Set<PlatformId>();
    for (const id of aiVersions.keys()) {
      if (!(id in workspace.overrides)) {
        ids.add(id);
      }
    }
    return ids;
  }, [aiVersions, workspace.overrides]);
  const dormant = dormantPlatforms(workspace);
  const isEditorCollapsed = editorCollapsed;

  // Auto-adapt: after a typing pause, rewrite enabled, non-forked platforms for
  // style guidance and/or over-limit auto-fit, then drop stale AI versions.
  useEffect(() => {
    if (!aiReady || !shouldAutoAdapt(llmConfig)) {
      return;
    }

    const handle = window.setTimeout(() => {
      void runAutoAdapt(llmConfig);
    }, AUTOFIT_IDLE_MS);

    return () => window.clearTimeout(handle);
    // runAutoAdapt reads the latest workspace via this effect's closure; it re-runs
    // (resetting the timer) on every master/platform/override/config change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.master, workspace.enabledPlatforms, workspace.overrides, llmConfig]);

  async function runAutoAdapt(config: LlmConfig) {
    if (!isLlmReady(config) || !shouldAutoAdapt(config)) {
      return;
    }

    fitAbortRef.current?.abort();
    const controller = new AbortController();
    fitAbortRef.current = controller;

    // A manual fit the user explicitly requested keeps running; this pass just
    // leaves its platform (and its badge) alone.
    const manualId = manualFitRef.current?.id ?? null;

    const selection = selectAutoAdapt(config, workspace.master, workspace.enabledPlatforms, workspace.overrides, aiVersionsRef.current);

    if (selection.toClear.length > 0) {
      setAiVersions((prev) => {
        const next = new Map(prev);
        selection.toClear.forEach((id) => next.delete(id));
        return next;
      });
    }

    const masterText = docToPlainText(workspace.master);
    const masterMarkdown = docToMarkdown(workspace.master);
    const adaptKey = makeAdaptKey(config.stylePrompt, masterMarkdown);
    const toFit = selection.toFit.filter(
      (id) => id !== manualId && !(adaptedKeyRef.current.get(id) === adaptKey && aiVersionsRef.current.has(id)),
    );

    if (toFit.length === 0) {
      // The abort above orphaned any badges the superseded run was showing
      // (except a live manual fit's, which still owns its own).
      setGenerating((prev) => {
        const next = new Set(manualId && prev.has(manualId) ? [manualId] : []);
        return next.size === prev.size ? prev : next;
      });
      return;
    }

    // Replace rather than merge: aborting the previous run orphaned its badges.
    setGenerating(new Set(manualId ? [manualId, ...toFit] : toFit));
    setAiError(null);

    await Promise.all(
      toFit.map(async (id) => {
        const spec = PLATFORMS_BY_ID[id];

        try {
          // generateFit re-checks the length and regenerates automatically; we
          // always show its best result without surfacing an over-limit notice.
          // Styling-capable platforms get the Markdown master so the author's
          // bold/italic/lists survive; plain-text platforms can't show them.
          const result = await generateFit({ config, spec, masterText: spec.allowUnicodeStyling ? masterMarkdown : masterText, style: config.stylePrompt, signal: controller.signal });

          if (!controller.signal.aborted) {
            adaptedKeyRef.current.set(id, adaptKey);
            setAiVersions((prev) => new Map(prev).set(id, result.doc));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setAiError(`${spec.label}: ${error instanceof Error ? error.message : 'AI request failed.'}`);
          }
        } finally {
          // An aborted run's badges belong to whichever run superseded it.
          if (!controller.signal.aborted) {
            setGenerating((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        }
      }),
    );
  }

  async function handleFit(id: PlatformId) {
    const spec = PLATFORMS_BY_ID[id];

    if (!aiReady || !spec) {
      return;
    }

    // A user-requested fit supersedes whatever was in flight — the idle
    // auto-adapt pass and any earlier manual fit — and takes over the badges.
    fitAbortRef.current?.abort();
    manualFitRef.current?.controller.abort();
    const controller = new AbortController();
    manualFitRef.current = { id, controller };

    const masterAtRequest = workspace.master;
    const overrideAtRequest = workspace.overrides[id];

    setGenerating(new Set([id]));
    setAiError(null);

    try {
      const masterMarkdown = docToMarkdown(workspace.master);
      const masterText = spec.allowUnicodeStyling ? masterMarkdown : docToPlainText(workspace.master);
      const result = await generateFit({ config: llmConfig, spec, masterText, style: llmConfig.stylePrompt, signal: controller.signal });

      if (controller.signal.aborted) {
        return;
      }

      // Drop the result if the user edited the master or this platform's pane
      // while the request ran — applying it would discard their newer work.
      const current = workspaceRef.current;

      if (current.master !== masterAtRequest || current.overrides[id] !== overrideAtRequest) {
        return;
      }

      // Record what this version was generated from so the idle pass doesn't
      // immediately regenerate (and visibly replace) the accepted result.
      adaptedKeyRef.current.set(id, makeAdaptKey(llmConfig.stylePrompt, masterMarkdown));
      // The sparkle only appears on a forked (edited) card, so applying the AI
      // version means discarding the manual edit: drop the override so the AI
      // version (which would otherwise be hidden behind it) becomes visible.
      setWorkspace((prev) => resyncPlatform(prev, id));
      setAiVersions((prev) => new Map(prev).set(id, result.doc));
    } catch (error) {
      if (!controller.signal.aborted) {
        setAiError(`${spec.label}: ${error instanceof Error ? error.message : 'AI request failed.'}`);
      }
    } finally {
      if (manualFitRef.current?.controller === controller) {
        manualFitRef.current = null;
      }

      if (!controller.signal.aborted) {
        setGenerating((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }

  async function handleAuthor(instruction: string) {
    if (!aiReady) {
      return;
    }

    authorAbortRef.current?.abort();
    const controller = new AbortController();
    authorAbortRef.current = controller;

    const masterAtRequest = workspace.master;

    setAuthorBusy(true);
    setAuthorError(null);

    try {
      const { system, prompt } = buildAuthorRequest(instruction, docToMarkdown(workspace.master), llmConfig.stylePrompt, buildSourcesBlock(sources));
      const text = await generateText({ config: llmConfig, system, prompt, signal: controller.signal });

      if (controller.signal.aborted) {
        return;
      }

      // The reply replaces the whole master; if the user typed while the
      // request ran, keep their words instead of silently destroying them.
      if (workspaceRef.current.master !== masterAtRequest) {
        setAuthorError('The draft changed while the AI was writing, so its result was not applied. Submit again to rerun on the latest draft.');
        return;
      }

      const doc = markdownToTipTap(text);
      setWorkspace((prev) => applyMasterEdit(prev, doc));
      setAiVersions(new Map()); // master replaced — drop stale AI versions
      adaptedKeyRef.current.clear();
      setEditorVersion((version) => version + 1);
      setMasterVersion((version) => version + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        setAuthorError(error instanceof Error ? error.message : 'AI request failed.');
      }
    } finally {
      if (authorAbortRef.current === controller) {
        setAuthorBusy(false);
      }
    }
  }

  function handleSaveSettings(config: LlmConfig) {
    setLlmConfig(config);
    saveLlmConfig(config);
    setShowSettings(false);

    void runAutoAdapt(config);
  }

  function handleAddSource(source: Source) {
    setSources((prev) => [...prev, source]);
    void autoTitleSource(source);
  }

  function handleUpdateSource(id: string, source: Source) {
    setSources((prev) => prev.map((existing) => (existing.id === id ? source : existing)));
    void autoTitleSource(source);
  }

  // Name an untitled pasted source with the LLM. Silent no-op when AI isn't
  // configured or the request fails — the placeholder title still works.
  async function autoTitleSource(source: Source) {
    if (!source.needsTitle || !aiReady || !source.text.trim()) {
      return;
    }

    try {
      const { system, prompt } = buildSourceTitleRequest(source.text, MAX_TITLE_CHARS);
      const reply = await generateText({ config: llmConfig, system, prompt, maxTokens: TITLE_MAX_TOKENS });
      const title = cleanSourceTitle(reply);

      if (!title) {
        return;
      }

      setSources((prev) =>
        prev.map((existing) =>
          // Skip if the user renamed or replaced the source while we waited.
          existing.id === source.id && existing.needsTitle && existing.text === source.text
            ? { ...existing, title, needsTitle: undefined }
            : existing,
        ),
      );
    } catch {
      // Keep the placeholder title.
    }
  }

  function handleRemoveSource(id: string) {
    setSources((prev) => prev.filter((source) => source.id !== id));
  }

  function handleSetImageAttachment(image: Attachment | null) {
    setImageAttachment((prev) => {
      if (prev) {
        revokeAttachment(prev);
      }

      return image;
    });

    // Persist image/video binaries to IndexedDB so they survive reload/restart;
    // removals (and non-file attachments) clear the stored blob. Fire-and-forget.
    if (image?.file) {
      void putActiveAttachment(image);
    } else {
      void clearActiveAttachment();
    }
  }

  function handleMasterChange(nextMaster: EditorNode) {
    setWorkspace((prev) => applyMasterEdit(prev, nextMaster));
    setMasterVersion((version) => version + 1);
  }

  function handleReplaceDocument(nextMaster: EditorNode) {
    // Importing or dropping a file replaces the whole draft; ask first when
    // there is a draft to lose (a stray drop must not wipe hours of work).
    if (docToPlainText(workspace.master).trim()) {
      setConfirmAction({ kind: 'replace', document: nextMaster });
      return;
    }

    performReplaceDocument(nextMaster);
  }

  function performReplaceDocument(nextMaster: EditorNode) {
    setWorkspace((prev) => applyMasterEdit(prev, nextMaster));
    setAiVersions(new Map());
    adaptedKeyRef.current.clear();
    setEditorVersion((version) => version + 1);
    setStorageNotice(null);
  }

  function handlePaneChange(id: PlatformId, doc: EditorNode) {
    // A manual edit forks the platform; drop any AI version it supersedes.
    setWorkspace((prev) => applyPaneEdit(prev, id, doc));
    setAiVersions((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function handleStartEditing(id: PlatformId) {
    setActivePaneEditor(id);
  }

  function handleStopEditing() {
    setActivePaneEditor(null);
  }

  function clearAiVersion(id: PlatformId) {
    setAiVersions((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  // Whether discarding the current workspace would lose anything the user made.
  function hasUnsavedContent(): boolean {
    return (
      Boolean(docToPlainText(workspace.master).trim()) ||
      Object.keys(workspace.overrides).length > 0 ||
      sources.length > 0 ||
      imageAttachment !== null
    );
  }

  function handleResync(id: PlatformId) {
    setConfirmAction({ kind: 'resync', id });
  }

  function performResync(id: PlatformId) {
    setWorkspace((prev) => resyncPlatform(prev, id));
    clearAiVersion(id);
    setActivePaneEditor((current) => (current === id ? null : current));

    // If the freshly re-synced master text overflows this platform, adapt it now
    // (showing the "Adapting…" notice) instead of waiting for the idle autofit pass.
    const spec = PLATFORMS_BY_ID[id];

    if (spec && aiReady && llmConfig.autoFit) {
      const overLimit = renderForPlatform(workspace.master, spec).summary.count > spec.charLimit;

      if (overLimit) {
        void handleFit(id);
      }
    }
  }

  function handleTogglePlatform(id: PlatformId) {
    setWorkspace((prev) => togglePlatform(prev, id));
    clearAiVersion(id);
    // Closing the pane of a platform being hidden avoids a dangling editor.
    setActivePaneEditor((current) => (current === id ? null : current));
  }

  function handleReset() {
    if (!hasUnsavedContent()) {
      performReset();
      return;
    }

    setConfirmAction({ kind: 'reset' });
  }

  function performReset() {
    setWorkspace((prev) => ({ ...prev, master: EMPTY_DOCUMENT, overrides: {} }));
    setAiVersions(new Map());
    adaptedKeyRef.current.clear();
    setActivePaneEditor(null);
    setSources([]);
    handleSetImageAttachment(null);
    startedPreviewKeys.current.clear();
    setLinkPreviews(new Map());
    setDebouncedPlatformPreviewUrls([]);
    setEditorVersion((version) => version + 1);
    setStorageNotice(null);
  }

  async function handleSaveDraftSnapshot(title: string) {
    const characterCount = renderForPlatform(workspace.master, PLATFORMS_BY_ID.linkedin).summary.count;
    const extras = {
      overrides: workspace.overrides,
      aiVersions: Object.fromEntries(aiVersions) as Partial<Record<PlatformId, EditorNode>>,
      enabledPlatforms: workspace.enabledPlatforms,
      sources,
    };
    const attachments = imageAttachment ? await serializeAttachmentsForDraft([imageAttachment]) : [];
    let result = saveDraftSnapshot(workspace.master, title, characterCount, {
      ...extras,
      attachments: attachments.length ? attachments : undefined,
    });
    let notice: string | null = null;

    // A large image can push the snapshot past the localStorage quota; a draft
    // without its picture beats no draft at all.
    if (!result.ok && attachments.length) {
      result = saveDraftSnapshot(workspace.master, title, characterCount, extras);

      if (result.ok) {
        notice = 'Draft saved, but the attached image was too large to save with it.';
      }
    }

    if (result.ok) {
      setDraftHistory(loadDraftHistory());
      setStorageNotice(notice);
    } else {
      setStorageNotice(result.message);
    }
  }

  function handleRestoreDraftSnapshot(draft: DraftSnapshot) {
    if (!hasUnsavedContent()) {
      performRestoreDraftSnapshot(draft);
      return;
    }

    setConfirmAction({ kind: 'restore', draft });
  }

  function performRestoreDraftSnapshot(draft: DraftSnapshot) {
    startedPreviewKeys.current.clear();
    setLinkPreviews(new Map());
    setDebouncedPlatformPreviewUrls([]);
    handleSetImageAttachment(restoreDraftAttachments(draft.attachments)[0] ?? null);
    setSources(draft.sources ?? []);
    setWorkspace((prev) => ({
      master: draft.document,
      overrides: draft.overrides ?? {},
      enabledPlatforms: draft.enabledPlatforms ?? prev.enabledPlatforms,
    }));
    // The restored AI versions were generated from the snapshot's inputs, not
    // the current ones — drop the cache keys or the idle pass would wrongly
    // skip regenerating them under the current style/master.
    adaptedKeyRef.current.clear();
    setAiVersions(new Map(Object.entries(draft.aiVersions ?? {}) as [PlatformId, EditorNode][]));
    setActivePaneEditor(null);
    setEditorVersion((version) => version + 1);
    setStorageNotice(null);
  }

  function runConfirmAction(action: ConfirmAction) {
    switch (action.kind) {
      case 'resync':
        performResync(action.id);
        break;
      case 'reset':
        performReset();
        break;
      case 'replace':
        performReplaceDocument(action.document);
        break;
      case 'restore':
        performRestoreDraftSnapshot(action.draft);
        break;
    }
  }

  function handleDeleteDraftSnapshot(id: string) {
    const result = deleteDraftSnapshot(id);

    if (result.ok) {
      setDraftHistory(loadDraftHistory());
      setStorageNotice(null);
    } else {
      setStorageNotice(result.message);
    }
  }

  return (
    <ErrorBoundary onReset={performReset}>
      <main className="app-shell">
        <header className="app-header" aria-labelledby="app-title">
          <div className="brand-lockup" aria-hidden="true">
            <PolypostMark className="brand-mark" />
          </div>
          <div className="header-copy">
            <h1 id="app-title">{APP_NAME}</h1>
            <p className="subtitle">Draft once, format for every platform. Connect an AI assistant to help write your post and tailor it to each platform's length and style.</p>
          </div>
          <div className="header-actions">
            <InstallButton />
            <button type="button" className="header-icon-button" aria-label="How Polypost works" title="Help" onClick={() => setShowHelp(true)}>
              <HelpCircle aria-hidden="true" size={18} />
            </button>
            <button
              type="button"
              className="header-icon-button"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? <Sun aria-hidden="true" size={18} /> : <Moon aria-hidden="true" size={18} />}
            </button>
            <button type="button" className="header-icon-button" aria-label="AI settings" title="AI settings" onClick={() => setShowSettings(true)}>
              <Settings aria-hidden="true" size={18} />
            </button>
            <a
              className="github-link"
              href="https://github.com/markrussinovich/Polypost"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open GitHub repository"
            >
              <svg className="github-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            </a>
          </div>
        </header>

        <div className="platform-bar">
          <PlatformToggleChips
            specs={PLATFORMS}
            enabled={workspace.enabledPlatforms}
            dormant={dormant}
            onToggle={handleTogglePlatform}
          />
          <button
            type="button"
            className="editor-toggle"
            aria-label={isEditorCollapsed ? 'Show the editor' : 'Hide the editor'}
            title={isEditorCollapsed ? 'Show editor' : 'Hide editor'}
            onClick={() => setEditorCollapsed((value) => !value)}
          >
            {isEditorCollapsed ? <PanelLeftOpen aria-hidden="true" size={15} /> : <PanelLeftClose aria-hidden="true" size={15} />}
            <span>{isEditorCollapsed ? 'Show editor' : 'Hide editor'}</span>
          </button>
        </div>

        <section className={`workspace-grid${isEditorCollapsed ? ' is-editor-collapsed' : ''}`} aria-label={`${APP_NAME} workspace`}>
          {isEditorCollapsed ? null : (
          <div className="workspace-panel editor-workspace">
            {storageNotice ? <p className="inline-alert panel-alert" role="status">{storageNotice}</p> : null}

            <AiAssist
              ready={aiReady}
              busy={authorBusy}
              error={authorError}
              onSubmit={handleAuthor}
              onOpenSettings={() => setShowSettings(true)}
              hasDraft={Boolean(docToPlainText(workspace.master).trim())}
              stylePrompt={llmConfig.stylePrompt}
              sources={sources}
              onAddSource={handleAddSource}
              onUpdateSource={handleUpdateSource}
              onRemoveSource={handleRemoveSource}
            />
            <EditorShell
              key={editorVersion}
              initialContent={workspace.master}
              onDocumentChange={handleMasterChange}
              onReplaceDocument={handleReplaceDocument}
              onReset={handleReset}
            />
            <ImageAttachmentControl image={imageAttachment} onSetImage={handleSetImageAttachment} />
            <DraftHistoryPanel
              drafts={draftHistory}
              onDelete={handleDeleteDraftSnapshot}
              onRestore={handleRestoreDraftSnapshot}
              onSave={handleSaveDraftSnapshot}
            />
          </div>
          )}

          <PlatformRail
            specs={enabledSpecs}
            renders={platformRenders}
            documents={platformDocuments}
            forkedIds={forkedIds}
            aiAdaptedIds={aiAdaptedIds}
            imageAttachment={imageAttachment}
            linkPreviews={linkPreviews}
            generatingIds={generating}
            aiReady={aiReady}
            aiError={aiError}
            editingId={activePaneEditor}
            masterVersion={masterVersion}
            onStartEditing={handleStartEditing}
            onStopEditing={handleStopEditing}
            onPaneChange={handlePaneChange}
            onResync={handleResync}
            onFit={handleFit}
          />
        </section>
      </main>
      {showSettings ? <LlmSettings config={llmConfig} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} /> : null}
      {showHelp ? <HelpModal onClose={() => setShowHelp(false)} /> : null}
      {confirmAction ? (
        <ConfirmDialog
          {...describeConfirmAction(confirmAction)}
          onConfirm={() => {
            setConfirmAction(null);
            runConfirmAction(confirmAction);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
      <UpdatePrompt />
    </ErrorBoundary>
  );
}

function describeConfirmAction(action: ConfirmAction): { title: string; message: string; confirmLabel: string } {
  switch (action.kind) {
    case 'resync':
      return {
        title: `Re-sync ${PLATFORMS_BY_ID[action.id]?.label ?? 'platform'}?`,
        message: 'This discards the customized version for this platform and follows the master draft again.',
        confirmLabel: 'Re-sync',
      };
    case 'reset':
      return {
        title: 'Reset draft?',
        message: 'This clears the draft, every customized platform version, AI sources, and the attached image. It cannot be undone.',
        confirmLabel: 'Reset',
      };
    case 'replace':
      return {
        title: 'Replace draft with imported file?',
        message: 'The imported document replaces your current draft and customized platform versions. It cannot be undone.',
        confirmLabel: 'Replace',
      };
    case 'restore':
      return {
        title: `Restore "${action.draft.title}"?`,
        message: 'Restoring replaces your current draft, customized platform versions, sources, and attached image. Save the current draft first if you want to keep it.',
        confirmLabel: 'Restore',
      };
  }
}

function shouldAutoAdapt(config: LlmConfig): boolean {
  return Boolean(config.stylePrompt.trim()) || config.autoFit;
}

// Cache key for adaptedKeyRef: the inputs an AI platform version derives from.
function makeAdaptKey(stylePrompt: string, masterMarkdown: string): string {
  return JSON.stringify([stylePrompt, masterMarkdown]);
}

function selectAutoAdapt(
  config: LlmConfig,
  master: EditorNode,
  enabledPlatforms: PlatformId[],
  overrides: Partial<Record<PlatformId, EditorNode>>,
  aiVersions: ReadonlyMap<PlatformId, EditorNode>,
): { toFit: PlatformId[]; toClear: PlatformId[] } {
  const userForkedIds = new Set(Object.keys(overrides) as PlatformId[]);
  const aiVersionIds = new Set(aiVersions.keys());
  // Style guidance only targets cards when the editor itself has content —
  // context/source documents alone must not trigger styling of an empty post.
  const hasMasterContent = Boolean(docToPlainText(master).trim());
  const styleActive = Boolean(config.stylePrompt.trim()) && hasMasterContent;
  const styleTargets = styleActive ? enabledPlatforms.filter((id) => !userForkedIds.has(id)) : [];
  const fitSelection = config.autoFit
    ? selectAutofit({ master, enabledPlatforms, userForkedIds, aiVersionIds })
    : { toFit: [], toClear: [] };
  const enabled = new Set(enabledPlatforms);
  const toFit = [...new Set([...fitSelection.toFit, ...styleTargets])];
  // With style guidance on but no editor content, drop every existing AI version
  // so the cards fall back to the (empty) master instead of stale styled text.
  const toClear = config.stylePrompt.trim()
    ? hasMasterContent
      ? [...aiVersionIds].filter((id) => !enabled.has(id) || userForkedIds.has(id))
      : [...aiVersionIds]
    : fitSelection.toClear;

  return { toFit, toClear };
}

function previewFetchKey(id: string, preview: LinkPreview | undefined): string {
  return [id, preview?.status ?? 'missing', preview?.title ?? '', preview?.imageUrl ?? ''].join('\u0000');
}

export default App;
