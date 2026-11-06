interface CopyViewOptions {
  title?: string;
  description?: string;
  label?: string;
  copiedMessage?: string;
  unavailableMessage?: string;
  multiline?: boolean;
}

/** Copy public map state; retain a usable manual-copy path when access is denied. */
export async function copyViewLink(
  url: string,
  trigger: HTMLButtonElement,
  announce: (message: string) => void,
  options: CopyViewOptions = {}
): Promise<void> {
  if (trigger.disabled) return;
  trigger.disabled = true;
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url);
    if (trigger.isConnected)
      announce(
        options.copiedMessage ??
          'View link copied. Your location is not included.'
      );
  } catch {
    if (!trigger.isConnected) return;
    announce(
      options.unavailableMessage ??
        'Copy was unavailable. Select and copy the view link below.'
    );
    document.getElementById('copy-view-link-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'copy-view-link-dialog';
    dialog.className = 'view-link-dialog';
    dialog.setAttribute('aria-labelledby', 'view-link-title');
    dialog.innerHTML = `
      <h2 id="view-link-title">Copy view link</h2>
      <p>Copy this link to share your route and filters. Your location is not included.</p>
      <label for="view-link-value">View link</label>
      ${options.multiline ? '<textarea id="view-link-value" rows="8" readonly></textarea>' : '<input id="view-link-value" type="text" readonly />'}
      <button type="button">Close</button>
    `;
    if (options.title) dialog.querySelector('h2')!.textContent = options.title;
    if (options.description)
      dialog.querySelector('p')!.textContent = options.description;
    if (options.label)
      dialog.querySelector('label')!.textContent = options.label;
    const input = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea'
    )!;
    input.value = url;
    const close = () => {
      dialog.remove();
      trigger.focus();
    };
    dialog.querySelector('button')!.addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  } finally {
    trigger.disabled = false;
  }
}
