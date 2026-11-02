/**
 * Copy text to the CLIENT clipboard. Callers invoke it synchronously from a click/tap handler
 * (iOS requires the clipboard write to start inside the user gesture).
 * - If navigator.clipboard?.writeText exists: call it IMMEDIATELY (no await before the call).
 *   Resolve true on success. On rejection, try the execCommand fallback and resolve its result.
 * - Otherwise (e.g. insecure http context): use the fallback synchronously.
 * Fallback: a temporary off-screen <textarea readonly> with the text, appended to document.body,
 * selected (select() + setSelectionRange(0, length) for iOS), then document.execCommand("copy"),
 * then removed (always removed, also when it throws). The focus and selection that were active
 * before are restored where possible.
 * Never throws or rejects. Empty text resolves false without touching the clipboard.
 */
export function copyText(text: string): Promise<boolean> {
  if (!text) return Promise.resolve(false);
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === "function") {
      let write: Promise<void>;
      try {
        write = Promise.resolve(clipboard.writeText(text));
      } catch {
        return Promise.resolve(execCopyFallback(text));
      }
      return write.then(
        () => true,
        () => execCopyFallback(text),
      );
    }
    return Promise.resolve(execCopyFallback(text));
  } catch {
    return Promise.resolve(false);
  }
}

function execCopyFallback(text: string): boolean {
  let ok = false;
  let previous: Element | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    previous = document.activeElement;
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("readonly", "");
    Object.assign(textarea.style, {
      position: "fixed",
      top: "0",
      left: "-9999px",
      opacity: "0",
      fontSize: "16px",
    });
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = typeof document.execCommand === "function" && document.execCommand("copy") === true;
  } catch {
    ok = false;
  } finally {
    try {
      textarea?.remove();
    } catch {
      // Removal is best effort; the element is detached from the document either way.
    }
    try {
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    } catch {
      // Focus restoration is best effort.
    }
  }
  return ok;
}
