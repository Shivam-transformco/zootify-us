/* CSS chooses the visual slot before first paint. This component only keeps
   DOM/keyboard order in sync; it never changes the card's visual position. */
if (!customElements.get('zbf-collection-promo')) {
  customElements.define('zbf-collection-promo', class extends HTMLElement {
    connectedCallback() {
      if (this.moving || this.initialized) return;
      this.grid = this.closest('.product-grid');
      this.item = this.closest('[data-zbf-promo]');
      if (!this.grid || !this.item) return;
      this.initialized = true;
      this.media = window.matchMedia('(min-width: 750px)');
      this.schedule = () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.syncSourceOrder());
      };
      this.media.addEventListener('change', this.schedule);
      this.observer = new MutationObserver(this.schedule);
      this.observeGrid();
      this.gridWidth = -1;
      this.resizeObserver = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width;
        if (width !== undefined && Math.abs(width - this.gridWidth) > 0.5) {
          this.gridWidth = width;
          this.schedule();
        }
      });
      this.resizeObserver.observe(this.grid);
      this.syncSourceOrder();
    }
    observeGrid() {
      this.observer.observe(this.grid, {childList: true, attributes: true, attributeFilter: ['product-grid-view']});
    }
    syncSourceOrder() {
      if (!this.isConnected || !this.grid || !this.item) return;
      const style = getComputedStyle(this.item);
      if (style.getPropertyValue('--zbf-placement-ready').trim() !== '1' || style.display === 'none') return;
      const cards = Array.from(this.grid.querySelectorAll(':scope > [data-product-id][data-page="1"]'));
      if (!cards.length) return;
      const promoOrder = Number.parseInt(style.order, 10) || 0;
      let previous = null;
      for (const card of cards) {
        if ((Number.parseInt(getComputedStyle(card).order, 10) || 0) < promoOrder) previous = card;
      }
      if (previous ? this.item.previousElementSibling === previous : this.item.nextElementSibling === cards[0]) return;
      this.observer.disconnect();
      this.moving = true;
      try {
        if (previous) previous.insertAdjacentElement('afterend', this.item);
        else cards[0].insertAdjacentElement('beforebegin', this.item);
      } finally {
        this.moving = false;
        this.observeGrid();
      }
    }
    disconnectedCallback() {
      if (this.moving) return;
      this.media?.removeEventListener('change', this.schedule);
      this.observer?.disconnect();
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.frame);
      this.initialized = false;
    }
  });
}
