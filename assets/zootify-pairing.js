import { morphSection, sectionRenderer } from '@theme/section-renderer';
import { CartUpdateEvent, ThemeEvents } from '@theme/events';

const TRANSACTION_EVENT = 'zootify:cart-transaction';
const PAIRING_SOURCE = 'zootify-pairing';
const normalize = (value) => String(value || '').trim().toLocaleLowerCase('en-US');
const familyKey = (value) => normalize(value).replace(/[–—]/g, '-').replace(/\s+/g, ' ');
const uniqueCodes = (codes) => [...new Map(codes.filter(Boolean).map((code) => [normalize(code), String(code).trim()])).values()];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function cartQueue() {
  return window.__zootifyCartQueueV1 ||= {
    tail: Promise.resolve(),
    pending: 0,
    run(task) {
      this.pending += 1;
      document.dispatchEvent(new CustomEvent(TRANSACTION_EVENT));
      const operation = this.tail.catch(() => {}).then(task);
      this.tail = operation.catch(() => {});
      return operation.finally(() => {
        this.pending -= 1;
        document.dispatchEvent(new CustomEvent(TRANSACTION_EVENT));
      });
    },
  };
}

function localURL(path, json = false) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('Invalid store URL.');
  if (json && !url.pathname.endsWith('.js')) url.pathname += '.js';
  return url;
}

async function requestJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.errors || data.status >= 400) {
      const error = new Error(data.description || data.message || 'The store could not complete this request.');
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function allCodes(cart) {
  if (!Array.isArray(cart.discount_codes)) throw new Error('The complete discount list is unavailable.');
  return uniqueCodes(cart.discount_codes.map((entry) => entry.code));
}

function eligibleUnits(cart, ids) {
  const eligible = new Set(ids.map(String));
  return (cart.items || []).reduce((quantity, item) => {
    if (!eligible.has(String(item.product_id)) || item.selling_plan_allocation || item.selling_plan) return quantity;
    return quantity + Math.max(0, Number(item.quantity) || 0);
  }, 0);
}

function ownedSaving(cart, code) {
  let saving = 0;
  for (const line of cart.items || []) {
    for (const allocation of line.line_level_discount_allocations || []) {
      if (normalize(allocation.discount_application?.title) === normalize(code)) saving += Number(allocation.amount) || 0;
    }
  }
  for (const application of cart.cart_level_discount_applications || []) {
    if (normalize(application.title) === normalize(code)) saving += Number(application.total_allocated_amount) || 0;
  }
  return saving;
}

function sectionIds(config) {
  const ids = [...document.querySelectorAll('cart-items-component[data-section-id]')].map((node) => node.dataset.sectionId);
  if (config.context === 'cart' && config.sectionId) ids.unshift(config.sectionId);
  return [...new Set(ids.filter(Boolean))].slice(0, 5);
}

function sectionsBody(config) {
  const ids = sectionIds(config);
  return ids.length ? { sections: ids, sections_url: `${window.location.pathname}${window.location.search}` } : {};
}

async function renderCart(cart, config) {
  const rendered = {};
  for (const id of sectionIds(config)) {
    if (!document.getElementById(`shopify-section-${id}`)) continue;
    let html = cart.sections?.[id];
    if (typeof html !== 'string' || !html.includes(`shopify-section-${id}`)) {
      const url = new URL(window.location.href);
      url.searchParams.set('_zp_revision', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      html = await sectionRenderer.getSectionHTML(id, false, url);
    }
    await morphSection(id, html);
    rendered[id] = html;
  }
  cart.sections = { ...cart.sections, ...rendered };
  document.dispatchEvent(new CartUpdateEvent(cart, config.sectionId || PAIRING_SOURCE, {
    itemCount: cart.item_count, source: PAIRING_SOURCE, sections: cart.sections, sectionsRendered: true,
  }));
  await nextFrame();
}

function actualOptions(product) {
  return (product.options || []).map((option, index) => ({
    name: typeof option === 'string' ? option : option.name,
    position: index,
    values: [...new Set((typeof option === 'object' && option.values?.length ? option.values :
      (product.variants || []).map((variant) => (variant.options || [variant.option1, variant.option2, variant.option3])[index]))
      .map((value) => typeof value === 'object' ? value.name : value).filter((value) => value != null))],
  }));
}

function optionsOf(variant) {
  return variant.options || [variant.option1, variant.option2, variant.option3].filter((value) => value != null);
}

function selectedVariant(product, choices) {
  return (product.variants || []).find((variant) => optionsOf(variant).every((value, index) => value === choices[index]));
}

function modelSibling(catalog, current, model) {
  const family = familyKey(current.family);
  if (!family) return undefined;
  const matches = catalog.filter((record) => familyKey(record.family) === family && normalize(record.model) === normalize(model));
  return matches.find((record) => normalize(record.color) === normalize(current.color) && record.available !== false)
    || matches.find((record) => record.available !== false)
    || matches.find((record) => normalize(record.color) === normalize(current.color))
    || matches[0];
}

class PairingController {
  instances = new Set();
  config;
  cart;
  scheduled = false;
  signature = '';
  uncertain = false;

  constructor() {
    document.addEventListener(ThemeEvents.cartUpdate, (event) => {
      if (event.detail?.data?.source !== PAIRING_SOURCE) this.schedule();
    });
    document.addEventListener(ThemeEvents.discountUpdate, () => this.schedule());
    document.addEventListener(TRANSACTION_EVENT, () => {
      for (const instance of this.instances) instance.syncBusy();
    });
    window.addEventListener('pageshow', (event) => { if (event.persisted) this.schedule(); });
  }

  register(instance) {
    this.instances.add(instance);
    this.config = instance.config;
    const signature = JSON.stringify([this.config.campaignEnabled, this.config.discountCode, this.config.eligibleProductIds]);
    const changed = signature !== this.signature;
    this.signature = signature;
    if (this.cart && !cartQueue().pending) instance.paintCart(this.cart);
    instance.syncBusy();
    if (changed || !this.cart) this.schedule();
  }

  schedule() {
    if (this.scheduled || !this.config || !this.instances.size) return;
    this.scheduled = true;
    cartQueue().run(async () => {
      try {
        const config = this.config;
        const cart = await requestJSON(localURL(config.cartUrl, true));
        const result = await this.reconcile(cart, config);
        if (result.changed) await renderCart(result.cart, config);
        this.publish(result.cart);
      } catch (error) {
        for (const instance of this.instances) instance.setStatus(instance.string('discountError', 'We could not confirm the offer. Check the final total before checkout.'), 'error');
        console.warn('[ZOOTIFY pairing] Offer could not be confirmed.', error);
      } finally {
        this.scheduled = false;
      }
    });
  }

  publish(cart) {
    this.cart = cart;
    for (const instance of this.instances) instance.paintCart(cart);
  }

  async reconcile(cart, config) {
    const code = String(config.discountCode || '').trim();
    if (!code) return { cart, changed: false };
    const existing = allCodes(cart);
    const present = existing.some((value) => normalize(value) === normalize(code));
    const wanted = Boolean(config.campaignEnabled) && eligibleUnits(cart, config.eligibleProductIds || []) >= 2;
    if (present === wanted) return { cart, changed: false };
    const desired = existing.filter((value) => normalize(value) !== normalize(code));
    if (wanted) desired.push(code);
    for (const instance of this.instances) instance.setStatus(instance.string('discountApplying', 'Updating your offer…'));
    try {
      const updated = await requestJSON(localURL(config.updateUrl, true), {
        method: 'POST', body: JSON.stringify({ discount: desired.join(','), ...sectionsBody(config) }),
      });
      return { cart: updated, changed: true };
    } catch (error) {
      const current = await requestJSON(localURL(config.cartUrl, true));
      const nowPresent = allCodes(current).some((value) => normalize(value) === normalize(code));
      if (nowPresent !== wanted) throw error;
      return { cart: current, changed: true };
    }
  }

  async add(instance, variant) {
    if (cartQueue().pending || this.uncertain) return;
    const config = instance.config;
    const sectionId = config.sectionId;
    let added = false;
    let message = '';
    let tone = 'info';
    instance.closeDialog();
    await cartQueue().run(async () => {
      try {
        const before = await requestJSON(localURL(config.cartUrl, true));
        const quantityBefore = (before.items || []).filter((line) => String(line.variant_id) === String(variant.id)).reduce((sum, line) => sum + line.quantity, 0);
        let response;
        let additionError;
        try {
          response = await requestJSON(localURL(config.addUrl, true), {
            method: 'POST', body: JSON.stringify({ items: [{ id: variant.id, quantity: 1 }], ...sectionsBody(config) }),
          });
        } catch (error) {
          additionError = error;
        }
        const returnedItems = response?.items || (response?.id ? [response] : []);
        added = returnedItems.some((line) => String(line.variant_id || line.id) === String(variant.id) && Number(line.quantity) > 0);
        let current;
        try {
          current = await requestJSON(localURL(config.cartUrl, true));
          const quantityAfter = (current.items || []).filter((line) => String(line.variant_id) === String(variant.id)).reduce((sum, line) => sum + line.quantity, 0);
          added ||= quantityAfter > quantityBefore;
        } catch (error) {
          if (!added) this.uncertain = true;
          if (!added) throw error;
        }
        if (!added) {
          if (!additionError || !(additionError.status >= 400 && additionError.status < 500)) this.uncertain = true;
          if (current) {
            this.publish(current);
            if (config.context === 'cart') await renderCart(current, config);
          }
          throw additionError || new Error('The addition could not be confirmed.');
        }
        if (config.context === 'product') {
          const target = localURL(config.cartUrl);
          const currentURL = new URL(window.location.href);
          for (const key of ['preview_theme_id', '_fd', 'pb']) {
            if (currentURL.searchParams.has(key)) target.searchParams.set(key, currentURL.searchParams.get(key));
          }
          window.location.assign(target.toString());
          return;
        }
        if (!current) throw new Error('The product was added, but the refreshed cart is unavailable.');
        let reconciled;
        try {
          reconciled = await this.reconcile(current, config);
        } catch (error) {
          await renderCart(current, config);
          this.publish(current);
          message = `${instance.string('added', 'Added to your cart.')} ${instance.string('discountError', 'The pair offer could not be applied.')}`;
          tone = 'error';
          console.warn('[ZOOTIFY pairing] Added; offer confirmation failed.', error);
          return;
        }
        if (!reconciled.changed && response?.sections) reconciled.cart.sections = response.sections;
        await renderCart(reconciled.cart, config);
        this.publish(reconciled.cart);
        message = instance.string('added', 'Added to your cart.');
      } catch (error) {
        message = this.uncertain
          ? instance.string('uncertain', 'We could not confirm whether this was added. Refresh your cart before adding again.')
          : (added ? `${instance.string('added', 'Added to your cart.')} ${instance.string('uncertain', 'Refresh your cart before adding again.')}` : instance.string('addError', 'This item could not be added. Please check availability and try again.'));
        tone = 'error';
        console.warn('[ZOOTIFY pairing] Cart addition could not be completed.', error);
      }
    });
    for (const current of this.instances) {
      if (current.config.sectionId === sectionId) {
        current.setStatus(message, tone);
        current.syncBusy();
        if (message) current.focusStatus();
      }
    }
  }
}

const controller = window.__zootifyPairingControllerV1 ||= new PairingController();
const COLOR_VALUES = {
  black: '#181818', white: '#f9f9f7', silver: '#c5c8cd', gray: '#84868b', grey: '#84868b',
  blue: '#466aa7', navy: '#263858', red: '#bc3d40', pink: '#dfb5c5', purple: '#8771a7',
  green: '#667c62', olive: '#75775a', orange: '#d98547', yellow: '#e1c368', gold: '#c5ac70',
  brown: '#816451', beige: '#d5c8b4', clear: 'transparent', transparent: 'transparent',
};

class ZootifyPairing extends HTMLElement {
  config = {};
  #raw = '';
  #observer;
  #observerFrame = 0;
  #abort;
  #record;
  #knownRecords = new Map();
  #product;
  #variant;
  #options = [];
  #choices = [];
  #loadVersion = 0;
  #loading = false;
  #adding = false;
  #trigger;
  #imageIndex = 0;
  #images = [];

  connectedCallback() {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.addEventListener('click', this.#onClick, { signal });
    this.addEventListener('change', this.#onChange, { signal });
    this.addEventListener('submit', this.#onSubmit, { signal });
    this.addEventListener('close', this.#onClose, { capture: true, signal });
    this.#readConfig();
    this.#observer = new MutationObserver((records) => {
      const changed = records.some((record) => record.target.closest?.('[data-zp-config]') || record.target.parentElement?.closest('[data-zp-config]') || [...record.addedNodes].some((node) => node instanceof Element && (node.matches('[data-zp-config]') || node.querySelector('[data-zp-config]'))));
      if (changed && !this.#observerFrame) this.#observerFrame = requestAnimationFrame(() => {
        this.#observerFrame = 0;
        this.#readConfig();
      });
    });
    this.#observer.observe(this, { childList: true, subtree: true, characterData: true });
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#observer?.disconnect();
    cancelAnimationFrame(this.#observerFrame);
    this.#observerFrame = 0;
    this.#loadVersion += 1;
    this.closeDialog();
    controller.instances.delete(this);
  }

  #readConfig() {
    const raw = this.querySelector('[data-zp-config]')?.textContent || '';
    if (!raw) return;
    try {
      if (raw !== this.#raw) {
        this.config = JSON.parse(raw);
        this.config.catalog ||= [];
        this.config.eligibleProductIds ||= [];
        this.#raw = raw;
      }
      controller.register(this);
    } catch (error) {
      console.warn('[ZOOTIFY pairing] Invalid configuration.', error);
    }
  }

  string(key, fallback) { return this.config.strings?.[key] || fallback; }

  setStatus(message, state = 'info') {
    const status = this.querySelector('[data-zp-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  focusStatus() {
    const status = this.querySelector('[data-zp-status]');
    if (!status || status.hidden) return;
    status.setAttribute('tabindex', '-1');
    status.focus({ preventScroll: true });
  }

  paintCart(cart) {
    const units = eligibleUnits(cart, this.config.eligibleProductIds);
    const applied = Boolean(this.config.campaignEnabled) && units >= 2 && ownedSaving(cart, this.config.discountCode) > 0;
    this.dataset.zpState = !units ? 'empty' : units === 1 ? 'one' : applied ? 'applied' : 'ready';
    const state = this.querySelector('[data-zp-discount-state]');
    if (state) {
      const text = !this.config.campaignEnabled ? '' : applied
        ? this.string('saved', 'You saved __amount__ on your cases.').replace('__amount__', this.#money(ownedSaving(cart, this.config.discountCode)))
        : units === 1 ? this.string('oneMore', 'Add one more case to get 20% off your cases.')
        : units >= 2 ? this.string('discountReady', 'Your best eligible discount is reflected in the total.')
        : this.string('offerMessage', 'Buy any 2 cases. Get 20% off your cases.');
      const copy = state.querySelector('.zp-cart-notice__text') || state;
      copy.textContent = text;
      const heading = state.querySelector('[data-zo-cart-heading]');
      if (heading) {
        heading.textContent = !units ? this.string('cartHeadingEmpty', 'Double up. Save 20%.')
          : units === 1 ? this.string('cartHeadingOne', 'One more case. 20% off.')
          : applied ? this.string('cartHeadingApplied', 'Your 20% saving is applied.')
          : this.string('cartHeadingReady', 'Your cases qualify.');
      }
      for (const step of state.querySelectorAll('[data-zo-step]')) {
        const complete = step.dataset.zoStep === '1' ? units >= 1 : step.dataset.zoStep === '2' && applied;
        const pending = step.dataset.zoStep === '2' && units >= 2 && !applied;
        step.classList.toggle('is-complete', complete);
        step.classList.toggle('is-pending', pending);
        step.setAttribute('aria-hidden', 'true');
      }
      state.dataset.state = this.dataset.zpState;
      state.hidden = !text;
    }
    this.setStatus('');
    this.syncBusy();
  }

  syncBusy() {
    const busy = cartQueue().pending > 0 || this.#adding;
    this.setAttribute('aria-busy', String(busy));
    for (const button of this.querySelectorAll('[data-zp-open]')) button.disabled = busy || controller.uncertain;
    const add = this.querySelector('[data-zp-add]');
    if (add) {
      add.disabled = busy || this.#loading || !this.#variant?.available || controller.uncertain;
      add.setAttribute('aria-busy', String(this.#adding));
      add.textContent = this.#adding ? this.string('adding', 'Adding…') : this.string('addToCart', 'Add to cart');
    }
  }

  #onClose = (event) => {
    if (event.target !== this.querySelector('[data-zp-dialog]')) return;
    this.#loadVersion += 1;
    if (this.#trigger?.isConnected) this.#trigger.focus({ preventScroll: true });
  };

  closeDialog() {
    const dialog = this.querySelector('[data-zp-dialog]');
    if (dialog?.open) dialog.close();
  }

  #onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const dialog = this.querySelector('[data-zp-dialog]');
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.closeDialog();
      return;
    }
    const open = event.target.closest('[data-zp-open]');
    if (open && this.contains(open)) {
      event.preventDefault();
      if (cartQueue().pending || controller.uncertain) return;
      const row = open.closest('[data-zp-row]');
      try {
        const record = JSON.parse(row?.dataset.zpProduct || '{}');
        if (!record.handle || !record.id) throw new Error('Product choice is unavailable.');
        this.#knownRecords = new Map(this.config.catalog.map((item) => [String(item.id), item]));
        for (const item of [...(record.linkedColors || []), record]) {
          this.#knownRecords.set(String(item.id), { ...this.#knownRecords.get(String(item.id)), ...item });
        }
        this.#trigger = open;
        const dialog = this.querySelector('[data-zp-dialog]');
        if (!dialog) return;
        this.#loadProduct(record);
        if (!dialog.open) dialog.showModal();
      } catch {
        this.setStatus(this.string('loadError', 'This product could not be loaded. Please open its product page.'), 'error');
      }
      return;
    }
    if (event.target.closest('[data-zp-close]')) { event.preventDefault(); this.closeDialog(); return; }
    if (event.target.closest('[data-zp-prev]')) { this.#showImage(this.#imageIndex - 1); return; }
    if (event.target.closest('[data-zp-next]')) { this.#showImage(this.#imageIndex + 1); return; }
    const dot = event.target.closest('[data-zp-image-index]');
    if (dot) { this.#showImage(Number(dot.dataset.zpImageIndex)); return; }
    const linked = event.target.closest('[data-zp-color-product]');
    if (linked) {
      const record = this.#linkedColors().find((item) => String(item.id) === linked.dataset.zpColorProduct);
      if (record && !this.#loading) this.#loadProduct(record);
      return;
    }
    const color = event.target.closest('[data-zp-color-option]');
    if (color && !this.#loading) {
      this.#choices[Number(color.dataset.zpColorOption)] = color.dataset.zpColorValue;
      this.#updateVariant();
    }
  };

  #onChange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-zp-model]')) {
      const record = modelSibling(this.config.catalog, this.#record, target.value);
      if (record) this.#loadProduct(record);
    } else if (target.matches('[data-zp-option-index]')) {
      this.#choices[Number(target.dataset.zpOptionIndex)] = target.value;
      this.#updateVariant();
    }
  };

  #onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.matches('[data-zp-form]')) return;
    event.preventDefault();
    event.stopPropagation();
    const summary = document.querySelector('zootify-cart-summary');
    if (this.#adding || this.#loading || cartQueue().pending || summary?.isBusy || !this.#variant?.available || controller.uncertain) return;
    this.#adding = true;
    this.syncBusy();
    try { await controller.add(this, this.#variant); }
    finally { this.#adding = false; if (this.isConnected) this.syncBusy(); }
  };

  #error(message = '') {
    const error = this.querySelector('[data-zp-error]');
    if (error) { error.textContent = message; error.hidden = !message; error.dataset.state = 'error'; }
  }

  #money(amount) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
        style: 'currency', currency: this.config.currency || window.Shopify?.currency?.active || 'USD',
      }).format(Number(amount) / 100);
    } catch { return `${(Number(amount) / 100).toFixed(2)} ${this.config.currency || 'USD'}`; }
  }

  async #loadProduct(record) {
    const version = ++this.#loadVersion;
    this.#loading = true;
    this.#record = { ...this.#knownRecords.get(String(record.id)), ...record };
    this.#product = undefined;
    this.#variant = undefined;
    this.#choices = [];
    this.#error('');
    const dialog = this.querySelector('[data-zp-dialog]');
    dialog?.setAttribute('aria-busy', 'true');
    if (dialog) dialog.dataset.loading = 'true';
    const title = this.querySelector('[data-zp-title]');
    if (title) title.textContent = record.title || this.string('loading', 'Loading product…');
    const price = this.querySelector('[data-zp-price]');
    if (price) price.textContent = '';
    const fullLink = this.querySelector('[data-zp-full-link]');
    if (fullLink) fullLink.href = localURL(record.url || `${window.Shopify?.routes?.root || '/'}products/${encodeURIComponent(record.handle)}`).toString();
    this.querySelector('[data-zp-gallery]')?.replaceChildren();
    this.querySelector('[data-zp-dots]')?.replaceChildren();
    this.#images = [];
    this.#showImage(0);
    this.querySelector('[data-zp-options]')?.replaceChildren();
    this.querySelector('[data-zp-colors]')?.replaceChildren();
    this.#renderModels();
    for (const select of this.querySelectorAll('[data-zp-model], [data-zp-option-index]')) select.disabled = true;
    this.syncBusy();
    try {
      const root = window.Shopify?.routes?.root || '/';
      const product = await requestJSON(localURL(`${root}products/${encodeURIComponent(record.handle)}.js`));
      if (version !== this.#loadVersion || !this.isConnected) return;
      if (String(product.id) !== String(record.id) || !Array.isArray(product.variants)) throw new Error('Unexpected product data.');
      this.#product = product;
      this.#options = actualOptions(product);
      this.#variant = product.variants.find((variant) => variant.available) || product.variants[0];
      this.#choices = this.#variant ? [...optionsOf(this.#variant)] : [];
      if (title) title.textContent = product.title;
      this.#renderGallery();
      this.#renderOptions();
      this.#renderColors();
      this.#updateVariant();
    } catch (error) {
      if (version !== this.#loadVersion || !this.isConnected) return;
      this.#error(this.string('loadError', 'This product could not be loaded. Please open its product page.'));
      console.warn('[ZOOTIFY pairing] Product could not be loaded.', error);
    } finally {
      if (version === this.#loadVersion && this.isConnected) {
        this.#loading = false;
        dialog?.setAttribute('aria-busy', 'false');
        if (dialog) dialog.dataset.loading = 'false';
        for (const select of this.querySelectorAll('[data-zp-model], [data-zp-option-index]')) select.disabled = false;
        this.syncBusy();
      }
    }
  }

  #renderModels() {
    const wrap = this.querySelector('[data-zp-model-wrap]');
    const select = this.querySelector('[data-zp-model]');
    if (!wrap || !select) return;
    const family = familyKey(this.#record.family);
    const models = [...new Map(this.config.catalog.filter((record) => family && familyKey(record.family) === family && record.model)
      .map((record) => [normalize(record.model), record.model])).values()];
    if (this.#record.model && !models.some((model) => normalize(model) === normalize(this.#record.model))) models.unshift(this.#record.model);
    const modelOrder = new Intl.Collator(document.documentElement.lang || 'en-US', { numeric: true, sensitivity: 'base' });
    models.sort((left, right) => modelOrder.compare(right, left));
    select.replaceChildren(...models.map((model) => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      option.selected = normalize(model) === normalize(this.#record.model);
      return option;
    }));
    wrap.hidden = !family || !models.length;
  }

  #renderOptions() {
    const container = this.querySelector('[data-zp-options]');
    if (!container) return;
    container.replaceChildren();
    for (const option of this.#options) {
      if (/^colou?r$/i.test(option.name) && option.values.length > 1) continue;
      if (option.values.length === 1 && option.values[0] === 'Default Title') continue;
      const label = document.createElement('label');
      label.className = 'zp-field';
      const name = document.createElement('span');
      name.className = 'zp-label';
      name.textContent = option.name;
      const select = document.createElement('select');
      select.className = 'zp-select';
      select.dataset.zpOptionIndex = option.position;
      select.setAttribute('aria-label', option.name);
      select.append(...option.values.map((value) => {
        const choice = document.createElement('option');
        choice.value = value;
        choice.textContent = value;
        choice.selected = this.#choices[option.position] === value;
        return choice;
      }));
      label.append(name, select);
      container.append(label);
    }
  }

  #linkedColors() {
    if (!this.#record) return [];
    const records = [...(this.#record.linkedColors || []), ...(this.#record.linkedColorIds || []).map((id) => this.#knownRecords.get(String(id))).filter(Boolean), this.#record];
    return [...new Map(records.filter((record) => record.handle && record.color
      && (!record.model || !this.#record.model || normalize(record.model) === normalize(this.#record.model)))
      .map((record) => [String(record.id), record])).values()];
  }

  #swatch(value, storedColor) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zp-swatch';
    button.setAttribute('aria-label', value);
    button.title = value;
    const chip = document.createElement('span');
    chip.className = 'zp-swatch__color';
    chip.setAttribute('aria-hidden', 'true');
    const color = typeof storedColor === 'string' && CSS.supports('color', storedColor) ? storedColor : COLOR_VALUES[normalize(value)];
    if (color) chip.style.setProperty('--zp-swatch-color', color);
    else { chip.textContent = String(value).slice(0, 2); chip.classList.add('zp-swatch__color--text'); }
    button.append(chip);
    return button;
  }

  #renderColors() {
    const wrap = this.querySelector('[data-zp-color-wrap]');
    const colors = this.querySelector('[data-zp-colors]');
    if (!wrap || !colors) return;
    colors.replaceChildren();
    const option = this.#options.find((option) => /^colou?r$/i.test(option.name) && option.values.length > 1);
    if (option) {
      for (const value of option.values) {
        const button = this.#swatch(value);
        button.dataset.zpColorOption = option.position;
        button.dataset.zpColorValue = value;
        button.setAttribute('aria-pressed', String(this.#choices[option.position] === value));
        colors.append(button);
      }
    } else {
      const records = this.#linkedColors();
      for (const record of records) {
        const button = this.#swatch(record.color, record.colorCode);
        button.dataset.zpColorProduct = record.id;
        button.setAttribute('aria-pressed', String(String(record.id) === String(this.#record.id)));
        colors.append(button);
      }
    }
    wrap.hidden = colors.childElementCount < 2;
  }

  #updateVariant() {
    if (!this.#product) return;
    this.#variant = selectedVariant(this.#product, this.#choices);
    const price = this.querySelector('[data-zp-price]');
    if (price) price.textContent = this.#variant ? this.#money(this.#variant.price) : '';
    const link = this.querySelector('[data-zp-full-link]');
    if (link) {
      const url = localURL(this.#record.url || `${window.Shopify?.routes?.root || '/'}products/${encodeURIComponent(this.#record.handle)}`);
      if (this.#variant?.id) url.searchParams.set('variant', this.#variant.id);
      link.href = url.toString();
    }
    for (const button of this.querySelectorAll('[data-zp-color-option]')) {
      button.setAttribute('aria-pressed', String(this.#choices[Number(button.dataset.zpColorOption)] === button.dataset.zpColorValue));
    }
    this.#error(this.#variant?.available ? '' : this.string('variantUnavailable', 'This option is unavailable. Please choose another option.'));
    const featured = this.#variant?.featured_image?.src || this.#variant?.featured_image;
    if (typeof featured === 'string') {
      const index = this.#images.findIndex((src) => src.split('?')[0] === featured.split('?')[0]);
      if (index >= 0) this.#showImage(index);
    }
    this.syncBusy();
  }

  #renderGallery() {
    const gallery = this.querySelector('[data-zp-gallery]');
    const dots = this.querySelector('[data-zp-dots]');
    if (!gallery || !dots) return;
    this.#images = (this.#product.images || []).map((image) => typeof image === 'string' ? image : image.src).filter(Boolean);
    gallery.classList.add('zp-gallery__track');
    gallery.replaceChildren(...this.#images.map((src, index) => {
      const image = document.createElement('img');
      image.className = 'zp-gallery__image';
      image.dataset.zpModalImage = '';
      image.src = src;
      image.alt = `${this.#product.title} — ${index + 1}`;
      image.loading = index ? 'lazy' : 'eager';
      image.decoding = 'async';
      image.hidden = index !== 0;
      return image;
    }));
    dots.replaceChildren(...this.#images.map((_, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'zp-gallery__dot';
      button.dataset.zpImageIndex = index;
      button.setAttribute('aria-label', this.string('imageOf', 'Image __current__ of __total__').replace('__current__', index + 1).replace('__total__', this.#images.length));
      return button;
    }));
    this.#showImage(0);
  }

  #showImage(index) {
    const count = this.#images.length;
    this.#imageIndex = count ? ((index % count) + count) % count : 0;
    [...this.querySelectorAll('[data-zp-modal-image]')].forEach((image, position) => { image.hidden = position !== this.#imageIndex; });
    [...this.querySelectorAll('[data-zp-image-index]')].forEach((dot, position) => dot.setAttribute('aria-current', String(position === this.#imageIndex)));
    for (const control of this.querySelectorAll('[data-zp-prev], [data-zp-next], [data-zp-dots]')) control.hidden = count < 2;
  }
}

if (!customElements.get('zootify-pairing')) customElements.define('zootify-pairing', ZootifyPairing);
