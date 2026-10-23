let dismissActive: ((restoreFocus: boolean) => void) | null = null;

/** Show one message dialog, keeping keyboard focus inside until dismissed. */
export function showModal(title: string, message: string): void {
  const modal = document.getElementById('message-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const okButton = document.getElementById('modal-ok');

  if (!modal || !modalTitle || !modalMessage || !okButton) {
    alert(`${title}\n\n${message}`);
    return;
  }

  dismissActive?.(true);
  const previousFocus = document.activeElement as HTMLElement | null;
  const background = Array.from(document.body.children).filter(
    (element) => element !== modal && !element.hasAttribute('inert')
  );
  background.forEach((element) => element.setAttribute('inert', ''));
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modal.classList.add('is-open');
  modal.removeAttribute('inert');
  okButton.focus();

  const dismiss = (restoreFocus: boolean) => {
    modal.classList.remove('is-open');
    modal.setAttribute('inert', '');
    okButton.removeEventListener('click', close);
    modal.removeEventListener('keydown', onKeyDown);
    background.forEach((element) => element.removeAttribute('inert'));
    dismissActive = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  };
  const close = () => dismiss(true);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      okButton.focus();
    }
  };
  dismissActive = dismiss;
  okButton.addEventListener('click', close);
  modal.addEventListener('keydown', onKeyDown);
}
