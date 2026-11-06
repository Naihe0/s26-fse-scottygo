/** Call directly from the rider's tap so WebKit keeps its user activation. */
export async function shareTransitLink(
  url: string,
  title: string,
  trigger: HTMLButtonElement,
  copy: () => Promise<void>,
  text?: string
): Promise<void> {
  if (trigger.disabled) return;
  if (typeof navigator.share === 'function') {
    trigger.disabled = true;
    try {
      await navigator.share({ title, url, ...(text ? { text } : {}) });
      return;
    } catch (error) {
      // Cancel is a deliberate choice. Do not put the link on the clipboard.
      if ((error as { name?: string } | null)?.name === 'AbortError') return;
    } finally {
      trigger.disabled = false;
    }
  }
  if (trigger.isConnected) await copy();
}
