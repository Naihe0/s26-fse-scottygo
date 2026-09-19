/**
 * Zoom Controls Component
 * Provides zoom in/out buttons for map navigation
 */
export class ZoomControls extends HTMLElement {
  connectedCallback(): void {
    this.innerHTML = `
      <div class="zoom-panel">
        <button class="circle-btn" id="zoom-in-btn" title="Zoom In" aria-label="Zoom in">
          <span class="material-icons-outlined">add</span>
        </button>
        <button class="circle-btn" id="zoom-out-btn" title="Zoom Out" aria-label="Zoom out">
          <span class="material-icons-outlined">remove</span>
        </button>
        <button class="circle-btn" id="recenter-btn" title="Recenter on User Location" aria-label="Recenter on your location">
          <span class="material-icons-outlined">my_location</span>
        </button>
      </div>
    `;

    // Add event listeners
    const zoomInBtn = this.querySelector('#zoom-in-btn');
    const zoomOutBtn = this.querySelector('#zoom-out-btn');
    const recenterBtn = this.querySelector('#recenter-btn');

    zoomInBtn?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('zoomIn', { bubbles: true }));
    });

    zoomOutBtn?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('zoomOut', { bubbles: true }));
    });

    recenterBtn?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('recenter', { bubbles: true }));
    });
  }
}

customElements.define('zoom-controls', ZoomControls);
