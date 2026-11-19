// Isolated ZOOTIFY moving-text controls. No external dependencies or cart changes.
if (!customElements.get('zootify-moving-statement')) {
  class ZootifyMovingStatement extends HTMLElement {
    connectedCallback() {
      this.button = this.querySelector('[data-motion-button]');
      if (!this.button) return;
      this.onPress = () => {
        const paused = !this.hasAttribute('data-paused');
        this.toggleAttribute('data-paused', paused);
        this.toggleAttribute('data-user-resume', !paused);
        this.button.setAttribute('aria-pressed', String(paused));
        this.button.setAttribute('aria-label', paused ? 'Play moving text' : 'Pause moving text');
      };
      this.onHoverExit = () => this.removeAttribute('data-user-resume');
      this.onFocusExit = () => {
        queueMicrotask(() => {
          if (!this.contains(document.activeElement)) this.removeAttribute('data-user-resume');
        });
      };
      this.onVisibility = () => this.toggleAttribute('data-hidden', document.hidden);
      this.button.addEventListener('click', this.onPress);
      this.addEventListener('pointerleave', this.onHoverExit);
      this.addEventListener('focusout', this.onFocusExit);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.onVisibility();
    }
    disconnectedCallback() {
      this.button?.removeEventListener('click', this.onPress);
      this.removeEventListener('pointerleave', this.onHoverExit);
      this.removeEventListener('focusout', this.onFocusExit);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }
  customElements.define('zootify-moving-statement', ZootifyMovingStatement);
}
