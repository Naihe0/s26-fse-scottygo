const TOAST_DURATION_MS = 5000;

/** Briefly show a status message; styled by .toast-notification in shared.css. */
export function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}
