import { ThemeEvents, VariantUpdateEvent } from '@theme/events';
import { morph } from '@theme/morph';

class ProductInventory extends HTMLElement {
  connectedCallback() {
    this.inventorySection = this.closest('.shopify-section, dialog');
    this.inventorySection?.addEventListener(ThemeEvents.variantUpdate, this.updateInventory);

    // A small stock badge can be placed immediately after the heading
    // without including fluctuating inventory quantities in the H1.
    if (this.dataset.zootifyTitleBadge === 'true') {
      this.placeBesideProductTitle();
    }
  }

  disconnectedCallback() {
    this.inventorySection?.removeEventListener(ThemeEvents.variantUpdate, this.updateInventory);
    this.inventorySection = null;
  }

  placeBesideProductTitle() {
    const details = this.closest('.product-details[data-testid="product-information-details"]');
    if (!details) return;
    const titleBlock = details.querySelector(
      ':scope > .group-block > .group-block-content > [class*="mobile-text-control--"] > .text-block'
    );
    const heading = titleBlock?.querySelector(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'
    );
    if (!heading || this.parentElement === titleBlock) return;
    heading.insertAdjacentElement('afterend', this);
  }

  /**
   * Update the inventory when the chosen variant or product changes.
   * @param {VariantUpdateEvent} event
   */
  updateInventory = (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.target instanceof HTMLElement && event.target.dataset.productId !== this.dataset.productId) {
      return;
    }

    const newInventory = event.detail.data.html.querySelector('product-inventory');
    if (!newInventory) return;
    morph(this, newInventory, { childrenOnly: true });
  };
}

if (!customElements.get('product-inventory')) {
  customElements.define('product-inventory', ProductInventory);
}
