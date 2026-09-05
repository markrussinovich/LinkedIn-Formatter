import type { MentionSegment } from '../lib/mentions';

const COMPOSER_SELECTORS = [
  'div[role="dialog"] .ql-editor[contenteditable="true"]',
  'div[role="dialog"] [contenteditable="true"][aria-label]',
  '.share-box [contenteditable="true"]',
  '.share-box-v2__modal [contenteditable="true"]',
  '.share-creation-state__content [contenteditable="true"]',
  '[contenteditable="true"]',
];
const EXTENSION_ROOT_SELECTOR = '#linkedin-post-formatter-extension-root';
// LinkedIn renders confirmation prompts (e.g. "Discard draft") with
// role="alertdialog", so dialog lookups must cover both roles.
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

export const NATIVE_HIDDEN_CLASS_NAME = 'lipf-native-composer-hidden';

// LinkedIn renders the share composer inside a shadow root (for example the
// div#interop-outlet host), so every lookup has to pierce shadow boundaries.
function getSearchRoots(root: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [root];

  for (let index = 0; index < roots.length; index += 1) {
    for (const host of Array.from(roots[index].querySelectorAll<HTMLElement>('*'))) {
      if (host.shadowRoot) {
        roots.push(host.shadowRoot);
      }
    }
  }

  return roots;
}

export function queryAllDeep<T extends HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return getSearchRoots(root).flatMap((searchRoot) => Array.from(searchRoot.querySelectorAll<T>(selector)));
}

export function findLinkedInComposer(root: ParentNode = document): HTMLElement | null {
  const searchRoots = getSearchRoots(root);

  for (const selector of COMPOSER_SELECTORS) {
    for (const searchRoot of searchRoots) {
      const composer = Array.from(searchRoot.querySelectorAll<HTMLElement>(selector)).find(isUsableComposer);

      if (composer) {
        return composer;
      }
    }
  }

  return null;
}

export function getLinkedInComposerAnchor(composer: HTMLElement): HTMLElement {
  return composer.closest<HTMLElement>('.ql-container') ?? composer.parentElement ?? composer;
}

export function findNativeComposerDialog(root: ParentNode = document): HTMLElement | null {
  return findNativeComposerDialogs(root)[0] ?? null;
}

export function findNativeComposerDialogs(root: ParentNode = document): HTMLElement[] {
  const composer = findLinkedInComposer(root);
  const composerDialog = composer?.closest<HTMLElement>('[role="dialog"]') ?? null;
  const dialogs = getDialogs(root).filter(isNativeComposerDialog);

  return [composerDialog, ...dialogs].filter((dialog, index, allDialogs): dialog is HTMLElement => {
    return Boolean(dialog) && allDialogs.indexOf(dialog) === index;
  });
}

// Only ever searches inside the share-composer dialog: LinkedIn labels its
// comment-submit buttons exactly "Post" too, so a page-wide fallback could
// publish the text as a comment on a random feed item if dialog detection
// ever broke. No dialog means no Post button — the caller must abort.
export function findLinkedInPostButton(root: ParentNode = document): HTMLElement | null {
  const dialog = findNativeComposerDialog(root);

  if (!dialog) {
    return null;
  }

  return getButtonLikeControls(dialog).find((control) => {
    return !control.closest(EXTENSION_ROOT_SELECTOR) && !isControlDisabled(control) && isPostActionControl(control);
  }) ?? null;
}

function isPostActionControl(control: HTMLElement): boolean {
  if (control.classList.contains('share-actions__primary-action')) {
    return true;
  }

  return [control.getAttribute('aria-label'), control.textContent].some((label) => (label ?? '').trim().toLowerCase() === 'post');
}

function isControlDisabled(control: HTMLElement): boolean {
  if (control instanceof HTMLButtonElement && control.disabled) {
    return true;
  }

  return control.getAttribute('aria-disabled') === 'true' || control.classList.contains('artdeco-button--disabled');
}

// LinkedIn ships more than one "Start a post" trigger — the variant appears to
// differ by region/experiment — so this matches every known semantic rather
// than assuming one:
//   - New (redesigned feed): a labelled element, e.g. <div aria-label="Start a
//     post"> wrapped in an <a tabindex="0">, with no button semantics.
//   - Old: a <button> / [role="button"] whose text reads "Start a post"
//     (possibly alongside an icon or extra whitespace).
export function isStartPostControl(element: HTMLElement): boolean {
  const ariaLabel = (element.getAttribute('aria-label') ?? '').trim().toLowerCase();

  // New semantic: the trigger carries the label directly.
  if (ariaLabel.includes('start a post')) {
    return true;
  }

  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Old semantic: a button-like control labelled "Start a post". Buttons are
  // specific enough that a substring match is safe even with an icon or extra
  // markup inside them.
  if (element.matches('button, [role="button"]') && text.includes('start a post')) {
    return true;
  }

  // Fallback for a bare labelled element (no aria-label, no button semantics):
  // only match when its own text is exactly the trigger, so a large container
  // that merely contains "Start a post" somewhere inside does not false-match
  // and fire the formatter on unrelated clicks.
  return text === 'start a post';
}

// LinkedIn's "Start a post" trigger has drifted across feed redesigns: a
// <button>, then a role="button" div, and — in the redesigned feed — a plain
// <div aria-label="Start a post"> wrapped in an <a tabindex="0"> with no button
// semantics at all. Walk up from the click target and match on the label rather
// than the tag so every variant is caught.
export function findStartPostControlFrom(target: Element | null): HTMLElement | null {
  for (let element: Element | null = target; element instanceof HTMLElement; element = element.parentElement) {
    if (element.closest(EXTENSION_ROOT_SELECTOR)) {
      return null;
    }

    if (isStartPostControl(element)) {
      return element;
    }
  }

  return null;
}

export function openNativeLinkedInComposer(): boolean {
  const control = queryAllDeep<HTMLElement>('button, [role="button"], a[tabindex], [aria-label]').find(isStartPostControl);

  if (!control) {
    return false;
  }

  // The label may sit on an inert wrapper; click the nearest actionable
  // ancestor (button/link) so LinkedIn's own handler fires.
  const actionable = control.closest<HTMLElement>('button, [role="button"], a[href], a[tabindex]') ?? control;
  clickControl(actionable);
  return true;
}

export function clickLinkedInControl(control: HTMLElement) {
  clickControl(control);
}

export function closeNativeLinkedInComposer(root: ParentNode = document): boolean {
  const dialogs = findNativeComposerDialogs(root);
  const closeControls = findNativeComposerCloseControls(root, dialogs);
  let clicked = false;

  for (const closeControl of closeControls) {
    clickControl(closeControl);
    clicked = true;
  }

  return clicked;
}

// Auto-clicked dialogs must belong to the share-composer flow: an unrelated
// dialog can carry the same button labels (Delete post?, Delete comment?),
// and silently confirming one would destroy user data. A dialog qualifies
// when it carries LinkedIn's share-* / media editor class markers (on itself
// or a descendant).
function hasComposerFlowMarker(dialog: HTMLElement): boolean {
  if (dialog.className.includes('share-') || dialog.className.includes('media-editor')) {
    return true;
  }

  return queryAllDeep('[class*="share-"], [class*="media-editor"]', dialog).length > 0;
}

// Only a confirmation about discarding a share-composer post/draft may be
// auto-dismissed. Generic destructive prompts (Delete post? on a feed item,
// Discard changes? on a profile edit) must be left for the user.
function isComposerDiscardDialog(dialog: HTMLElement): boolean {
  if (dialog.closest(EXTENSION_ROOT_SELECTOR)) {
    return false;
  }

  const text = (dialog.textContent ?? '').toLowerCase();

  if (!text.includes('discard')) {
    return false;
  }

  return text.includes('post') || text.includes('draft') || hasComposerFlowMarker(dialog);
}

export function dismissNativeComposerDiscardConfirmation(root: ParentNode = document): boolean {
  const controls = getDialogs(root)
    .filter(isComposerDiscardDialog)
    .flatMap((dialog) => getButtonLikeControls(dialog));
  // Exact-label matches only: never auto-click yes/ok/delete, which are the
  // labels unrelated destructive confirmations use.
  const discardControl = controls.find((control) => {
    const label = getControlLabel(control);
    return /^(discard|leave)$/.test(label) || label.includes('discard post') || label.includes('discard draft');
  });

  if (!discardControl) {
    return false;
  }

  hideDialogSurface(discardControl.closest<HTMLElement>(DIALOG_SELECTOR));
  clickControl(discardControl);
  return true;
}

// A URL in the composer text makes LinkedIn fetch a link preview card (for
// YouTube and other videos, an inline player) and attach it below the editor.
// Its presence confirms the unfurl completed.
export function findLinkedInLinkPreview(root: ParentNode = document): HTMLElement | null {
  const dialog = findNativeComposerDialog(root);

  if (!dialog) {
    return null;
  }

  return queryAllDeep<HTMLElement>('[class*="preview-container"]', dialog).find((container) => {
    const rect = container.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !container.closest(EXTENSION_ROOT_SELECTOR);
  }) ?? null;
}

// Hides a dialog plus its overlay/backdrop parent so the user never sees a
// flash of LinkedIn chrome while the extension drives it.
export function hideDialogSurface(dialog: HTMLElement | null) {
  if (!dialog) {
    return;
  }

  dialog.classList.add(NATIVE_HIDDEN_CLASS_NAME);
  const parent = dialog.parentElement;

  if (parent && /overlay|backdrop/i.test(parent.className)) {
    parent.classList.add(NATIVE_HIDDEN_CLASS_NAME);
  }
}

// LinkedIn keeps a hidden file input for the composer's media button. Prefer
// one inside the composer dialog, then any media-typed input on the page.
export function findLinkedInMediaFileInput(root: ParentNode = document): HTMLInputElement | null {
  const inputs = queryAllDeep<HTMLInputElement>('input[type="file"]', root).filter((input) => {
    return !input.closest(EXTENSION_ROOT_SELECTOR) && acceptsMediaFiles(input);
  });

  if (inputs.length === 0) {
    return null;
  }

  const dialog = findNativeComposerDialog(root);

  if (dialog) {
    const dialogInputs = queryAllDeep<HTMLInputElement>('input[type="file"]', dialog);
    const inDialog = inputs.find((input) => dialogInputs.includes(input));

    if (inDialog) {
      return inDialog;
    }
  }

  return inputs.find((input) => Boolean(input.getAttribute('accept'))) ?? inputs[0];
}

function acceptsMediaFiles(input: HTMLInputElement): boolean {
  const accept = (input.getAttribute('accept') ?? '').toLowerCase();
  return !accept || accept.includes('image') || accept.includes('video');
}

// Hands the user's files to LinkedIn's composer: first by setting the hidden
// media file input (what the Add-media button uses), falling back to a
// simulated drag-and-drop onto the composer surface.
export function attachFilesToLinkedInComposer(files: File[], root: ParentNode = document): boolean {
  if (files.length === 0) {
    return false;
  }

  const input = findLinkedInMediaFileInput(root);

  if (input && setFileInputFiles(input, files)) {
    return true;
  }

  return dropFilesOnLinkedInComposer(files, root);
}

export function dropFilesOnLinkedInComposer(files: File[], root: ParentNode = document): boolean {
  const transfer = createFileTransfer(files);
  const target = findLinkedInComposer(root) ?? findNativeComposerDialog(root);

  if (!transfer || !target) {
    return false;
  }

  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(createDragEvent(type, transfer));
  }

  return true;
}

// Some composer variants open a media editor dialog after an upload, which
// must be confirmed (Next/Done) before the share composer returns with the
// attachment. Hidden dialogs (e.g. video.js caption settings, which also has a
// "Done" button) must be skipped.
export function findLinkedInMediaNextButton(root: ParentNode = document): HTMLElement | null {
  const dialogs = queryAllDeep<HTMLElement>('[role="dialog"]', root).filter((dialog) => {
    if (dialog.closest(EXTENSION_ROOT_SELECTOR) || dialog.className.includes('vjs-')) {
      return false;
    }

    // Only the share flow's own media editor may be advanced. Clicking Next
    // or Done in an arbitrary dialog could walk the user through an
    // unrelated wizard while the bridge polls for up to a minute.
    if (!hasComposerFlowMarker(dialog)) {
      return false;
    }

    const rect = dialog.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  for (const dialog of dialogs) {
    const control = getButtonLikeControls(dialog).find((candidate) => {
      if (candidate.closest(EXTENSION_ROOT_SELECTOR) || isControlDisabled(candidate)) {
        return false;
      }

      return [candidate.getAttribute('aria-label'), candidate.textContent].some((label) => {
        const normalized = (label ?? '').trim().toLowerCase();
        return normalized === 'next' || normalized === 'done';
      });
    });

    if (control) {
      return control;
    }
  }

  return null;
}

// The redesigned (phoenix) composer attaches dropped files inline: a "Remove
// media" / "Edit media preview" control appears in the share dialog once the
// upload has registered. Its presence confirms the attachment took.
export function findLinkedInMediaAttachedIndicator(root: ParentNode = document): HTMLElement | null {
  const dialog = findNativeComposerDialog(root);

  if (!dialog) {
    return null;
  }

  return getButtonLikeControls(dialog).find((control) => {
    if (control.closest(EXTENSION_ROOT_SELECTOR)) {
      return false;
    }

    const label = getControlLabel(control);
    return label.includes('remove media') || label.includes('edit media preview');
  }) ?? null;
}

function setFileInputFiles(input: HTMLInputElement, files: File[]): boolean {
  const transfer = createFileTransfer(files);

  if (!transfer) {
    return false;
  }

  try {
    input.files = transfer.files;
  } catch {
    try {
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    } catch {
      return false;
    }
  }

  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return true;
}

function createFileTransfer(files: File[]): DataTransfer | null {
  if (typeof DataTransfer !== 'function') {
    return null;
  }

  try {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    return transfer;
  } catch {
    return null;
  }
}

function createDragEvent(type: string, transfer: DataTransfer): Event {
  if (typeof DragEvent === 'function') {
    try {
      return new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer });
    } catch {
      // Fall through to the generic event below.
    }
  }

  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

// LinkedIn's mention typeahead: typing "@name" into the composer one character
// at a time (so Quill's mention module sees each edit) opens a tray of
// role="option" profile hits. Clicking a hit makes LinkedIn insert a real
// mention entity bound to the profile — the only way to create one, since
// pasted text or HTML never becomes a mention.
const MENTION_TYPEAHEAD_OPTION_SELECTOR = '[role="option"]';
const MENTION_TYPEAHEAD_HIT_NAME_SELECTOR = '.search-typeahead-v2__hit-text';
const MENTION_TYPING_DELAY_MS = 40;
const MENTION_TYPEAHEAD_TIMEOUT_MS = 5000;
const MENTION_ENTITY_TIMEOUT_MS = 3000;

export type ComposerSegment = MentionSegment;

export interface ComposerSegmentsResult {
  inserted: boolean;
  mentionsRequested: number;
  mentionsApplied: number;
}

function normalizeMentionName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findMentionTypeaheadOption(name: string, root: ParentNode = document): HTMLElement | null {
  const target = normalizeMentionName(name);

  if (!target) {
    return null;
  }

  const options = queryAllDeep<HTMLElement>(MENTION_TYPEAHEAD_OPTION_SELECTOR, root).filter((option) => {
    if (option.closest(EXTENSION_ROOT_SELECTOR) || !option.closest('[class*="typeahead"]')) {
      return false;
    }

    const rect = option.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Only an exact (case/whitespace-insensitive) name match is clicked: a wrong
  // mention is worse than the name degrading to plain text. Options without
  // LinkedIn's hit-text markup compare their entire text, which must still
  // equal the name exactly - never a prefix match, since an option whose
  // name-plus-headline merely starts with the target is one markup change
  // away from silently mentioning the wrong person.
  return options.find((option) => {
    const hit = option.querySelector<HTMLElement>(MENTION_TYPEAHEAD_HIT_NAME_SELECTOR);
    return normalizeMentionName((hit ?? option).textContent ?? '') === target;
  }) ?? null;
}

// Finds the mention entity LinkedIn inserted for the given display name.
export function findComposerMentionEntity(composer: HTMLElement, name: string): HTMLElement | null {
  const target = normalizeMentionName(name);
  const candidates = Array.from(
    composer.querySelectorAll<HTMLElement>('a, [data-test-ql-mention], [class*="mention"], [data-entity-urn], [data-urn]'),
  );

  return candidates.find((candidate) => normalizeMentionName(candidate.textContent ?? '') === target) ?? null;
}

// Types "@name" into the composer character by character, waits for LinkedIn's
// typeahead to offer an exact name match, clicks it, and confirms the mention
// entity landed in the editor. The caret must already sit where the mention
// belongs (after whitespace or at the start, or LinkedIn won't trigger the
// typeahead). On failure the typed name remains as plain text.
export async function typeMentionIntoLinkedInComposer(composer: HTMLElement, name: string): Promise<boolean> {
  if (!composer.isConnected || composer.getAttribute('contenteditable') !== 'true') {
    return false;
  }

  for (const char of `@${name}`) {
    if (!typeCharacterIntoComposer(composer, char)) {
      return false;
    }

    await waitMilliseconds(MENTION_TYPING_DELAY_MS);
  }

  const option = await waitForCondition(() => findMentionTypeaheadOption(name), MENTION_TYPEAHEAD_TIMEOUT_MS);

  if (!option) {
    // Close the typeahead tray so it does not swallow later keystrokes.
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    return false;
  }

  const displayName = option.querySelector<HTMLElement>(MENTION_TYPEAHEAD_HIT_NAME_SELECTOR)?.textContent ?? name;
  clickControl(option);

  const entity = await waitForCondition(() => findComposerMentionEntity(composer, displayName), MENTION_ENTITY_TIMEOUT_MS);
  return Boolean(entity);
}

// Replaces the composer content with a sequence of text and mention segments.
// Mentions resolve through LinkedIn's typeahead; ones that fail to resolve stay
// as plain "@name" text and are reported via the counts in the result.
export async function setLinkedInComposerSegments(
  composer: HTMLElement,
  segments: ComposerSegment[],
): Promise<ComposerSegmentsResult> {
  const result: ComposerSegmentsResult = { inserted: false, mentionsRequested: 0, mentionsApplied: 0 };

  if (!composer.isConnected || composer.getAttribute('contenteditable') !== 'true') {
    return result;
  }

  composer.focus();
  selectComposerContents(composer);

  if (typeof document.execCommand === 'function') {
    document.execCommand('delete', false);
  } else {
    composer.textContent = '';
  }

  for (const segment of segments) {
    // The insert commands act on the global selection and the bridge spans
    // seconds; re-focus the composer before every segment so a stray focus
    // change cannot route the segment into another editable.
    composer.focus();

    if (segment.kind === 'mention') {
      result.mentionsRequested += 1;

      if (await typeMentionIntoLinkedInComposer(composer, segment.name)) {
        result.mentionsApplied += 1;
      }

      continue;
    }

    if (segment.text) {
      insertTextAtComposerCaret(composer, segment.text);
    }
  }

  // Only report success once every segment has actually been written; an
  // earlier flag would let a caller click Post on a half-inserted draft.
  result.inserted = true;

  composer.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
  composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return result;
}

// Verifies the composer's rendered text covers every plain-text segment of the
// draft, in order. Whitespace is stripped before comparing because LinkedIn
// rewrites newlines into paragraphs (dropping them from textContent) and can
// render non-breaking spaces. Mention segments are skipped: LinkedIn rewrites
// them into display names whose exact text cannot be asserted.
export function composerTextCoversSegments(composer: HTMLElement, segments: ComposerSegment[]): boolean {
  // A detached node still reports whatever textContent it held before being
  // removed from the page, so it can pass this check while the composer the
  // user (and LinkedIn's Post button) actually sees is empty. Never trust it.
  if (!composer.isConnected) {
    return false;
  }

  const haystack = stripAllWhitespace(composer.textContent ?? '');
  let searchFrom = 0;

  for (const segment of segments) {
    if (segment.kind !== 'text') {
      continue;
    }

    const needle = stripAllWhitespace(segment.text);

    if (!needle) {
      continue;
    }

    const index = haystack.indexOf(needle, searchFrom);

    if (index === -1) {
      return false;
    }

    searchFrom = index + needle.length;
  }

  return true;
}

function stripAllWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

function typeCharacterIntoComposer(composer: HTMLElement, char: string): boolean {
  composer.dispatchEvent(createInputEvent(char, 'beforeinput'));

  if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, char)) {
    return false;
  }

  composer.dispatchEvent(createInputEvent(char, 'input'));
  return true;
}

function insertTextAtComposerCaret(composer: HTMLElement, text: string) {
  composer.dispatchEvent(createInputEvent(text, 'beforeinput'));

  if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, text)) {
    // jsdom path: append and park the caret at the end.
    composer.append(document.createTextNode(text));
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  composer.dispatchEvent(createInputEvent(text, 'input'));
}

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitForCondition<T>(finder: () => T | null, timeoutMs: number): Promise<T | null> {
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

export function setLinkedInComposerText(composer: HTMLElement, text: string): boolean {
  if (!composer.isConnected || composer.getAttribute('contenteditable') !== 'true') {
    return false;
  }

  composer.focus();
  selectComposerContents(composer);
  composer.dispatchEvent(createInputEvent(text, 'beforeinput'));

  if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, text)) {
    composer.textContent = text;
  }

  composer.dispatchEvent(createInputEvent(text, 'input'));
  composer.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
  composer.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return true;
}

function isUsableComposer(composer: HTMLElement): boolean {
  if (!composer.isConnected || composer.closest(EXTENSION_ROOT_SELECTOR)) {
    return false;
  }

  const rect = composer.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const labels = [
    composer.getAttribute('aria-label'),
    composer.getAttribute('data-placeholder'),
    composer.textContent,
    composer.closest('[role="dialog"]')?.textContent,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (labels.includes('what do you want to talk about')) {
    return true;
  }

  return Boolean(composer.closest('[role="dialog"]') || composer.closest('.share-box, .share-box-v2__modal, .share-creation-state__content'));
}

function getDialogs(root: ParentNode): HTMLElement[] {
  const dialogs = queryAllDeep<HTMLElement>(DIALOG_SELECTOR, root);

  if (root instanceof HTMLElement && root.matches(DIALOG_SELECTOR)) {
    dialogs.unshift(root);
  }

  return dialogs;
}

function isNativeComposerDialog(dialog: HTMLElement): boolean {
  if (dialog.closest(EXTENSION_ROOT_SELECTOR)) {
    return false;
  }

  const text = (dialog.textContent ?? '').toLowerCase();

  return hasNativeComposerCue(text) || hasNativeComposerCandidate(dialog);
}

function hasNativeComposerCue(text: string): boolean {
  return text.includes('post to anyone') || text.includes('what do you want to talk about') || text.includes('strengthen post');
}

function hasNativeComposerCandidate(dialog: HTMLElement): boolean {
  const composerCandidate = queryAllDeep<HTMLElement>('[contenteditable="true"]', dialog).find((element) => {
    const label = [element.getAttribute('aria-label'), element.getAttribute('data-placeholder'), element.textContent]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return element.classList.contains('ql-editor') || hasNativeComposerCue(label);
  });

  if (!composerCandidate) {
    return false;
  }

  return getButtonLikeControls(dialog).some((control) => /^post$/.test(getControlLabel(control)));
}

function findDialogCloseControl(dialog: HTMLElement): HTMLElement | null {
  return getButtonLikeControls(dialog).find((control) => {
    const label = getControlLabel(control);

    if (label.includes('close') || label.includes('dismiss') || label === 'cancel') {
      return true;
    }

    return label === 'x' || label === '×';
  }) ?? null;
}

function findNativeComposerCloseControls(root: ParentNode, dialogs: HTMLElement[]): HTMLElement[] {
  const controls = dialogs
    .flatMap((dialog) => [findDialogCloseControl(dialog), findDialogCloseControl(getDialogSearchParent(dialog))])
    .filter((control, index, allControls): control is HTMLElement => {
      if (!control) {
        return false;
      }

      return !control.closest(EXTENSION_ROOT_SELECTOR) && allControls.indexOf(control) === index;
    });

  if (controls.length > 0) {
    return controls;
  }

  return getButtonLikeControls(root).filter((control) => {
    if (control.closest(EXTENSION_ROOT_SELECTOR) || !isLikelyCloseControl(control)) {
      return false;
    }

    return dialogs.some((dialog) => isControlNearDialog(control, dialog));
  });
}

function getDialogSearchParent(dialog: HTMLElement): HTMLElement {
  const parent = dialog.parentElement;

  if (!parent || parent === document.body || parent === document.documentElement) {
    return dialog;
  }

  return parent;
}

function isLikelyCloseControl(control: HTMLElement): boolean {
  const label = getControlLabel(control);
  return label.includes('close') || label.includes('dismiss') || label === 'x' || label === '×';
}

function isControlNearDialog(control: HTMLElement, dialog: HTMLElement): boolean {
  const controlRect = control.getBoundingClientRect();
  const dialogRect = dialog.getBoundingClientRect();

  if (controlRect.width <= 0 || controlRect.height <= 0 || dialogRect.width <= 0 || dialogRect.height <= 0) {
    return false;
  }

  const controlCenterX = controlRect.left + controlRect.width / 2;
  const controlCenterY = controlRect.top + controlRect.height / 2;
  const margin = 80;

  return (
    controlCenterX >= dialogRect.left - margin &&
    controlCenterX <= dialogRect.right + margin &&
    controlCenterY >= dialogRect.top - margin &&
    controlCenterY <= dialogRect.bottom + margin
  );
}

function getButtonLikeControls(root: ParentNode): HTMLElement[] {
  return queryAllDeep<HTMLElement>('button, [role="button"]', root);
}

function getControlLabel(control: HTMLElement): string {
  return [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent]
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

function clickControl(control: HTMLElement) {
  dispatchPointerEvent(control, 'pointerdown');
  dispatchMouseEvent(control, 'mousedown');
  dispatchMouseEvent(control, 'mouseup');
  dispatchPointerEvent(control, 'pointerup');
  control.click();
}

function dispatchPointerEvent(control: HTMLElement, type: string) {
  if (typeof PointerEvent !== 'function') {
    return;
  }

  control.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }));
}

function dispatchMouseEvent(control: HTMLElement, type: string) {
  control.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
}

function createInputEvent(text: string, type: 'beforeinput' | 'input'): Event {
  if (typeof InputEvent === 'function') {
    return new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, data: text, inputType: 'insertText' });
  }

  return new Event(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true });
}

function selectComposerContents(composer: HTMLElement) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
}