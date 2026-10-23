/** Show the map page's message dialog, falling back to alert() without it. */
export function showModal(title: string, message: string): void {
  const modal = document.getElementById('message-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const okButton = document.getElementById('modal-ok');

  if (!modal || !modalTitle || !modalMessage || !okButton) {
    alert(`${title}\n\n${message}`);
    return;
  }

  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modal.classList.add('is-open');
  modal.removeAttribute('inert');

  const close = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('inert', '');
    okButton.removeEventListener('click', close);
  };
  okButton.addEventListener('click', close);
}
