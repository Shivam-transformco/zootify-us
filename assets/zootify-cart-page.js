import { morphSection, sectionRenderer } from '@theme/section-renderer';
import { CartUpdateEvent, ThemeEvents } from '@theme/events';

/** ZOOTIFY cart-only enhancements. Prices are always server-rendered, never calculated here. */
const normalizeCode = (code) => String(code || '').trim().toLocaleLowerCase('en-US');
const uniqueCodes = (codes) => [...new Map(codes.filter(Boolean).map((code) => [normalizeCode(code), String(code).trim()])).values()];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function cartEndpoint(path) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('Invalid cart endpoint.');
  if (!url.pathname.endsWith('.js')) url.pathname += '.js';
  return url.toString();
}

async function fetchCartJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.errors) throw new Error('The cart request could not be completed.');
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Returns only codes Shopify currently marks applicable; automatic discounts aren't codes. */
function codesFromCart(cart, fallback = []) {
  if (Array.isArray(cart.discount_codes)) {
    return uniqueCodes(cart.discount_codes.filter((entry) => entry.applicable === true).map((entry) => entry.code));
  }
  const result = [...fallback];
  for (const discount of cart.cart_level_discount_applications || []) {
    if (discount.type === 'discount_code') result.push(discount.title);
  }
  for (const line of cart.items || []) {
    for (const allocation of line.line_level_discount_allocations || []) {
      if (allocation.discount_application?.type === 'discount_code') result.push(allocation.discount_application.title);
    }
  }
  return uniqueCodes(result);
}

class ZootifyCartDiscount extends HTMLElement {
  #busy = false;
  #hydrated = false;
  #revision = 0;

  connectedCallback() {
    this.addEventListener('submit', this.#onSubmit);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('input', this.#onInput);
    this.addEventListener('toggle', this.#onToggle, true);
    document.addEventListener(ThemeEvents.cartUpdate, this.#onCartChanged);
    document.addEventListener(ThemeEvents.quantitySelectorUpdate, this.#onCartChanged);
    if (this.querySelector('details')?.open) this.#hydrateCodes();
  }

  disconnectedCallback() {
    this.removeEventListener('submit', this.#onSubmit);
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('input', this.#onInput);
    this.removeEventListener('toggle', this.#onToggle, true);
    document.removeEventListener(ThemeEvents.cartUpdate, this.#onCartChanged);
    document.removeEventListener(ThemeEvents.quantitySelectorUpdate, this.#onCartChanged);
    this.#revision += 1;
    // Do not abort a mutation on a morph: Shopify may already have applied it.
  }

  #onCartChanged = () => {
    this.#revision += 1;
    this.#hydrated = false;
  };

  #onInput = () => {
    if (this.#busy) return;
    this.querySelector('input[name="discount"]')?.removeAttribute('aria-invalid');
    this.setStatus('');
  };

  #onToggle = (event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.open) this.#hydrateCodes();
  };

  #onSubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.matches('[data-zc-code-form]')) return;
    event.preventDefault();
    event.stopPropagation();
    const input = this.querySelector('input[name="discount"]');
    if (!(input instanceof HTMLInputElement)) return;
    const code = input.value.trim();
    if (!code) {
      input.value = '';
      input.reportValidity();
      return;
    }
    this.#changeCodes('apply', code);
  };

  #onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-zc-remove-code]');
    if (!(button instanceof HTMLButtonElement) || !this.contains(button)) return;
    event.preventDefault();
    const code = button.dataset.zcRemoveCode;
    if (code) this.#changeCodes('remove', code);
  };

  #domCodes() {
    return uniqueCodes([...this.querySelectorAll('[data-zc-code]')].map((node) => node.dataset.zcCode));
  }

  async #hydrateCodes() {
    if (this.#hydrated || this.#busy || this.closest('zootify-cart-summary')?.isBusy) return;
    this.#hydrated = true;
    const revision = this.#revision;
    try {
      const cart = await fetchCartJSON(cartEndpoint(this.dataset.cartUrl));
      if (this.isConnected && !this.#busy && !this.closest('zootify-cart-summary')?.isBusy && revision === this.#revision) {
        this.paintCodes(codesFromCart(cart, this.#domCodes()));
      }
    } catch {
      // Keep the server-rendered code list when this optional read fails.
      this.#hydrated = false;
    }
  }

  paintCodes(codes) {
    const list = this.querySelector('[data-zc-code-list]');
    if (!list) return;
    const children = uniqueCodes(codes).map((code) => {
      const li = document.createElement('li');
      li.className = 'zc-code';
      li.dataset.zcCode = code;
      const label = document.createElement('span');
      label.textContent = code;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.zcRemoveCode = code;
      remove.setAttribute('aria-label', `Remove discount ${code}`);
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '×';
      remove.append(icon);
      li.append(label, remove);
      return li;
    });
    list.replaceChildren(...children);
  }

  setStatus(message, tone = 'info') {
    const status = this.querySelector('[data-zc-code-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }

  async #changeCodes(operation, code) {
    const summary = this.closest('zootify-cart-summary');
    if (this.#busy || summary?.isBusy) return;
    const sectionId = this.dataset.sectionId;
    if (!sectionId) return;
    this.#busy = true;
    this.#revision += 1;
    summary?.setDiscountBusy(true);
    this.setStatus(operation === 'apply' ? 'Applying code…' : 'Removing code…');
    const componentId = this.id;
    const oldCartItems = this.closest('cart-items-component');
    const updateURL = cartEndpoint(this.dataset.updateUrl);
    const cartURL = cartEndpoint(this.dataset.cartUrl);
    const inputDraft = this.querySelector('input[name="discount"]')?.value || '';
    let activeComponent = this;
    try {
      // Read first so applying a code cannot silently drop a previously accepted shipping code.
      const currentCart = await fetchCartJSON(cartURL);
      const existing = codesFromCart(currentCart, this.#domCodes());
      if (operation === 'apply' && existing.some((value) => normalizeCode(value) === normalizeCode(code))) {
        this.paintCodes(existing);
        this.setStatus('This code is already applied.');
        return;
      }
      const desired = operation === 'apply'
        ? uniqueCodes([...existing, code])
        : existing.filter((value) => normalizeCode(value) !== normalizeCode(code));
      const sectionIds = [...new Set([sectionId, ...[...document.querySelectorAll('cart-items-component[data-section-id]')].map((node) => node.dataset.sectionId)])].slice(0, 5);
      const data = await fetchCartJSON(updateURL, {
        method: 'POST',
        body: JSON.stringify({
          discount: desired.join(','), sections: sectionIds,
          sections_url: `${window.location.pathname}${window.location.search}`,
        }),
      });
      let html = data.sections?.[sectionId];
      if (typeof html !== 'string' || !html.includes(`shopify-section-${sectionId}`)) {
        // Cart changes can succeed while bundled section rendering returns null.
        html = await sectionRenderer.getSectionHTML(sectionId, false);
      }
      const fragment = new DOMParser().parseFromString(html, 'text/html');
      const freshComponent = fragment.getElementById(componentId);
      const renderedCodes = [...(freshComponent?.querySelectorAll('[data-zc-code]') || [])].map((node) => node.dataset.zcCode);
      const acceptedCodes = codesFromCart(data, renderedCodes);
      const accepted = acceptedCodes.some((value) => normalizeCode(value) === normalizeCode(code));
      const hasVisibleSaving = renderedCodes.some((value) => normalizeCode(value) === normalizeCode(code));

      // Render the actual cart even after an invalid code, as Shopify can change combinations.
      await morphSection(sectionId, html);
      data.sections = { ...data.sections, [sectionId]: html };
      const cartItems = oldCartItems?.isConnected ? oldCartItems : document.getElementById(`shopify-section-${sectionId}`)?.querySelector('cart-items-component');
      (cartItems || document).dispatchEvent(new CartUpdateEvent(data, sectionId, {
        itemCount: data.item_count, source: 'zootify-cart-discount', sections: data.sections,
      }));
      await nextFrame();
      activeComponent = document.getElementById(componentId) || this;
      if (!(activeComponent instanceof ZootifyCartDiscount)) return;
      activeComponent.paintCodes(acceptedCodes);
      const input = activeComponent.querySelector('input[name="discount"]');
      const disclosure = activeComponent.querySelector('details');
      if (disclosure) disclosure.open = true;
      if (input) {
        input.value = operation === 'apply' && accepted ? '' : (operation === 'apply' ? code : inputDraft);
        input.toggleAttribute('aria-invalid', operation === 'apply' && !accepted);
        if (input.hasAttribute('aria-invalid')) input.setAttribute('aria-invalid', 'true');
      }
      if (operation === 'remove') {
        activeComponent.setStatus(accepted ? 'This code could not be removed. Please try again.' : 'Discount code removed.', accepted ? 'error' : 'info');
      } else if (accepted) {
        activeComponent.setStatus(hasVisibleSaving ? 'Code applied. Your total has been updated.' : 'Code accepted. Any additional savings will be confirmed at checkout.');
      } else {
        activeComponent.setStatus('This code is not applicable to your cart. Check the code and its conditions, then try again.', 'error');
      }
      summary?.setDiscountBusy(false);
      activeComponent.closest('zootify-cart-summary')?.setDiscountBusy(false);
      input?.focus({ preventScroll: true });
    } catch (error) {
      activeComponent = document.getElementById(componentId) || this;
      activeComponent.setStatus('We could not confirm the discount change. Please try again, or check the code and final total at checkout.', 'error');
      const input = activeComponent.querySelector('input[name="discount"]');
      if (input) input.value = operation === 'apply' ? code : inputDraft;
      console.warn('[ZOOTIFY cart] Discount update could not be confirmed.', error);
    } finally {
      this.#busy = false;
      summary?.setDiscountBusy(false);
      activeComponent.closest('zootify-cart-summary')?.setDiscountBusy(false);
    }
  }
}

class ZootifyCartSummary extends HTMLElement {
  #discountBusy = false;
  #quantityPendingUntil = 0;
  #frame = 0;
  #quantityTimer;
  #spacer;
  #cartItems;
  #resizeObserver;
  #contentObserver;
  #cartObserver;
  #dialogObserver;
  #abort;

  get isBusy() {
    return this.#discountBusy || Date.now() < this.#quantityPendingUntil || Boolean(this.#cartItems?.classList.contains('cart-items-disabled'));
  }

  setDiscountBusy(busy) {
    this.#discountBusy = Boolean(busy);
    this.#syncControls();
    this.#schedule();
  }

  connectedCallback() {
    this.#cartItems = this.closest('cart-items-component');
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    window.addEventListener('scroll', this.#schedule, { passive: true, signal });
    window.addEventListener('resize', this.#schedule, { passive: true, signal });
    window.addEventListener('pageshow', this.#schedule, { signal });
    window.visualViewport?.addEventListener('resize', this.#schedule, { signal });
    document.addEventListener('focusin', this.#schedule, { signal });
    document.addEventListener('focusout', this.#schedule, { signal });
    document.addEventListener(ThemeEvents.quantitySelectorUpdate, this.#onQuantity, { signal });
    this.addEventListener('click', this.#onClick, { signal });
    this.addEventListener('toggle', this.#schedule, { capture: true, signal });
    this.#cartItems?.addEventListener('submit', this.#guardSubmit, { capture: true, signal });
    this.#resizeObserver = new ResizeObserver(this.#schedule);
    this.#resizeObserver.observe(this);
    const panel = this.querySelector('[data-zc-panel]');
    if (panel) this.#resizeObserver.observe(panel);
    const header = document.getElementById('header-group');
    if (header) this.#resizeObserver.observe(header);
    this.#contentObserver = new MutationObserver(this.#schedule);
    this.#contentObserver.observe(this, { childList: true, subtree: true, characterData: true });
    this.#cartObserver = new MutationObserver(this.#schedule);
    if (this.#cartItems) this.#cartObserver.observe(this.#cartItems, { attributes: true, attributeFilter: ['class'] });
    this.#dialogObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches('dialog, [aria-modal="true"], [popover]') || node.querySelector('dialog, [aria-modal="true"], [popover]'))))) this.#schedule();
    });
    this.#dialogObserver.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['open', 'aria-expanded', 'aria-modal'] });
    this.#schedule();
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#resizeObserver?.disconnect();
    this.#contentObserver?.disconnect();
    this.#cartObserver?.disconnect();
    this.#dialogObserver?.disconnect();
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#quantityTimer);
    this.#frame = 0;
    this.#spacer?.remove();
    this.#spacer = undefined;
    const productArea = this.closest('.zootify-cart-page--v3')?.querySelector('.cart-page__items');
    if (productArea) productArea.inert = false;
  }

  #onQuantity = (event) => {
    if (!(event.target instanceof Element) || event.target.closest('cart-items-component') !== this.#cartItems) return;
    // Bridge the native 300ms debounce before cart-items-disabled is added.
    this.#quantityPendingUntil = Date.now() + 450;
    clearTimeout(this.#quantityTimer);
    this.#quantityTimer = setTimeout(this.#schedule, 470);
    this.#syncControls();
    this.#schedule();
  };

  #guardSubmit = (event) => {
    if (this.isBusy && event.target instanceof HTMLFormElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  #onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const mobileButton = event.target.closest('[data-zc-mobile-checkout]');
    if (!mobileButton) return;
    event.preventDefault();
    if (!this.isBusy) this.querySelector('[data-zc-main-checkout]')?.click();
  };

  #syncControls() {
    const busy = this.isBusy;
    for (const button of this.querySelectorAll('[data-zc-main-checkout], [data-zc-mobile-checkout], .zc-apply, [data-zc-remove-code]')) {
      if (button.disabled !== busy) button.disabled = busy;
    }
    const input = this.querySelector('[data-zc-code-form] input');
    if (input && input.disabled !== busy) input.disabled = busy;
    const wallet = this.querySelector('[data-zc-wallets]');
    if (wallet && wallet.inert !== busy) wallet.inert = busy;
    const items = this.closest('.zootify-cart-page--v3')?.querySelector('.cart-page__items');
    if (items && items.inert !== this.#discountBusy) items.inert = this.#discountBusy;
    const ariaBusy = String(busy);
    if (this.getAttribute('aria-busy') !== ariaBusy) this.setAttribute('aria-busy', ariaBusy);
  }

  #schedule = () => {
    if (!this.#frame) this.#frame = requestAnimationFrame(this.#update);
  };

  #headerBottom() {
    let bottom = 0;
    for (const element of document.querySelectorAll('#header-group header-component[sticky], #header-group .header-section')) {
      const rect = element.getBoundingClientRect();
      if (rect.top < window.innerHeight / 2 && rect.bottom > 0) bottom = Math.max(bottom, rect.bottom);
    }
    return Math.min(bottom, window.innerHeight / 2);
  }

  #modalOpen() {
    if (document.querySelector('dialog[open], [aria-modal="true"]:not([aria-hidden="true"])')) {
      for (const element of document.querySelectorAll('dialog[open], [aria-modal="true"]:not([aria-hidden="true"])')) {
        if (element.getBoundingClientRect().height > 0) return true;
      }
    }
    try { if (document.querySelector(':popover-open')) return true; } catch { /* Older browser. */ }
    return false;
  }

  #update = () => {
    this.#frame = 0;
    if (!this.isConnected) return;
    this.#syncControls();
    const panel = this.querySelector('[data-zc-panel]');
    const primary = this.querySelector('[data-zc-main-checkout]');
    const bar = this.querySelector('[data-zc-mobile-bar]');
    if (!panel || !primary) return;
    const headerBottom = this.#headerBottom();
    const stickyTop = Math.ceil(headerBottom + 16);
    const fits = this.dataset.stickyDesktop === 'true' && window.innerWidth >= 990 && panel.getBoundingClientRect().height + stickyTop + 16 <= window.innerHeight;
    if (this.dataset.zcStickyFit !== String(fits)) this.dataset.zcStickyFit = String(fits);
    if (this.style.getPropertyValue('--zc-sticky-top') !== `${stickyTop}px`) this.style.setProperty('--zc-sticky-top', `${stickyTop}px`);
    if (!bar) return;
    const mobile = window.matchMedia('(max-width: 749px)').matches;
    const active = document.activeElement;
    const editing = active instanceof Element && active.matches('input, textarea, select, [contenteditable="true"]');
    const rect = primary.getBoundingClientRect();
    const viewportHeight = Math.min(window.innerHeight, window.visualViewport?.height || window.innerHeight);
    const offScreen = rect.bottom <= headerBottom || rect.top >= viewportHeight;
    const shouldShow = mobile && offScreen && !editing && !this.#modalOpen();
    if (bar.hidden === shouldShow) bar.hidden = !shouldShow;
    // Reserve space at the END of the whole page, not inside the recommendations.
    // Reserve it even when the bar is hidden to avoid scroll-position jumps.
    if (mobile) {
      if (!this.#spacer?.isConnected) {
        this.#spacer = document.createElement('div');
        this.#spacer.dataset.zcBottomSpacer = this.dataset.sectionId;
        this.#spacer.setAttribute('aria-hidden', 'true');
        document.body.append(this.#spacer);
      }
      const height = shouldShow ? Math.ceil(bar.getBoundingClientRect().height) + 8 : (parseInt(this.#spacer.style.height, 10) || 100);
      if (this.#spacer.style.height !== `${height}px`) this.#spacer.style.height = `${height}px`;
    } else {
      this.#spacer?.remove();
      this.#spacer = undefined;
    }
  };
}

if (!customElements.get('zootify-cart-discount')) customElements.define('zootify-cart-discount', ZootifyCartDiscount);
if (!customElements.get('zootify-cart-summary')) customElements.define('zootify-cart-summary', ZootifyCartSummary);
