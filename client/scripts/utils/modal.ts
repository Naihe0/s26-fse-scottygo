let dismissActive: ((restoreFocus: boolean) => void) | null = null;

export interface ModalAction {
  label: string;
  action: () => void;
}

/** Show one message dialog, keeping keyboard focus inside until dismissed. */
export function showModal(
  title: string,
  message: string,
  action?: ModalAction
): void {
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
  const actionButton = action ? document.createElement('button') : null;
  if (actionButton && action) {
    actionButton.type = 'button';
    actionButton.className = 'modal-btn modal-btn--secondary';
    actionButton.textContent = action.label;
    okButton.insertAdjacentElement('afterend', actionButton);
  }
  modal.classList.add('is-open');
  modal.removeAttribute('inert');
  okButton.focus();

  let closed = false;
  const dismiss = (restoreFocus: boolean) => {
    if (closed) return;
    closed = true;
    modal.classList.remove('is-open');
    modal.setAttribute('inert', '');
    okButton.removeEventListener('click', close);
    actionButton?.removeEventListener('click', runAction);
    actionButton?.remove();
    modal.removeEventListener('keydown', onKeyDown);
    background.forEach((element) => element.removeAttribute('inert'));
    dismissActive = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  };
  const close = () => dismiss(true);
  const runAction = () => {
    if (closed) return;
    dismiss(true);
    action?.action();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = [okButton, actionButton].filter(
        (button): button is HTMLElement => !!button
      );
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      const next =
        index < 0
          ? event.shiftKey
            ? buttons.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + buttons.length) %
            buttons.length;
      buttons[next].focus();
    }
  };
  dismissActive = dismiss;
  okButton.addEventListener('click', close);
  actionButton?.addEventListener('click', runAction);
  modal.addEventListener('keydown', onKeyDown);
}
