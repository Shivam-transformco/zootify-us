import { morphSection, sectionRenderer } from '@theme/section-renderer';
import { CartUpdateEvent, ThemeEvents } from '@theme/events';

let mutationInProgress = false;
const uncertainSections = new Set();
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cart rendering timed out.')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cartEndpoint(path) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('Invalid cart endpoint.');
  if (!url.pathname.endsWith('.js')) url.pathname += '.js';
  return url.toString();
}

async function requestJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.errors || Number(data.status) >= 400) {
      const error = new Error('Cart request rejected.');
      error.status = response.status;
      error.rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function variantQuantity(cart, variantId) {
  return (cart?.items || []).reduce((quantity, item) => {
    return quantity + (String(item.variant_id ?? item.id) === variantId ? Number(item.quantity) || 0 : 0);
  }, 0);
}

class ZootifyCaseOffer extends HTMLElement {
  #products = [];
  #strings = {};
  #model = '';
  #variant = '';
  #busy = false;
  #abort;
  #frame = 0;
  #observer = new MutationObserver((records) => {
    const selectors = '[data-zb-config], [data-zb-model], [data-zb-product]';
    const changed = records.some((record) => {
      if (record.target instanceof Element && record.target.matches(selectors)) return true;
      if (record.target.parentElement?.matches('[data-zb-config]')) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => {
        return node instanceof Element && (node.matches(selectors) || node.querySelector(selectors));
      });
    });
    if (changed) this.#onCartUpdate();
  });

  connectedCallback() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    this.addEventListener('change', this.#onChange, { signal });
    this.addEventListener('submit', this.#onSubmit, { signal });
    document.addEventListener(ThemeEvents.cartUpdate, this.#onCartUpdate, { signal });
    this.#configure();
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#observer.disconnect();
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #observe() {
    if (this.isConnected) this.#observer.observe(this, { childList: true, subtree: true, characterData: true });
  }

  #copy(key) {
    return typeof this.#strings[key] === 'string' ? this.#strings[key] : '';
  }

  #selectedProduct() {
    return this.#products.find((product) => product.id === this.#variant && product.model === this.#model && product.available);
  }

  #summary() {
    return this.closest('cart-items-component')?.querySelector('zootify-cart-summary');
  }

  #configure() {
    this.#observer.disconnect();
    const form = this.querySelector('[data-zb-form]');
    const modelSelect = this.querySelector('[data-zb-model]');
    if (!form || !modelSelect) {
      this.#observe();
      return;
    }
    try {
      const config = JSON.parse(this.querySelector('[data-zb-config]')?.textContent || '{}');
      if (!Array.isArray(config.products) || !config.strings) throw new Error('Missing picker configuration.');
      this.#products = [...new Map(config.products.filter((product) => {
        return /^\d+$/.test(String(product.id)) && typeof product.model === 'string' && product.model;
      }).map((product) => [String(product.id), { ...product, id: String(product.id), available: product.available === true }])).values()];
      this.#strings = config.strings;
      form.hidden = false;
      const models = [...new Set(this.#products.map((product) => product.model))];
      const options = [this.#placeholder(this.#copy('chooseModel'))];
      for (const model of models) {
        const option = new Option(model, model);
        option.disabled = !this.#products.some((product) => product.model === model && product.available);
        options.push(option);
      }
      if (!this.#products.some((product) => product.model === this.#model && product.available)) {
        this.#model = '';
        this.#variant = '';
      }
      modelSelect.replaceChildren(...options);
      modelSelect.value = this.#model;
      this.#populateCases();
      this.#paintPreview();
      this.#syncControls();
      if (uncertainSections.has(this.dataset.sectionId)) this.#setStatus(this.#copy('uncertain'), 'error');
    } catch {
      form.hidden = true;
    } finally {
      this.#observe();
    }
  }

  #placeholder(label) {
    const option = new Option(label, '', true, true);
    option.disabled = true;
    return option;
  }

  #populateCases() {
    const select = this.querySelector('[data-zb-product]');
    if (!select) return;
    const products = this.#products.filter((product) => product.model === this.#model);
    const options = [this.#placeholder(this.#copy('chooseCase'))];
    for (const product of products) {
      const label = product.label || product.title;
      const option = new Option(product.available ? label : `${label} — ${this.#copy('unavailable')}`, product.id);
      option.disabled = !product.available;
      options.push(option);
    }
    if (!products.some((product) => product.id === this.#variant && product.available)) this.#variant = '';
    select.replaceChildren(...options);
    select.value = this.#variant;
  }

  #paintPreview() {
    const preview = this.querySelector('[data-zb-preview]');
    if (!preview) return;
    const product = this.#selectedProduct();
    preview.hidden = !product;
    if (!product) return;
    const image = preview.querySelector('[data-zb-image]');
    const title = preview.querySelector('[data-zb-title]');
    const price = preview.querySelector('[data-zb-price]');
    if (image) {
      image.hidden = !product.image;
      if (product.image) image.src = product.image;
      image.alt = product.title;
    }
    if (title) {
      title.textContent = product.title;
      title.href = product.url;
    }
    if (price) price.textContent = product.price;
  }

  #syncControls() {
    const busy = this.#busy || mutationInProgress;
    const blocked = busy || uncertainSections.has(this.dataset.sectionId);
    const model = this.querySelector('[data-zb-model]');
    const product = this.querySelector('[data-zb-product]');
    const button = this.querySelector('[data-zb-add]');
    if (model) model.disabled = blocked || !this.#products.some((item) => item.available);
    if (product) product.disabled = blocked || !this.#products.some((item) => item.model === this.#model && item.available);
    if (button) {
      button.disabled = blocked || !this.#selectedProduct();
      button.textContent = this.#copy(busy ? 'adding' : 'addCase');
    }
    this.setAttribute('aria-busy', String(busy));
  }

  #setStatus(message, tone = 'info', focus = false) {
    const status = this.querySelector('[data-zb-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
    if (focus && message) {
      const picker = this.querySelector('[data-zb-picker]');
      if (picker) picker.open = true;
      status.tabIndex = -1;
      status.focus({ preventScroll: true });
    }
  }

  #onChange = (event) => {
    if (!(event.target instanceof HTMLSelectElement) || mutationInProgress) return;
    if (event.target.matches('[data-zb-model]')) {
      this.#model = event.target.value;
      this.#variant = '';
      this.#populateCases();
    } else if (event.target.matches('[data-zb-product]')) {
      this.#variant = event.target.value;
    } else return;
    this.#paintPreview();
    this.#syncControls();
    if (!uncertainSections.has(this.dataset.sectionId)) this.#setStatus('');
  };

  #onCartUpdate = () => {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      if (this.isConnected) this.#configure();
    });
  };

  #onSubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.matches('[data-zb-form]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.#busy || mutationInProgress || uncertainSections.has(this.dataset.sectionId)) return;
    if (this.#summary()?.isBusy || this.closest('cart-items-component')?.classList.contains('cart-items-disabled')) {
      this.#setStatus(this.#copy('busy'));
      return;
    }
    const product = this.#selectedProduct();
    if (!product || !event.target.reportValidity()) return;
    this.#addCase(product);
  };

  async #readCart() {
    const cart = await requestJSON(cartEndpoint(this.dataset.cartJsonUrl || this.dataset.cartUrl));
    if (!Array.isArray(cart.items) || !Number.isFinite(Number(cart.item_count))) throw new Error('Invalid cart response.');
    return cart;
  }

  async #renderCart(cart, sections, sectionId) {
    let html = sections?.[sectionId];
    if (typeof html !== 'string' || !html.includes(`shopify-section-${sectionId}`)) {
      html = await withTimeout(sectionRenderer.getSectionHTML(sectionId, false));
    }
    const fragment = new DOMParser().parseFromString(html, 'text/html');
    const renderedSection = fragment.getElementById(`shopify-section-${sectionId}`);
    if (!renderedSection) throw new Error('Cart section missing.');
    const renderedCount = renderedSection.querySelector('[ref="cartItemCount"]')?.textContent?.trim();
    const count = cart?.item_count ?? (renderedCount ? Number(renderedCount) : null);
    if (!Number.isFinite(Number(count)) || count === null) throw new Error('Cart count missing.');
    await morphSection(sectionId, html);
    const currentItems = document.getElementById(`shopify-section-${sectionId}`)?.querySelector('cart-items-component');
    currentItems?.querySelector('zootify-cart-summary')?.setDiscountBusy?.(true);
    (currentItems || document).dispatchEvent(new CartUpdateEvent(cart, sectionId, {
      itemCount: Number(count),
      source: 'zootify-case-offer',
      sections: { ...sections, [sectionId]: html },
    }));
    await nextFrame();
  }

  async #addCase(product) {
    const sectionId = this.dataset.sectionId;
    if (!sectionId || !this.id || !this.dataset.addUrl) return;
    const componentId = this.id;
    const oldSummary = this.#summary();
    const oldArea = this.closest('.cart-page__items');
    const oldInert = Boolean(oldArea?.inert);
    const sectionIds = [...new Set([sectionId, ...[...document.querySelectorAll('cart-items-component[data-section-id]')].map((node) => node.dataset.sectionId)])].slice(0, 5);
    let attempted = false;
    let messageKey = 'error';
    let tone = 'error';
    mutationInProgress = true;
    this.#busy = true;
    oldSummary?.setDiscountBusy?.(true);
    if (oldArea) oldArea.inert = true;
    this.#syncControls();
    this.#setStatus(this.#copy('adding'));
    try {
      const before = await this.#readCart();
      let result;
      let failure;
      let current;
      attempted = true;
      try {
        result = await requestJSON(cartEndpoint(this.dataset.addUrl), {
          method: 'POST',
          body: JSON.stringify({
            items: [{ id: product.id, quantity: 1 }],
            sections: sectionIds,
            sections_url: `${window.location.pathname}${window.location.search}`,
          }),
        });
      } catch (error) {
        failure = error;
      }
      try {
        current = await this.#readCart();
      } catch {}
      const addedItems = Array.isArray(result?.items) ? result.items : result ? [result] : [];
      const accepted = addedItems.some((item) => String(item.variant_id ?? item.id) === product.id && Number(item.quantity) > 0);
      const confirmed = accepted || (current && variantQuantity(current, product.id) > variantQuantity(before, product.id));
      if (confirmed) {
        messageKey = 'added';
        tone = 'success';
        this.#model = '';
        this.#variant = '';
      } else if (failure?.rejected && current) {
        messageKey = failure.status === 422 ? 'unavailable' : 'error';
      } else {
        messageKey = 'uncertain';
        uncertainSections.add(sectionId);
      }
      await this.#renderCart(current, result?.sections || {}, sectionId);
    } catch {
      if (attempted) {
        uncertainSections.add(sectionId);
        messageKey = 'uncertain';
      }
      tone = 'error';
    } finally {
      mutationInProgress = false;
      this.#busy = false;
      oldSummary?.setDiscountBusy?.(false);
      const active = document.getElementById(componentId);
      active?.closest('cart-items-component')?.querySelector('zootify-cart-summary')?.setDiscountBusy?.(false);
      if (oldArea) oldArea.inert = oldInert;
      const currentArea = active?.closest('.cart-page__items');
      if (currentArea && currentArea !== oldArea) currentArea.inert = false;
      if (active instanceof ZootifyCaseOffer) {
        if (messageKey === 'added') {
          active.#model = '';
          active.#variant = '';
        }
        active.#busy = false;
        active.#configure();
        active.#setStatus(active.#copy(messageKey), tone, true);
      }
    }
  }
}

if (!customElements.get('zootify-case-offer')) customElements.define('zootify-case-offer', ZootifyCaseOffer);
