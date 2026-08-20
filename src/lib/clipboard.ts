export async function copyPlainText(text: string): Promise<void> {
  if (!text) {
    throw new Error('Nothing to copy yet.');
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto 0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand('copy');

    if (!copied) {
      throw new Error('Copy command was blocked.');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export function prepareLinkedInClipboardText(text: string): string {
  // LinkedIn collapses truly empty lines on paste. A zero-width space keeps
  // each authored blank line present without changing its visual appearance.
  return text.replace(/\n(?=\n)/g, '\n\u200B');
}

export function copyLinkedInText(text: string): Promise<void> {
  return copyPlainText(prepareLinkedInClipboardText(text));
}
