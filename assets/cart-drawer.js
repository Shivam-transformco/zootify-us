import { DialogComponent, DialogOpenEvent } from '@theme/dialog';
import { CartAddEvent } from '@theme/events';
import { morph } from '@theme/morph';

/**
 * ZOOTIFY shopping bag drawer.
 * A browser Back/Forward restoration can restore old cart HTML (bfcache).
 * Refresh only the existing drawer contents and cart icon from the Shopify
 * header section; never replace the entire header or alter cart discounts.
 *
 * The existing optional mobile header-swipe interaction is unchanged.
 *
 * @typedef {object} Refs
 * @property {HTMLDialogElement} dialog - The dialog element.
 * @extends {DialogComponent}
 */
class CartDrawerComponent extends DialogComponent {
  /** @type {number} */
  #summaryThreshold = 0.5;

  /** @type {{ id: number, x: number, y: number, time: number } | null} */
  #swipeStart = null;

  #cartNeedsRefresh = false;
  #cartRefreshPromise = null;
  #cartRevision = 0;
  #openingAfterRestore = false;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(CartAddEvent.eventName, this.#handleCartAdd);
    this.addEventListener(DialogOpenEvent.eventName, this.#updateStickyState);
    window.addEventListener('pageshow', this.#handlePageShow);

    this.addEventListener('touchstart', this.#handleTouchStart, { passive: true });
    this.addEventListener('touchend', this.#handleTouchEnd, { passive: true });
    this.addEventListener('touchcancel', this.#resetSwipe, { passive: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(CartAddEvent.eventName, this.#handleCartAdd);
    this.removeEventListener(DialogOpenEvent.eventName, this.#updateStickyState);
    window.removeEventListener('pageshow', this.#handlePageShow);

    this.removeEventListener('touchstart', this.#handleTouchStart);
    this.removeEventListener('touchend', this.#handleTouchEnd);
    this.removeEventListener('touchcancel', this.#resetSwipe);
    this.#resetSwipe();
    this.#cartRevision += 1;
  }

  #handleCartAdd = () => {
    // A cart change during a background refresh must not be overwritten by
    // an older server response.
    this.#cartRevision += 1;
    if (this.hasAttribute('auto-open')) {
      this.open();
    }
  };

  #handlePageShow = (event) => {
    if (!event.persisted) return;

    // The server cart may have changed while this page was in the browser's
    // back/forward cache. Start reconciling now, not after displaying old rows.
    this.#cartNeedsRefresh = true;
    void this.#refreshRestoredCart().catch((error) => {
      console.warn('[ZOOTIFY cart] Could not refresh the restored cart.', error);
    });
  };

  #refreshRestoredCart() {
    if (this.#cartRefreshPromise) return this.#cartRefreshPromise;
    if (!this.#cartNeedsRefresh) return Promise.resolve();

    this.#cartRefreshPromise = this.#fetchFreshDrawer()
      .finally(() => {
        this.#cartRefreshPromise = null;
      });
    return this.#cartRefreshPromise;
  }

  async #fetchFreshDrawer() {
    const currentItems = this.querySelector('cart-items-component.zcd-cart-items[data-section-id]');
    const sectionId = currentItems?.dataset.sectionId;
    if (!sectionId) throw new Error('Cart drawer section ID is unavailable');

    // Section Rendering API: fetch the same dynamic header section, but
    // morph ONLY the cart-items subtree and icon. No full-page or header swap.
    // Preserve preview_theme_id and the current locale in the page URL.
    const url = new URL(window.location.href);
    url.searchParams.set('section_id', sectionId);

    // Retry if the cart changes while the section is loading (e.g. an
    // in-flight add-to-cart or Black Friday discount recalculation).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = this.#cartRevision;
      const response = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/html' },
      });
      if (!response.ok) throw new Error('Cart section returned HTTP ' + response.status);

      const html = await response.text();
      const freshSection = new DOMParser().parseFromString(html, 'text/html');
      const freshItems = freshSection.querySelector('cart-drawer-component.zcd-cart-drawer cart-items-component.zcd-cart-items');
      const freshIcon = freshSection.querySelector('cart-drawer-component.zcd-cart-drawer cart-icon');
      if (!freshItems || !freshIcon) throw new Error('Cart section response was incomplete');

      if (!this.isConnected) return;
      if (revision !== this.#cartRevision) continue;

      const activeItems = this.querySelector('cart-items-component.zcd-cart-items');
      if (!activeItems) throw new Error('Cart drawer is no longer mounted');
      const serverItemCount = Number.parseInt(
        freshItems.querySelector('[ref="cartItemCount"]')?.textContent?.trim() || '0',
        10
      ) || 0;
      morph(activeItems, freshItems);

      const activeIcon = this.querySelector('cart-icon');
      if (activeIcon) {
        morph(activeIcon, freshIcon);
        activeIcon.classList.toggle(
          'header-actions__cart-icon--has-cart',
          freshIcon.classList.contains('header-actions__cart-icon--has-cart')
        );
      }

      // Keep the theme's short-lived cart-icon counter cache consistent with
      // the fresh server-rendered rows, including an empty cart.
      try {
        sessionStorage.setItem('cart-count', JSON.stringify({
          value: String(serverItemCount),
          timestamp: Date.now(),
        }));
      } catch { /* Private browsing may restrict storage. */ }

      this.#cartNeedsRefresh = false;
      return;
    }

    throw new Error('Cart changed during refresh; retry required');
  }

  #showCart() {
    if (!this.isConnected) return;
    this.showDialog();

    // Keep the original installment details interaction intact.
    customElements.whenDefined('shopify-payment-terms').then(() => {
      const installmentsContent = document.querySelector('shopify-payment-terms')?.shadowRoot;
      const cta = installmentsContent?.querySelector('#shopify-installments-cta');
      cta?.addEventListener('click', this.closeDialog, { once: true });
    });
  }

  open() {
    // Normal visits still open instantly. Only browser-restored pages wait for
    // the one fresh section request, avoiding an incorrect cart flash.
    if (!this.#cartNeedsRefresh && !this.#cartRefreshPromise) {
      this.#showCart();
      return;
    }
    if (this.#openingAfterRestore) return;

    this.#openingAfterRestore = true;
    void this.#refreshRestoredCart()
      .then(() => {
        this.#openingAfterRestore = false;
        this.#showCart();
      })
      .catch((error) => {
        this.#openingAfterRestore = false;
        console.warn('[ZOOTIFY cart] Could not confirm current cart; reloading.', error);
        // A full server render is safer than presenting known-stale totals.
        if (this.isConnected) window.location.reload();
      });
  }

  close() {
    this.#resetSwipe();
    this.closeDialog();
  }

  #resetSwipe = () => {
    this.#swipeStart = null;
  };

  #handleTouchStart = (event) => {
    this.#resetSwipe();
    if (!window.matchMedia('(max-width: 749px)').matches) return;
    if (!this.refs.dialog?.open || event.touches.length !== 1) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const header = target.closest('.cart-drawer__header');
    if (!header || !this.contains(header)) return;
    if (target.closest('button, a, input, textarea, select, [role="button"], [data-no-cart-swipe]')) return;

    const touch = event.touches[0];
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const edgeZone = 48;
    if (touch.clientX <= edgeZone || touch.clientX >= viewportWidth - edgeZone) return;

    this.#swipeStart = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      time: performance.now(),
    };
  };

  #handleTouchEnd = (event) => {
    const start = this.#swipeStart;
    this.#resetSwipe();
    if (!start || !this.refs.dialog?.open) return;

    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const elapsedMs = performance.now() - start.time;
    const isClearLeftSwipe = deltaX <= -72 && Math.abs(deltaX) >= Math.abs(deltaY) * 1.8;
    if (isClearLeftSwipe && elapsedMs <= 1000) {
      this.closeDialog();
    }
  };

  #updateStickyState() {
    const { dialog } = /** @type {Refs} */ (this.refs);
    if (!dialog) return;
    const content = dialog.querySelector('.cart-drawer__content');
    const summary = dialog.querySelector('.cart-drawer__summary');

    if (!content || !summary) {
      dialog.setAttribute('cart-summary-sticky', 'false');
      return;
    }
    const drawerHeight = dialog.getBoundingClientRect().height;
    const summaryHeight = summary.getBoundingClientRect().height;
    const ratio = summaryHeight / drawerHeight;
    dialog.setAttribute('cart-summary-sticky', ratio > this.#summaryThreshold ? 'false' : 'true');
  }
}

if (!customElements.get('cart-drawer-component')) {
  customElements.define('cart-drawer-component', CartDrawerComponent);
}
