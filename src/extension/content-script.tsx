import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { LinkedInComposerOverlay, type PostOutcome, type PostResult } from './LinkedInComposerOverlay';
import { parseMentionSegments, type MentionSegment } from '../lib/mentions';
import {
  attachFilesToLinkedInComposer,
  clickLinkedInControl,
  closeNativeLinkedInComposer,
  composerTextCoversSegments,
  dismissNativeComposerDiscardConfirmation,
  findLinkedInComposer,
  findLinkedInLinkPreview,
  findLinkedInMediaAttachedIndicator,
  findLinkedInMediaNextButton,
  findLinkedInPostButton,
  findNativeComposerDialog,
  findNativeComposerDialogs,
  hideDialogSurface,
  findStartPostControlFrom,
  NATIVE_HIDDEN_CLASS_NAME,
  openNativeLinkedInComposer,
  queryAllDeep,
  setLinkedInComposerSegments,
  setLinkedInComposerText,
  type ComposerSegmentsResult,
} from './linkedinComposer';
import './extension.css';

const ROOT_ID = 'linkedin-post-formatter-extension-root';
const DIAGNOSTIC_ATTRIBUTE = 'data-linkedin-formatter-diagnostic';
const LINKEDIN_SHARE_ACTIVE_URL = 'https://www.linkedin.com/feed/?shareActive=true';
const SUPPRESS_STYLE_ID = 'lipf-native-composer-suppress';
const SUPPRESS_SELECTOR = '.share-box-v2__modal, .share-creation-state__modal, .artdeco-modal-overlay';
// Default suppression: visibility:hidden renders the composer invisible the
// instant it is created (no flash) AND removes it from the focus order, so
// LinkedIn's modal focus trap cannot steal focus from the formatter editor.
const SUPPRESS_CSS_HIDDEN = `${SUPPRESS_SELECTOR} { visibility: hidden !important; pointer-events: none !important; }`;
// Bridge-only suppression: opacity:0 keeps the composer focusable (so we can
// programmatically focus + insert text) while still invisible. Used briefly
// while posting, when the user is not interacting with the formatter.
const SUPPRESS_CSS_FOCUSABLE = `${SUPPRESS_SELECTOR} { opacity: 0 !important; pointer-events: none !important; }`;
const HIDE_LOOP_INTERVAL_MS = 150;
const DISMISS_LOOP_INTERVAL_MS = 100;
const DISMISS_TIMEOUT_MS = 3000;
const POSTED_DIALOG_CLOSE_TIMEOUT_MS = 8000;
// Media flows are slower: uploads must register (the "Remove media" indicator
// or a media editor's Next step) before text can be inserted, and video
// uploads/processing gate the Post button.
const MEDIA_ATTACH_TIMEOUT_MS = 60000;
const MEDIA_POST_BUTTON_TIMEOUT_MS = 90000;
const MEDIA_POSTED_DIALOG_CLOSE_TIMEOUT_MS = 30000;
// LinkedIn unfurls a URL in the text into a link preview card asynchronously;
// give it a moment to attach before Post so the card ships with the post.
const LINK_PREVIEW_TIMEOUT_MS = 8000;
const LOG_PREFIX = '[LIPF]';

function log(...args: unknown[]) {
  console.log(LOG_PREFIX, ...args);
}

function dumpDomState(label: string) {
  const dialogs = queryAllDeep<HTMLElement>('[role="dialog"]').map((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return {
      inExtension: Boolean(dialog.closest(`#${ROOT_ID}`)),
      hidden: dialog.classList.contains(NATIVE_HIDDEN_CLASS_NAME),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      aria: dialog.getAttribute('aria-label'),
      cls: dialog.className.slice(0, 80),
      text: (dialog.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60),
    };
  });

  const editables = queryAllDeep<HTMLElement>('[contenteditable="true"]').map((editor) => {
    const rect = editor.getBoundingClientRect();
    return {
      inExtension: Boolean(editor.closest(`#${ROOT_ID}`)),
      ql: editor.classList.contains('ql-editor'),
      aria: editor.getAttribute('aria-label'),
      placeholder: editor.getAttribute('data-placeholder'),
      inDialog: Boolean(editor.closest('[role="dialog"]')),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  });

  log(`DOM[${label}] dialogs=${dialogs.length} editables=${editables.length}`, JSON.stringify({ dialogs, editables }));
}

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;
let isFormatterOpen = false;
let isBridgingToNativeComposer = false;
let hideLoopId: number | null = null;
let suppressMode: 'hidden' | 'focusable' = 'hidden';

function mountFormatter() {
  // The DOM check also covers a root owned by another injection of this
  // script (toolbar re-injection runs in a fresh scope where
  // mountedContainer is null).
  if (mountedContainer?.isConnected || document.getElementById(ROOT_ID)) {
    return;
  }

  const container = document.createElement('div');
  container.id = ROOT_ID;
  container.className = 'lipf-extension-root';
  container.textContent = 'LinkedIn Post Formatter loaded';
  container.setAttribute(DIAGNOSTIC_ATTRIBUTE, 'mounted');
  document.body.append(container);

  mountedContainer = container;

  try {
    mountedRoot = createRoot(container);
    renderFormatter();
  } catch (error) {
    renderMountError(container, error);
  }
}

function renderFormatter(sync = false) {
  const overlay = (
    <StrictMode>
      <LinkedInComposerOverlay open={isFormatterOpen} onClose={closeFormatter} onPost={postThroughLinkedIn} />
    </StrictMode>
  );

  if (sync) {
    flushSync(() => mountedRoot?.render(overlay));
    return;
  }

  mountedRoot?.render(overlay);
}

function openFormatter() {
  log('openFormatter');
  isFormatterOpen = true;
  suppressNativeComposer();
  hideNativeComposer();
  startNativeComposerHideLoop();
  renderFormatter(true);
}

// LinkedIn's composer can take seconds to render (inside a shadow root the
// MutationObserver below cannot see), so poll-hide while the formatter is open.
function startNativeComposerHideLoop() {
  if (hideLoopId !== null) {
    return;
  }

  hideLoopId = window.setInterval(() => {
    if (!isFormatterOpen) {
      window.clearInterval(hideLoopId!);
      hideLoopId = null;
      return;
    }

    // Re-assert suppression so composer surfaces (and any newly created shadow
    // root) stay invisible while the formatter owns the screen.
    suppressNativeComposer();
    hideNativeComposer();
  }, HIDE_LOOP_INTERVAL_MS);
}

function closeFormatter() {
  log('closeFormatter');
  isFormatterOpen = false;
  renderFormatter(true);
  closeNativeComposer();
}

async function postThroughLinkedIn(text: string, files: File[]): Promise<PostResult> {
  log('postThroughLinkedIn start, textLength:', text.length, 'files:', files.length);
  isBridgingToNativeComposer = true;
  const mentions = { requested: 0, applied: 0 };
  const finish = (outcome: PostOutcome): PostResult => ({
    outcome,
    mentionsRequested: mentions.requested,
    mentionsApplied: mentions.applied,
  });

  // The formatter stays open ("Posting...") and the native composer stays
  // hidden for the whole bridge, so the user never sees LinkedIn's editor.
  try {
    // The Start-a-post click already opened the native composer (we don't block
    // it), so wait for it before re-clicking — a second click would toggle a
    // still-rendering composer closed.
    let composer = findLinkedInComposer() ?? (await waitForLinkedInComposer());
    log('initial composer (after wait):', Boolean(composer));

    if (!composer) {
      openNativeComposerForPost();
      composer = await waitForLinkedInComposer();
      log('after openNativeComposerForPost, composer:', Boolean(composer));
    }

    if (!composer) {
      log('falling back to shareActive URL navigation');
      window.history.pushState({}, '', LINKEDIN_SHARE_ACTIVE_URL);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await wait(500);
      composer = await waitForLinkedInComposer();
      log('after shareActive navigation, composer:', Boolean(composer));
    }

    if (!composer) {
      log('FAILED: no composer found');
      dumpDomState('post-no-composer');
      return finish('failed');
    }

    // Switch suppression to focusable mode so we can focus + insert text. The
    // composer is still invisible (opacity:0); the formatter shows "Posting...".
    suppressNativeComposer('focusable');

    if (files.length > 0) {
      const attached = attachFilesToLinkedInComposer(files);
      log('attachFilesToLinkedInComposer result:', attached);

      if (!attached) {
        log('FAILED: could not attach media');
        return finish('failed');
      }

      // Wait until the upload registers. The redesigned composer attaches
      // inline (a "Remove media" control appears); older variants open a media
      // editor whose Next/Done must be clicked to return to the share view.
      const mediaAttached = await waitForMediaAttached();
      log('media attached:', mediaAttached);

      if (!mediaAttached) {
        log('FAILED: media never attached');
        return finish('failed');
      }

      // Media processing can re-render the editor, so re-acquire it.
      composer = findLinkedInComposer() ?? composer;
    }

    if (text.trim()) {
      const segments = parseMentionSegments(text);
      let writeResult = await writeComposerContent(composer, text, segments);
      log('write composer content result:', writeResult.inserted);

      if (writeResult.inserted && files.length > 0) {
        // Late media re-renders can wipe freshly inserted text; verify it
        // stuck and re-insert once if not.
        await wait(800);
        const current = findLinkedInComposer() ?? composer;

        if (!composerContainsContent(current, segments)) {
          log('text wiped by media re-render, re-inserting');
          composer = current;
          writeResult = await writeComposerContent(composer, text, segments);
          log('write composer content retry result:', writeResult.inserted);
        }
      }

      mentions.requested = writeResult.mentionsRequested;
      mentions.applied = writeResult.mentionsApplied;

      if (!writeResult.inserted) {
        log('FAILED: could not write text');
        return finish('failed');
      }

      // Never click Post on unverified text: a mid-bridge focus steal, or
      // LinkedIn swapping the composer's DOM node right after typing (it does
      // this to re-render its own char counter / link-preview chrome), could
      // otherwise leave us verifying a detached node that still holds the old
      // text in memory while the *visible* composer is actually empty — and
      // then clicking Post on that empty one. Only ever verify against a node
      // that is still connected to the page; retry the write once if the live
      // composer turns out to be a different (empty) node than the one we
      // wrote into. (The media path re-verifies above after its own
      // re-render window.)
      let written = await resolveConnectedComposer(composer);

      if (written && written !== composer && !composerTextCoversSegments(written, segments)) {
        log('composer node changed after insert, re-inserting into the live node');
        composer = written;
        writeResult = await writeComposerContent(composer, text, segments);
        log('write composer content retry result:', writeResult.inserted);
        mentions.requested = writeResult.mentionsRequested;
        mentions.applied = writeResult.mentionsApplied;
        written = await resolveConnectedComposer(composer);
      }

      if (!written || !composerTextCoversSegments(written, segments)) {
        log('FAILED: composer text does not cover the draft, not clicking Post');
        dumpDomState('post-text-mismatch');
        return finish('failed');
      }

      composer = written;

      // Attached media suppresses link previews, so only wait when there is
      // none. Best effort: not every URL unfurls, so a timeout just proceeds.
      if (files.length === 0 && /https?:\/\//i.test(text)) {
        const preview = await waitForElement(findLinkedInLinkPreview, LINK_PREVIEW_TIMEOUT_MS);
        log('link preview attached:', Boolean(preview));
      }
    }

    const postButton = await waitForElement(
      findLinkedInPostButton,
      files.length > 0 ? MEDIA_POST_BUTTON_TIMEOUT_MS : 3500,
    );
    log('native Post button enabled:', Boolean(postButton));

    if (!postButton) {
      log('FAILED: native Post button never enabled');
      return finish('failed');
    }

    clickLinkedInControl(postButton);

    const composerClosed = await waitForElementGone(
      findNativeComposerDialog,
      files.length > 0 ? MEDIA_POSTED_DIALOG_CLOSE_TIMEOUT_MS : POSTED_DIALOG_CLOSE_TIMEOUT_MS,
    );
    log('native composer closed after post:', composerClosed);

    if (!composerClosed) {
      // Post outcome unknown: the Post click went through but LinkedIn never
      // confirmed by closing its dialog. Keep the formatter open so the user
      // sees the unconfirmed-outcome notice (and their draft/attachments are
      // not lost), and put suppression back in hidden mode so the still-open
      // native dialog cannot steal focus. Closing the formatter dismisses or
      // reveals the native composer as usual.
      log('WARNING: composer still open after Post click, outcome unknown');
      suppressNativeComposer('hidden');
      hideNativeComposer();
      return finish('unknown');
    }

    log('SUCCESS: posted through LinkedIn');

    if (mentions.requested > mentions.applied) {
      // Some mentions degraded to plain text: keep the formatter open so the
      // overlay's notice is visible. The share dialog is already gone, so
      // just restore default suppression; closing the formatter cleans up.
      suppressNativeComposer('hidden');
      return finish('posted');
    }

    isFormatterOpen = false;
    renderFormatter(true);
    showNativeComposer();
    return finish('posted');
  } finally {
    isBridgingToNativeComposer = false;
  }
}

function handleDocumentStartPostEvent(event: MouseEvent | PointerEvent) {
  if (isBridgingToNativeComposer) {
    log('handleDocumentStartPostEvent ignored (bridging)');
    return;
  }

  const target = event.target instanceof Element ? event.target : null;

  if (!target || target.closest(`#${ROOT_ID}`)) {
    return;
  }

  const control = findStartPostControlFrom(target);

  if (!control) {
    return;
  }

  log('Start-post control clicked, opening formatter');
  openFormatter();
}

function openNativeComposerForPost() {
  const opened = openNativeLinkedInComposer();
  log('openNativeComposerForPost, found Start-post control:', opened);
}

async function waitForLinkedInComposer() {
  return waitForElement(findLinkedInComposer, 3500);
}

// Resolves to a composer that is actually attached to the page. A disconnected
// fallback node is never trusted directly — it can still report its old
// textContent from memory even though nobody can see it — so this only
// returns it when the live query can't find anything better, and otherwise
// polls briefly for the composer LinkedIn swapped in.
async function resolveConnectedComposer(fallback: HTMLElement): Promise<HTMLElement | null> {
  const live = findLinkedInComposer();

  if (live) {
    return live;
  }

  if (fallback.isConnected) {
    return fallback;
  }

  return waitForElement(findLinkedInComposer, 1200);
}

// Resolves true once media is attached to the composer. Clicks through a media
// editor's Next/Done step if one appears along the way.
async function waitForMediaAttached(): Promise<boolean> {
  const deadline = Date.now() + MEDIA_ATTACH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (findLinkedInMediaAttachedIndicator()) {
      return true;
    }

    const nextButton = findLinkedInMediaNextButton();

    if (nextButton) {
      log('clicking media editor Next/Done');
      clickLinkedInControl(nextButton);
      await wait(500);
      continue;
    }

    await wait(200);
  }

  return Boolean(findLinkedInMediaAttachedIndicator());
}

// Plain text inserts in one shot; text with mention tokens goes through the
// segment writer, which resolves each token via LinkedIn's mention typeahead.
// Unresolved mentions degrade to plain "@name" text inside the post; the
// returned counts flow back to the overlay so the user is told about them.
async function writeComposerContent(
  composer: HTMLElement,
  text: string,
  segments: MentionSegment[],
): Promise<ComposerSegmentsResult> {
  if (!segments.some((segment) => segment.kind === 'mention')) {
    return { inserted: setLinkedInComposerText(composer, text), mentionsRequested: 0, mentionsApplied: 0 };
  }

  const result = await setLinkedInComposerSegments(composer, segments);
  log('mentions resolved:', result.mentionsApplied, 'of', result.mentionsRequested);
  return result;
}

function composerContainsContent(composer: HTMLElement, segments: MentionSegment[]): boolean {
  // Probe with the first text segment: mention tokens are rewritten by
  // LinkedIn into display names, so their exact text cannot be asserted.
  const firstText = segments.find((segment): segment is MentionSegment & { kind: 'text' } => {
    return segment.kind === 'text' && segment.text.trim().length > 0;
  });
  const probe = firstText?.text.trim().slice(0, 40);

  if (!probe) {
    return (composer.textContent ?? '').trim().length > 0;
  }

  return (composer.textContent ?? '').includes(probe);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitForElement<T extends Element>(finder: () => T | null, timeoutMs: number): Promise<T | null> {
  const found = finder();

  if (found) {
    return Promise.resolve(found);
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const current = finder();

      if (current) {
        window.clearInterval(interval);
        resolve(current);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(interval);
        resolve(null);
      }
    }, 100);
  });
}

function waitForElementGone(finder: () => Element | null, timeoutMs: number): Promise<boolean> {
  if (!finder()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      if (!finder()) {
        window.clearInterval(interval);
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(interval);
        resolve(false);
      }
    }, 150);
  });
}

function hideNativeComposer() {
  // In focusable mode the injected opacity:0 CSS keeps the composer invisible;
  // applying the visibility:hidden class would make it unfocusable and break
  // the post bridge, so strip the class instead.
  if (suppressMode === 'focusable') {
    queryAllDeep<HTMLElement>(`.${NATIVE_HIDDEN_CLASS_NAME}`).forEach((element) => {
      element.classList.remove(NATIVE_HIDDEN_CLASS_NAME);
    });
    return;
  }

  findNativeComposerDialogs().forEach(hideDialogSurface);
}

function showNativeComposer() {
  unsuppressNativeComposer();
  queryAllDeep<HTMLElement>(`.${NATIVE_HIDDEN_CLASS_NAME}`).forEach((element) => {
    element.classList.remove(NATIVE_HIDDEN_CLASS_NAME);
  });
}

// Injects the suppression stylesheet into the document and every shadow root so
// the composer is styled invisible at render time (zero-flash takeover). Mode
// controls focusability: 'hidden' (default) blocks LinkedIn's focus trap;
// 'focusable' keeps the composer focusable for the post bridge.
function suppressNativeComposer(mode: 'hidden' | 'focusable' = suppressMode) {
  suppressMode = mode;
  const css = mode === 'focusable' ? SUPPRESS_CSS_FOCUSABLE : SUPPRESS_CSS_HIDDEN;

  ensureSuppressStyle(document.head ?? document.documentElement, css);

  for (const host of queryAllDeep<HTMLElement>('*')) {
    if (host.shadowRoot) {
      ensureSuppressStyle(host.shadowRoot, css);
    }
  }

  if (mode === 'focusable') {
    // Drop any visibility:hidden class so the composer can receive focus.
    queryAllDeep<HTMLElement>(`.${NATIVE_HIDDEN_CLASS_NAME}`).forEach((element) => {
      element.classList.remove(NATIVE_HIDDEN_CLASS_NAME);
    });
  }
}

function ensureSuppressStyle(container: ParentNode & Node, css: string) {
  let style = (container as ParentNode).querySelector<HTMLStyleElement>(`#${SUPPRESS_STYLE_ID}`);

  if (!style) {
    style = document.createElement('style');
    style.id = SUPPRESS_STYLE_ID;
    container.appendChild(style);
  }

  if (style.textContent !== css) {
    style.textContent = css;
  }
}

function unsuppressNativeComposer() {
  suppressMode = 'hidden';
  queryAllDeep<HTMLStyleElement>(`#${SUPPRESS_STYLE_ID}`).forEach((style) => style.remove());
}

// Dismisses LinkedIn's composer (and its discard confirmation) while keeping
// every surface hidden, so closing the formatter never flashes LinkedIn UI.
function closeNativeComposer() {
  const startedAt = Date.now();

  const runDismissPass = (): 'continue' | 'stop' | 'giveup' => {
    if (isFormatterOpen) {
      return 'stop';
    }

    hideNativeComposer();
    const closedSomething = closeNativeLinkedInComposer();
    const discardedSomething = dismissNativeComposerDiscardConfirmation();
    const elapsed = Date.now() - startedAt;

    if (elapsed >= DISMISS_TIMEOUT_MS) {
      return findNativeComposerDialog() ? 'giveup' : 'stop';
    }

    if (!findNativeComposerDialog() && !closedSomething && !discardedSomething && elapsed >= 700) {
      return 'stop';
    }

    return 'continue';
  };

  const finish = (result: 'stop' | 'giveup') => {
    if (result === 'giveup') {
      log('closeNativeComposer gave up, revealing native composer');
    }

    // Reveal anything still hidden: either nothing is left (no-op) or the
    // dismissal failed and the user needs to see LinkedIn's dialog.
    showNativeComposer();
  };

  const first = runDismissPass();

  if (first !== 'continue') {
    finish(first === 'giveup' ? 'giveup' : 'stop');
    return;
  }

  const interval = window.setInterval(() => {
    const result = runDismissPass();

    if (result === 'continue') {
      return;
    }

    window.clearInterval(interval);
    finish(result);
  }, DISMISS_LOOP_INTERVAL_MS);
}

function unmountFormatter() {
  mountedRoot?.unmount();
  mountedRoot = null;

  if (mountedContainer?.isConnected) {
    mountedContainer.remove();
  }

  mountedContainer = null;
}

function scheduleMount() {
  window.setTimeout(() => {
    mountFormatter();
  }, 100);
}

function renderMountError(container: HTMLElement, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown mount error';
  container.textContent = `LinkedIn Post Formatter failed to mount: ${message}`;
  container.setAttribute(DIAGNOSTIC_ATTRIBUTE, 'mount-error');
}

const OPEN_EVENT_NAME = 'linkedin-post-formatter:open';
const MOUNTED_FLAG = '__lipfMounted';

type MountFlagWindow = Window & { [MOUNTED_FLAG]?: boolean };

function initialize() {
  // The manifest injects this script on every LinkedIn page and the toolbar
  // click re-injects the same file in a fresh scope. Guard against the second
  // copy: it would create a duplicate root/React tree, a second click
  // listener and MutationObserver, and both copies would fight over the
  // single native-composer suppression style, which can break text insertion
  // mid-post. When already mounted, just ask the live copy to open.
  const flagWindow = window as MountFlagWindow;

  if (document.getElementById(ROOT_ID) || flagWindow[MOUNTED_FLAG]) {
    log('already mounted, forwarding open request to the existing instance');
    document.dispatchEvent(new CustomEvent(OPEN_EVENT_NAME));
    return;
  }

  flagWindow[MOUNTED_FLAG] = true;

  scheduleMount();

  const observer = new MutationObserver(() => {
    scheduleMount();

    if (isFormatterOpen) {
      window.setTimeout(hideNativeComposer, 0);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', handleDocumentStartPostEvent, true);
  document.addEventListener(OPEN_EVENT_NAME, openFormatter);

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    document.removeEventListener('click', handleDocumentStartPostEvent, true);
    document.removeEventListener(OPEN_EVENT_NAME, openFormatter);
    unmountFormatter();
    delete flagWindow[MOUNTED_FLAG];
  });
}

initialize();
