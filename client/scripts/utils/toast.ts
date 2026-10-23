const TOAST_DURATION_MS = 5000;
let dismissCurrent: (() => void) | null = null;

/** Show one dismissible status message; pause its timeout while being read. */
export function showToast(message: string): void {
  dismissCurrent?.();
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Dismiss message');
  button.textContent = '×';
  toast.append(status, button);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  const dismiss = () => {
    clearTimeout(timer);
    // A keyboard dismissal returns to the control that triggered the message.
    const wasFocused = toast.contains(document.activeElement);
    toast.remove();
    if (dismissCurrent === dismiss) dismissCurrent = null;
    if (wasFocused && previousFocus?.isConnected) previousFocus.focus();
  };
  const previousFocus = document.activeElement as HTMLElement | null;
  const resume = () => {
    clearTimeout(timer);
    if (!hovered && !toast.contains(document.activeElement)) {
      timer = setTimeout(dismiss, TOAST_DURATION_MS);
    }
  };
  button.addEventListener('click', dismiss);
  toast.addEventListener('mouseenter', () => {
    hovered = true;
    clearTimeout(timer);
  });
  toast.addEventListener('mouseleave', () => {
    hovered = false;
    resume();
  });
  toast.addEventListener('focusin', () => clearTimeout(timer));
  toast.addEventListener('focusout', resume);
  document.body.appendChild(toast);
  dismissCurrent = dismiss;
  resume();
}
