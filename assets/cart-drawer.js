import { DialogComponent, DialogOpenEvent } from '@theme/dialog';
import { CartAddEvent } from '@theme/events';

/**
 * A custom element that manages a cart drawer.
 *
 * ZOOTIFY mobile UX:
 * - A deliberate left swipe that starts inside the cart HEADER closes the drawer.
 * - Swipes starting near either screen edge are deliberately ignored, so the
 *   browser retains control of its native back/forward navigation gestures.
 * - The cart contents remain vertically scrollable and all existing close
 *   mechanisms continue to work.
 * - No changes are made to window.history or the current URL.
 *
 * @typedef {object} Refs
 * @property {HTMLDialogElement} dialog - The dialog element.
 *
 * @extends {DialogComponent}
 */
class CartDrawerComponent extends DialogComponent {
  /** @type {number} */
  #summaryThreshold = 0.5;

  /** @type {{ id: number, x: number, y: number, time: number } | null} */
  #swipeStart = null;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(CartAddEvent.eventName, this.#handleCartAdd);
    this.addEventListener(DialogOpenEvent.eventName, this.#updateStickyState);

    // Delegate from the component so the gesture survives Shopify's cart
    // section updates, which can replace the header element.
    this.addEventListener('touchstart', this.#handleTouchStart, { passive: true });
    this.addEventListener('touchend', this.#handleTouchEnd, { passive: true });
    this.addEventListener('touchcancel', this.#resetSwipe, { passive: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(CartAddEvent.eventName, this.#handleCartAdd);
    this.removeEventListener(DialogOpenEvent.eventName, this.#updateStickyState);

    this.removeEventListener('touchstart', this.#handleTouchStart);
    this.removeEventListener('touchend', this.#handleTouchEnd);
    this.removeEventListener('touchcancel', this.#resetSwipe);
    this.#resetSwipe();
  }

  #handleCartAdd = () => {
    if (this.hasAttribute('auto-open')) {
      this.showDialog();
    }
  };

  open() {
    this.showDialog();

    /**
     * Close cart drawer when installments CTA is clicked to avoid overlapping dialogs.
     */
    customElements.whenDefined('shopify-payment-terms').then(() => {
      const installmentsContent = document.querySelector('shopify-payment-terms')?.shadowRoot;
      const cta = installmentsContent?.querySelector('#shopify-installments-cta');
      cta?.addEventListener('click', this.closeDialog, { once: true });
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

    // Only a single-finger swipe within an open mobile cart is eligible.
    if (!window.matchMedia('(max-width: 749px)').matches) return;
    if (!this.refs.dialog?.open || event.touches.length !== 1) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    // Only the fixed heading/header area: never the product list, offers,
    // checkout buttons, inputs, links, or interactive controls.
    const header = target.closest('.cart-drawer__header');
    if (!header || !this.contains(header)) return;
    if (target.closest('button, a, input, textarea, select, [role="button"], [data-no-cart-swipe]')) return;

    const touch = event.touches[0];
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const edgeZone = 48;

    // Safari/Chrome on iPhone own the screen-edge history gestures.
    // Do not compete with them or try to cancel their default behavior.
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

    // Intentional fast leftward gesture only. A vertical scroll, short tap,
    // or diagonal movement must not accidentally dismiss the drawer.
    const isClearLeftSwipe = deltaX <= -72 && Math.abs(deltaX) >= Math.abs(deltaY) * 1.8;
    if (isClearLeftSwipe && elapsedMs <= 1000) {
      this.closeDialog();
    }
  };

  #updateStickyState() {
    const { dialog } = /** @type {Refs} */ (this.refs);
    if (!dialog) return;

    // Refs do not cross nested `*-component` boundaries (e.g., `cart-items-component`), so we query within the dialog.
    const content = dialog.querySelector('.cart-drawer__content');
    const summary = dialog.querySelector('.cart-drawer__summary');

    if (!content || !summary) {
      // Ensure the dialog doesn't get stuck in "unsticky" mode when summary disappears (e.g., empty cart).
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
