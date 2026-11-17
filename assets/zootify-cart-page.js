import { morphSection, sectionRenderer } from '@theme/section-renderer';
import { CartUpdateEvent, ThemeEvents } from '@theme/events';

/** ZOOTIFY cart-only enhancements. Payable totals always come from Shopify. */
const normalizeCode = (code) => String(code || '').trim().toLocaleLowerCase('en-US');
const uniqueCodes = (codes) => [...new Map(codes.filter(Boolean).map((code) => [normalizeCode(code), String(code).trim()])).values()];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function zootifyCartQueue() {
  return window.__zootifyCartQueueV1 ||= {
    tail: Promise.resolve(), pending: 0,
    run(task) {
      this.pending += 1;
      document.dispatchEvent(new CustomEvent('zootify:cart-transaction'));
      const operation = this.tail.catch(() => {}).then(task);
      this.tail = operation.catch(() => {});
      return operation.finally(() => {
        this.pending -= 1;
        document.dispatchEvent(new CustomEvent('zootify:cart-transaction'));
      });
    },
  };
}

function pairingCode() {
  const configured = window.__zootifyPairingControllerV1?.config?.discountCode;
  if (configured) return configured;
  try { return JSON.parse(document.querySelector('zootify-pairing [data-zp-config]')?.textContent || '{}').discountCode || ''; }
  catch { return ''; }
}

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

/** UI shows applicable codes; mutations retain every entered code, including inactive codes. */
function codesFromCart(cart, fallback = [], includeInactive = false) {
  if (Array.isArray(cart.discount_codes)) {
    return uniqueCodes(cart.discount_codes.filter((entry) => includeInactive || entry.applicable === true).map((entry) => entry.code));
  }
  const result = [...fallback];
  for (const discount of cart.cart_level_discount_applications || []) {
    const application = discount.discount_application || discount;
    if (application.type === 'discount_code') result.push(application.title);
  }
  for (const line of cart.items || []) {
    for (const allocation of line.line_level_discount_allocations || []) {
      if (allocation.discount_application?.type === 'discount_code') result.push(allocation.discount_application.title);
    }
  }
  return uniqueCodes(result);
}

function blackFridayConfig() {
  if (window.ZootifyBlackFriday?.config) return window.ZootifyBlackFriday.config;
  try { return JSON.parse(document.getElementById('zootify-bf-config')?.textContent || '{}'); }
  catch { return {}; }
}

function blackFridayState() {
  const state = window.ZootifyBlackFriday?.getState?.();
  if (state) return state;
  const config = blackFridayConfig();
  return { phase: 'incomplete', actualPhase: 'incomplete', canApplyCampaign: false, preview: Boolean(config.designMode) };
}

function blackFridayCartEnabled() {
  const config = blackFridayConfig();
  return Boolean(config.enabled && config.cartEnabled);
}

function blackFridayEligibleLines(cart) {
  return (cart?.items || []).filter((item) => !item.gift_card && !item.selling_plan_allocation);
}
function blackFridayUnits(cart) {
  return blackFridayEligibleLines(cart).reduce((total, item) => total + Number(item.quantity || 0), 0);
}
function blackFridaySubtotal(cart) {
  // Qualify against selling prices BEFORE the selected campaign discount.
  // The discounted payable total must not revoke an already-qualified offer.
  return blackFridayEligibleLines(cart).reduce((total, item) => total + Math.max(0, Math.round(Number(item.original_line_price ?? item.line_price ?? 0) || 0)), 0);
}
function blackFridayMinimumSpend() { return 10000; }
function blackFridayOffers(cart) {
  const codes = blackFridayConfig().codes || {};
  return [
    { kind: 'b2g1', code: String(codes.b2g1 || 'BFB2G1').trim() },
    { kind: 'tiered', code: String(codes.bf20 || 'BF20').trim() },
  ];
}
function blackFridayOffer(code) {
  const codes = blackFridayConfig().codes || {};
  const normalized = normalizeCode(code);
  const offered = blackFridayOffers(null).find((offer) => normalizeCode(offer.code) === normalized);
  if (offered) return offered;
  // WELCOME10 is not advertised in this campaign. Recognize an explicitly
  // entered existing code solely to replace it safely, without stacking.
  if (normalized === normalizeCode(codes.welcome || 'WELCOME10')) return { kind: 'welcome', code: String(code).trim() };
  return undefined;
}
function blackFridayLegacyCodes() { return ['BLACKFRIDAY', 'BF10', 'BF30']; }
function blackFridayLegacyCode(code) {
  return blackFridayLegacyCodes().some((value) => normalizeCode(value) === normalizeCode(code));
}

function blackFridayManagedCode(code) {
  const regular = blackFridayConfig().codes?.regular;
  return Boolean(blackFridayOffer(code) || blackFridayLegacyCode(code) || (regular && normalizeCode(regular) === normalizeCode(code)));
}

// 'tiered' remains an internal DOM identifier only. The offer is flat 20%
// on a USD merchandise subtotal of $100+, with no minimum item quantity.
function blackFridayTieredPercentage(cart) {
  return blackFridaySubtotal(cart) >= blackFridayMinimumSpend() ? 20 : 0;
}

function allocatedSaving(cart, code) {
  const normalized = normalizeCode(code);
  let amount = 0;
  for (const entry of cart?.cart_level_discount_applications || []) {
    const application = entry.discount_application || entry;
    if (application.type === 'discount_code' && normalizeCode(application.title) === normalized) {
      const allocated = entry.discount_application && entry.amount != null ? entry.amount : application.total_allocated_amount;
      amount += Math.max(0, Number(allocated) || 0);
    }
  }
  for (const item of cart?.items || []) {
    for (const allocation of item.line_level_discount_allocations || []) {
      if (allocation.discount_application?.type === 'discount_code' && normalizeCode(allocation.discount_application.title) === normalized) {
        amount += Math.max(0, Number(allocation.amount) || 0);
      }
    }
  }
  return amount;
}

function blackFridayQuantityEligibility(kind, cart) {
  const count = blackFridayUnits(cart);
  if (kind === 'welcome') {
    return { eligible: count > 0, reason: count > 0 ? '' : 'empty' };
  }
  if (count === 0) return { eligible: false, reason: 'empty' };
  if (kind === 'tiered') {
    const eligible = blackFridaySubtotal(cart) >= blackFridayMinimumSpend();
    return { eligible, reason: eligible ? '' : 'minimum_spend' };
  }
  if (kind === 'b2g1') return { eligible: count >= 3, reason: count >= 3 ? '' : 'quantity_three' };
  return { eligible: false, reason: 'not_ready' };
}

function blackFridayEligibility(kind, cart) {
  const state = blackFridayState();
  if (state.preview) return { eligible: false, reason: 'preview' };
  if (kind === 'tiered' && !blackFridayConfig().releaseReady) return { eligible: false, reason: 'not_ready' };
  if (kind !== 'welcome' && !state.canApplyCampaign) {
    const reason = state.actualPhase === 'ended' ? 'ended' : state.actualPhase === 'upcoming' ? 'upcoming' : 'not_ready';
    return { eligible: false, reason };
  }
  return blackFridayQuantityEligibility(kind, cart);
}

function blackFridayVisualEligibility(kind, cart) {
  const state = blackFridayState();
  if (!state.preview) return blackFridayEligibility(kind, cart);
  if (kind === 'welcome' || state.phase === 'live') return blackFridayQuantityEligibility(kind, cart);
  return { eligible: false, reason: state.phase === 'ended' ? 'ended' : state.phase === 'upcoming' ? 'upcoming' : 'not_ready' };
}

function invalidBlackFridayCodes(cart, fallback = []) {
  if (!blackFridayCartEnabled() || !window.ZootifyBlackFriday?.getState || blackFridayState().preview) return [];
  const codes = codesFromCart(cart, fallback, true);
  const offers = codes.filter((code) => blackFridayOffer(code));
  const invalid = [
    ...codes.filter((code) => blackFridayLegacyCode(code)),
    ...offers.filter((code) => !blackFridayEligibility(blackFridayOffer(code).kind, cart).eligible),
  ];
  const valid = offers.filter((code) => !invalid.some((value) => normalizeCode(value) === normalizeCode(code)));
  if (valid.length > 1) {
    const allocated = valid.find((code) => allocatedSaving(cart, code) > 0);
    invalid.push(...valid.filter((code) => !allocated || normalizeCode(code) !== normalizeCode(allocated)));
  }
  return uniqueCodes(invalid);
}

function nativeChoiceKey(cart) {
  return 'zootify-bf-choice:' + String(cart?.token || '').split('?')[0] + ':' + blackFridayConfig().startDate;
}
function nativeChoice(cart, value) {
  const key = nativeChoiceKey(cart);
  const memory = window.__zbfNativeChoices ||= {};
  if (value !== undefined) {
    memory[key] = value;
    try { sessionStorage.setItem(key, value); } catch {}
    return value;
  }
  try { return memory[key] ?? sessionStorage.getItem(key) ?? ''; } catch { return memory[key] || ''; }
}
function nativeAutomaticCode(cart) {
  const state = blackFridayState();
  if (!blackFridayCartEnabled() || !state.canApplyCampaign || state.preview || blackFridayConfig().autoPercentage === false) return '';
  const count = blackFridayUnits(cart);
  if (!count) { nativeChoice(cart, ''); return ''; }
  if (!blackFridayQuantityEligibility('tiered', cart).eligible) return '';
  const active = codesFromCart(cart).filter((code) => allocatedSaving(cart, code) > 0);
  if (active.some((code) => {
    const offer = blackFridayOffer(code);
    return offer && offer.kind !== 'tiered' && blackFridayQuantityEligibility(offer.kind, cart).eligible;
  })) return '';
  if (active.some((code) => !blackFridayManagedCode(code))) return '';
  if (nativeChoice(cart) === 'none') return '';
  const target = blackFridayOffers(cart).find((offer) => offer.kind === 'tiered').code;
  if (active.some((code) => normalizeCode(code) === normalizeCode(target)) && !invalidBlackFridayCodes(cart).length) return '';
  return target;
}
function nativeSavings(cart, kind) {
  const lines = blackFridayEligibleLines(cart);
  const rate = kind === 'welcome' ? 10 : blackFridayTieredPercentage(cart);
  if (kind === 'b2g1') return blackFridayUnits(cart) >= 3 ? Math.min(...lines.map((item) => Number(item.original_price ?? item.price) || 0)) : 0;
  return lines.reduce((total, item) => total + Math.round(Number(item.original_line_price ?? item.line_price ?? 0) * rate / 100), 0);
}
function nativeCartSignature(cart, code) {
  const state = blackFridayState();
  return JSON.stringify([String(cart?.token || ''), (cart?.items || []).map((item) => [item.variant_id, item.quantity, item.original_line_price]), codesFromCart(cart, [], true), code, state.actualPhase, state.testing, blackFridayConfig().releaseReady]);
}

class ZootifyCartDiscount extends HTMLElement {
  #busy = false;
  #hydrated = false;
  #revision = 0;
  #cart = null;
  #strings = {};
  #reconcileTimer;

  connectedCallback() {
    try { this.#cart = JSON.parse(this.querySelector('[data-zbf-cart-state]')?.textContent || 'null'); } catch {}
    try { this.#strings = JSON.parse(this.querySelector('[data-zbf-cart-strings]')?.textContent || '{}'); } catch {}
    this.addEventListener('submit', this.#onSubmit);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('input', this.#onInput);
    this.addEventListener('toggle', this.#onToggle, true);
    document.addEventListener(ThemeEvents.cartUpdate, this.#onCartChanged);
    document.addEventListener(ThemeEvents.discountUpdate, this.#onCartChanged);
    document.addEventListener(ThemeEvents.quantitySelectorUpdate, this.#onQuantityChanged);
    document.addEventListener('zootify:cart-transaction', this.#onTransaction);
    document.addEventListener('zootify:bf-state', this.#onSaleState);
    document.addEventListener('DOMContentLoaded', this.#onSaleState);
    this.renderOffers();
    if (this.querySelector('details')?.open || this.querySelector('[data-zbf-offers]')) this.#hydrateCodes();
  }

  disconnectedCallback() {
    this.removeEventListener('submit', this.#onSubmit);
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('input', this.#onInput);
    this.removeEventListener('toggle', this.#onToggle, true);
    document.removeEventListener(ThemeEvents.cartUpdate, this.#onCartChanged);
    document.removeEventListener(ThemeEvents.discountUpdate, this.#onCartChanged);
    document.removeEventListener(ThemeEvents.quantitySelectorUpdate, this.#onQuantityChanged);
    document.removeEventListener('zootify:cart-transaction', this.#onTransaction);
    document.removeEventListener('zootify:bf-state', this.#onSaleState);
    document.removeEventListener('DOMContentLoaded', this.#onSaleState);
    this.#revision += 1;
    clearTimeout(this.#reconcileTimer);
  }

  string(key, fallback = '') {
    return this.#strings[key] || fallback;
  }

  offerReason(reason, cart = this.#cart) {
    if (reason === 'minimum_spend') {
      const remaining = Math.max(0, blackFridayMinimumSpend() - blackFridaySubtotal(cart));
      const money = new Intl.NumberFormat(document.documentElement.lang || 'en-US', { style: 'currency', currency: 'USD' }).format(remaining / 100);
      return this.string('minimum_spend', 'Spend __amount__ more to unlock').replace('__amount__', money);
    }
    return this.string(reason);
  }

  #onQuantityChanged = () => {
    this.#revision += 1;
    this.#hydrated = false;
    this.renderOffers();
  };

  #onCartChanged = (event) => {
    this.#revision += 1;
    this.#hydrated = false;
    const cart = event.detail?.resource;
    if (Array.isArray(cart?.items) && typeof cart.item_count === 'number') {
      this.#cart = cart;
      this.paintCodes(codesFromCart(cart, this.#domCodes()));
      this.renderOffers();
      if (event.detail?.data?.source !== 'zootify-cart-discount') this.#reconcile(cart);
    }
  };

  #onTransaction = () => {
    this.renderOffers();
    if (!window.__zootifyCartQueueV1?.pending && !this.#busy) {
      if (!this.#hydrated) this.#hydrateCodes();
      else if (this.#cart) this.#reconcile(this.#cart);
    }
  };

  #onSaleState = () => {
    this.renderOffers();
    if (this.#cart) this.#reconcile(this.#cart);
    if (!this.#hydrated) this.#hydrateCodes();
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
    const offerButton = event.target.closest('[data-zbf-offer-action]');
    if (offerButton instanceof HTMLButtonElement && this.contains(offerButton)) {
      event.preventDefault();
      if (offerButton.disabled) return;
      const offer = blackFridayOffers(this.#cart).find((entry) => entry.kind === offerButton.dataset.zbfKind);
      if (offer) this.#changeCodes(offerButton.dataset.zbfOperation || 'apply', offer.code, false, offer.kind);
      return;
    }
    const button = event.target.closest('[data-zc-remove-code]');
    if (!(button instanceof HTMLButtonElement) || !this.contains(button) || button.disabled) return;
    event.preventDefault();
    const code = button.dataset.zcRemoveCode;
    if (code) this.#changeCodes('remove', code);
  };

  #domCodes() {
    const codes = [...this.querySelectorAll('[data-zc-code]')].map((node) => node.dataset.zcCode);
    if (this.#cart) {
      for (const offer of blackFridayOffers(this.#cart)) {
        if (allocatedSaving(this.#cart, offer.code) > 0) codes.push(offer.code);
      }
    }
    return uniqueCodes(codes);
  }

  async #hydrateCodes() {
    if (this.#hydrated || this.#busy || this.closest('zootify-cart-summary')?.isBusy) return;
    this.#hydrated = true;
    const revision = this.#revision;
    try {
      const cart = await fetchCartJSON(cartEndpoint(this.dataset.cartUrl));
      if (this.isConnected && !this.#busy && !this.closest('zootify-cart-summary')?.isBusy && revision === this.#revision) {
        this.#cart = cart;
        this.paintCodes(codesFromCart(cart, this.#domCodes()));
        this.renderOffers();
        this.#reconcile(cart);
      } else {
        this.#hydrated = false;
      }
    } catch {
      this.#hydrated = false;
    }
  }

  #reconcile(cart) {
    if (this.#busy || !this.isConnected || !cart) return;
    if (this.closest('zootify-cart-summary')?.isBusy) {
      clearTimeout(this.#reconcileTimer);
      this.#reconcileTimer = setTimeout(() => this.#reconcile(this.#cart), 150);
      return;
    }
    const target = nativeAutomaticCode(cart);
    if (target) {
      const signature = nativeCartSignature(cart, target);
      if (window.__zbfAutoAttempt === signature) return;
      window.__zbfAutoAttempt = signature;
      this.#changeCodes('apply', target, true, 'tiered');
      return;
    }
    if (invalidBlackFridayCodes(cart, this.#domCodes()).length) this.#changeCodes('reconcile', '', true);
  }

  renderOffers() {
    const state = blackFridayState();
    const summary = this.closest('zootify-cart-summary');
    const busy = this.#busy || Boolean(summary?.isBusy);
    const controls = [
      ...this.querySelectorAll('[data-zc-code-form] input, [data-zc-code-form] button, [data-zc-remove-code]'),
      ...(summary?.querySelectorAll('[data-zt-offer-apply]') || []),
    ];
    for (const control of controls) {
      control.dataset.zcOfferLocked = String(state.preview);
      control.disabled = busy || state.preview;
    }
    const container = this.querySelector('[data-zbf-offers]');
    if (!container) return;
    const config = blackFridayConfig();
    const hideCampaign = !config.enabled || !(state.phase === 'live' || state.testing);
    container.hidden = !config.cartEnabled || hideCampaign;
    if (!config.cartEnabled) return;
    for (const offer of blackFridayOffers(this.#cart)) {
      const row = container.querySelector('[data-zbf-kind="' + offer.kind + '"]');
      if (!row) continue;
      row.hidden = hideCampaign;
      const eligibility = blackFridayVisualEligibility(offer.kind, this.#cart);
      const applied = allocatedSaving(this.#cart, offer.code) > 0;
      const button = row.querySelector('[data-zbf-offer-action]');
      const badge = row.querySelector('[data-zbf-applied]');
      const reason = row.querySelector('[data-zbf-reason]');
      const code = row.querySelector('[data-zbf-code]');
      if (code && code.textContent !== offer.code) code.textContent = offer.code;
      if (offer.kind === 'tiered') {
        const description = row.querySelector('[data-zbf-tier-description]');
        const percentage = blackFridayTieredPercentage(this.#cart);
        const label = this.string('tiered_empty_description', 'Flat 20% off');
        if (description && description.textContent !== label) description.textContent = label;
        row.dataset.percentage = String(percentage);
      }
      const saving = row.querySelector('[data-zbf-saving]');
      if (saving) {
        const amount = applied ? allocatedSaving(this.#cart, offer.code) : nativeSavings(this.#cart, offer.kind);
        const currency = typeof this.#cart?.currency === 'string' ? this.#cart.currency : 'USD';
        const money = new Intl.NumberFormat(document.documentElement.lang || 'en-US', { style: 'currency', currency }).format(amount / 100);
        const value = this.string(applied ? 'saved_amount' : 'save_amount', applied ? 'Saved __amount__' : 'Save __amount__').replace('__amount__', money);
        saving.textContent = value;
        saving.hidden = amount <= 0 || hideCampaign || !eligibility.eligible && !applied;
      }
      const nudge = row.querySelector('[data-zbf-b2g1-nudge]');
      const showNudge = Boolean(nudge && !hideCampaign && blackFridayUnits(this.#cart) === 2 && !applied);
      row.dataset.hasNudge = String(showNudge);
      if (nudge) {
        nudge.hidden = !showNudge;
        const replaces = nudge.querySelector('[data-zbf-replaces-twenty]');
        const percentageCode = blackFridayOffers(this.#cart).find((entry) => entry.kind === 'tiered')?.code;
        if (replaces) replaces.hidden = !percentageCode || allocatedSaving(this.#cart, percentageCode) <= 0;
      }
      row.dataset.applied = String(applied);
      row.dataset.locked = String(!applied && !eligibility.eligible);
      if (badge) badge.hidden = !applied;
      if (reason) {
        reason.textContent = applied || showNudge ? '' : this.offerReason(eligibility.reason);
        reason.hidden = !reason.textContent;
      }
      if (button) {
        const locked = state.preview || (!applied && !eligibility.eligible);
        button.dataset.zcOfferLocked = String(locked);
        button.dataset.zbfPreviewEligible = String(state.preview && !applied && eligibility.eligible);
        button.dataset.zbfOperation = applied ? 'remove' : 'apply';
        button.disabled = busy || locked;
        button.textContent = applied ? this.string('remove', 'Remove') : this.string('apply', 'Apply');
        button.setAttribute('aria-label', (applied ? this.string('remove_label', 'Remove __code__') : this.string('apply_label', 'Apply __code__')).replace('__code__', offer.code));
      }
    }
    const preview = this.querySelector('[data-zbf-preview-note]');
    if (preview) {
      preview.hidden = !state.preview && !state.testing;
      preview.textContent = state.testing ? this.string('test_mode', 'Discount testing — unpublished theme') : this.string('preview', 'Theme editor preview only.');
    }
  }

  paintCodes(codes) {
    const list = this.querySelector('[data-zc-code-list]');
    if (!list) return;
    const children = uniqueCodes(codes).filter((code) => {
      if (normalizeCode(code) === normalizeCode(pairingCode())) return false;
      const offered = blackFridayOffers(this.#cart).some((offer) => normalizeCode(offer.code) === normalizeCode(code));
      return !(blackFridayCartEnabled() && (offered || blackFridayLegacyCode(code)));
    }).map((code) => {
      const li = document.createElement('li');
      li.className = 'zc-code';
      li.dataset.zcCode = code;
      const label = document.createElement('span');
      label.textContent = code;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.zcRemoveCode = code;
      remove.setAttribute('aria-label', this.string('remove_label', 'Remove __code__').replace('__code__', code));
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

  async #changeCodes(operation, code, background = false, focusKind = '') {
    const summary = this.closest('zootify-cart-summary');
    if (this.#busy || (!background && summary?.isBusy)) return;
    const sectionId = this.dataset.sectionId;
    if (!sectionId) return;
    const bfMode = blackFridayCartEnabled();
    if (blackFridayState().preview) {
      this.setStatus(this.string('preview', 'Preview only. Offer changes are disabled.'));
      return;
    }
    if (bfMode && operation === 'apply' && code.includes(',')) {
      this.setStatus(this.string('invalid_code', 'Enter a valid discount code.'), 'error');
      return;
    }
    this.#busy = true;
    this.#revision += 1;
    summary?.setDiscountBusy(true);
    this.renderOffers();
    this.setStatus(operation === 'apply' ? this.string('applying', 'Applying code…') : this.string('removing', 'Removing code…'));
    const componentId = this.id;
    const oldCartItems = this.closest('cart-items-component');
    const updateURL = cartEndpoint(this.dataset.updateUrl);
    const cartURL = cartEndpoint(this.dataset.cartUrl);
    const inputDraft = this.querySelector('input[name="discount"]')?.value || '';
    const disclosureOpen = Boolean(this.querySelector('details')?.open);
    let activeComponent = this;
    let data;
    let rollback = false;
    let accepted = false;
    let mutationStarted = false;
    let invalidRemoved = [];
    let failureMessage = '';
    const sectionIds = [...new Set([sectionId, ...[...document.querySelectorAll('cart-items-component[data-section-id]')].map((node) => node.dataset.sectionId)])].slice(0, 5);
    const request = (codes) => {
      mutationStarted = true;
      return fetchCartJSON(updateURL, {
        method: 'POST',
        body: JSON.stringify({ discount: uniqueCodes(codes).join(','), sections: sectionIds, sections_url: window.location.pathname + window.location.search }),
      });
    };
    return zootifyCartQueue().run(async () => {
      try {
        const currentCart = await fetchCartJSON(cartURL);
        this.#cart = currentCart;
        const existing = codesFromCart(currentCart, this.#domCodes(), true);
        if (bfMode && operation === 'apply' && blackFridayOffer(code)?.kind === 'tiered') code = blackFridayOffers(currentCart).find((entry) => entry.kind === 'tiered').code;
        const offer = bfMode ? blackFridayOffer(code) : null;
        const managed = bfMode && blackFridayManagedCode(code);
        const legacy = bfMode && blackFridayLegacyCode(code);
        const regular = managed && !offer && !legacy;
        if (operation === 'apply' && legacy) {
          this.setStatus(this.string('legacy_unavailable', 'This offer is no longer available.'), 'error');
          return;
        }
        if (operation === 'apply' && regular && (blackFridayState().actualPhase === 'live' || blackFridayState().testing)) {
          this.setStatus(this.string('not_ready', 'This offer is not available yet.'), 'error');
          return;
        }
        if (operation === 'apply' && offer) {
          const eligibility = blackFridayEligibility(offer.kind, currentCart);
          if (!eligibility.eligible) {
            this.renderOffers();
            this.setStatus(this.offerReason(eligibility.reason, currentCart) || 'This offer is not available for your cart.', 'error');
            return;
          }
        }
        if (operation === 'apply' && !managed && existing.some((value) => normalizeCode(value) === normalizeCode(code))) {
          const applicable = codesFromCart(currentCart, this.#domCodes());
          this.paintCodes(applicable);
          this.renderOffers();
          this.setStatus(applicable.some((value) => normalizeCode(value) === normalizeCode(code))
            ? this.string('already_applied', 'This code is already applied.')
            : this.string('saved_inactive', 'This code does not currently apply to your cart.'));
          return;
        }
        let desired;
        if (operation === 'reconcile') {
          invalidRemoved = invalidBlackFridayCodes(currentCart, this.#domCodes());
          if (!invalidRemoved.length) {
            this.renderOffers();
            this.setStatus('');
            return;
          }
          desired = existing.filter((value) => !invalidRemoved.some((invalid) => normalizeCode(invalid) === normalizeCode(value)));
        } else if (operation === 'apply') {
          desired = managed ? [...existing.filter((value) => !blackFridayManagedCode(value)), code] : [...existing, code];
        } else {
          desired = existing.filter((value) => normalizeCode(value) !== normalizeCode(code));
        }
        data = await request(desired);
        accepted = managed ? allocatedSaving(data, code) > 0 : codesFromCart(data).some((value) => normalizeCode(value) === normalizeCode(code));
        if (operation === 'apply' && managed && !accepted) {
          const previousChoice = existing.find((value) => {
            const previousOffer = blackFridayOffer(value);
            return previousOffer && allocatedSaving(currentCart, value) > 0 && blackFridayEligibility(previousOffer.kind, data).eligible;
          });
          const previousRegular = existing.find((value) => normalizeCode(value) === normalizeCode(blackFridayConfig().codes?.regular) && allocatedSaving(currentCart, value) > 0);
          const restoreRegular = previousRegular && !blackFridayState().testing && ['off', 'ended', 'upcoming'].includes(blackFridayState().actualPhase);
          const retained = codesFromCart(data, desired, true).filter((value) => !blackFridayManagedCode(value));
          data = await request([...retained, ...(previousChoice ? [previousChoice] : restoreRegular ? [previousRegular] : [])]);
          rollback = true;
        }
        if (operation === 'apply' && accepted && !rollback) nativeChoice(data, blackFridayOffer(code)?.kind || 'external');
        if (operation === 'remove' && !background && !codesFromCart(data, [], true).some((entry) => normalizeCode(entry) === normalizeCode(code))) nativeChoice(data, 'none');
        let html = data.sections?.[sectionId];
        if (typeof html !== 'string' || !html.includes('shopify-section-' + sectionId)) {
          const freshURL = new URL(window.location.href);
          freshURL.searchParams.set('_zc_revision', Date.now() + '-' + Math.random().toString(36).slice(2));
          html = await sectionRenderer.getSectionHTML(sectionId, false, freshURL);
        }
        const fragment = new DOMParser().parseFromString(html, 'text/html');
        const freshComponent = fragment.getElementById(componentId);
        const renderedCodes = [...(freshComponent?.querySelectorAll('[data-zc-code]') || [])].map((node) => node.dataset.zcCode);
        const acceptedCodes = codesFromCart(data, renderedCodes);
        if (!managed && operation !== 'reconcile') accepted = acceptedCodes.some((value) => normalizeCode(value) === normalizeCode(code));
        if (operation === 'remove' && bfMode && blackFridayOffer(code)) accepted = allocatedSaving(data, code) > 0;
        const hasVisibleSaving = allocatedSaving(data, code) > 0 || renderedCodes.some((value) => normalizeCode(value) === normalizeCode(code));

        await morphSection(sectionId, html);
        data.sections = { ...data.sections, [sectionId]: html };
        const cartItems = oldCartItems?.isConnected ? oldCartItems : document.getElementById('shopify-section-' + sectionId)?.querySelector('cart-items-component');
        (cartItems || document).dispatchEvent(new CartUpdateEvent(data, sectionId, {
          itemCount: data.item_count, source: 'zootify-cart-discount', sections: data.sections,
        }));
        await nextFrame();
        activeComponent = document.getElementById(componentId) || this;
        if (!(activeComponent instanceof ZootifyCartDiscount)) return;
        activeComponent.#cart = data;
        activeComponent.#hydrated = true;
        activeComponent.paintCodes(acceptedCodes);
        activeComponent.renderOffers();
        const input = activeComponent.querySelector('input[name="discount"]');
        const disclosure = activeComponent.querySelector('details');
        if (disclosure) disclosure.open = background || focusKind ? disclosureOpen : true;
        if (input) {
          input.value = operation === 'apply' && accepted && !rollback ? '' : (operation === 'apply' && !focusKind ? code : inputDraft);
          input.toggleAttribute('aria-invalid', operation === 'apply' && (!accepted || rollback) && !focusKind);
          if (input.hasAttribute('aria-invalid')) input.setAttribute('aria-invalid', 'true');
        }
        if (operation === 'reconcile') {
          const stillPresent = invalidRemoved.some((value) => codesFromCart(data, [], true).some((entry) => normalizeCode(entry) === normalizeCode(value)));
          activeComponent.setStatus(stillPresent
            ? this.string('remove_failed', 'This offer could not be removed. Please try again.')
            : this.string('invalid_removed', 'Your previous offer no longer applies. Choose an available offer.'), stillPresent ? 'error' : 'info');
        } else if (operation === 'remove') {
          activeComponent.setStatus(accepted ? this.string('remove_failed', 'This offer could not be removed. Please try again.') : this.string('removed', 'Discount code removed.'), accepted ? 'error' : 'info');
        } else if (rollback || !accepted) {
          activeComponent.setStatus(this.string('not_applicable', 'This code could not be applied. Your available offers are shown above.'), 'error');
        } else {
          activeComponent.setStatus(hasVisibleSaving ? this.string('applied', 'Offer applied.') : this.string('accepted_checkout', 'Code accepted. Any additional savings will be confirmed at checkout.'));
        }
        if (!background) {
          const focusTarget = focusKind ? activeComponent.querySelector('[data-zbf-kind="' + focusKind + '"] [data-zbf-offer-action]') : input;
          requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
        }
      } catch (error) {
        activeComponent = document.getElementById(componentId) || this;
        failureMessage = this.string('update_failed', 'We could not confirm the discount change. Please refresh your cart and check the total before checkout.');
        activeComponent.setStatus(failureMessage, 'error');
        const input = activeComponent.querySelector('input[name="discount"]');
        if (input && !focusKind) input.value = operation === 'apply' ? code : inputDraft;
        activeComponent.#hydrated = false;
        if (mutationStarted) {
          try {
            const freshCart = await fetchCartJSON(cartURL);
            activeComponent.#cart = freshCart;
            activeComponent.paintCodes(codesFromCart(freshCart, activeComponent.#domCodes()));
            activeComponent.renderOffers();
            const freshURL = new URL(window.location.href);
            freshURL.searchParams.set('_zc_revision', Date.now() + '-recover');
            const html = await sectionRenderer.getSectionHTML(sectionId, false, freshURL);
            await morphSection(sectionId, html);
            activeComponent = document.getElementById(componentId) || activeComponent;
            if (activeComponent instanceof ZootifyCartDiscount) {
              activeComponent.#cart = freshCart;
              activeComponent.#hydrated = true;
              activeComponent.paintCodes(codesFromCart(freshCart));
              activeComponent.renderOffers();
              const disclosure = activeComponent.querySelector('details');
              if (disclosure) disclosure.open = background || focusKind ? disclosureOpen : true;
              activeComponent.setStatus(failureMessage, 'error');
            }
          } catch {}
        }
      } finally {
        this.#busy = false;
        summary?.setDiscountBusy(false);
        activeComponent.closest('zootify-cart-summary')?.setDiscountBusy(false);
        activeComponent.renderOffers?.();
      }
    });
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
    return this.#discountBusy || Boolean(window.__zootifyCartQueueV1?.pending) || Date.now() < this.#quantityPendingUntil || Boolean(this.#cartItems?.classList.contains('cart-items-disabled'));
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
    document.addEventListener('zootify:cart-transaction', this.#onTransaction, { signal });
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

  #onTransaction = () => {
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
    const preview = blackFridayState().preview;
    for (const button of this.querySelectorAll('[data-zc-main-checkout], [data-zc-mobile-checkout], .zc-apply, [data-zc-remove-code], [data-zbf-offer-action], [data-zt-offer-apply]')) {
      const previewLocked = preview && !button.hasAttribute('data-zc-main-checkout') && !button.hasAttribute('data-zc-mobile-checkout');
      const disabled = busy || previewLocked || button.dataset.zcOfferLocked === 'true';
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    const input = this.querySelector('[data-zc-code-form] input');
    if (input) {
      const disabled = busy || preview || input.dataset.zcOfferLocked === 'true';
      if (input.disabled !== disabled) input.disabled = disabled;
    }
    const wallet = this.querySelector('[data-zc-wallets]');
    if (wallet && wallet.inert !== busy) wallet.inert = busy;
    const items = this.closest('.zootify-cart-page--v3')?.querySelector('.cart-page__items');
    const lockItems = this.#discountBusy || Boolean(window.__zootifyCartQueueV1?.pending);
    if (items && items.inert !== lockItems) items.inert = lockItems;
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


document.addEventListener(ThemeEvents.cartUpdate, (event) => {
  if (event.detail?.resource?.item_count === 0) nativeChoice(event.detail.resource, '');
});
