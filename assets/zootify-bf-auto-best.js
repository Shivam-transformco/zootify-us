/**
 * ZOOTIFY | Black Friday automatic best offer
 * Works across product pages, collections, cart page and cart drawer.
 * Shopify remains the source of truth for which discounts apply and the final total.
 *
 * Runs only while the active Black Friday campaign is eligible, and only on USD carts.
 * Legacy BF20 auto-selection in zootify-cart-page.js is switched off by the
 * companion zootify-bf-config.liquid replacement to avoid racing mutations.
 *
 * Uses Shopify's supported /cart/update.js `discount` parameter.
 */
(() => {
  'use strict';

  const CONFIG_ID = 'zootify-bf-config';
  const EVENT_SOURCE = 'zootify-bf-auto-best';
  const MANAGED_FALLBACK = ['BFB2G1', 'BF20', 'WELCOME10', 'PAIR20-CEB879BC'];
  const DEBOUNCE_MS = 330;
  const FAILURE_COOLDOWN_MS = 12000;

  let timer;
  let processing = false;
  let needsAnotherCheck = false;
  let lastCheckedComposition = '';
  let lastFailed = { key: '', at: 0 };
  let autoAppliedCount = 0;

  const norm = (code) => String(code || '').trim().toUpperCase();
  const unique = (values) => [...new Map(values.filter(Boolean).map((v) => [norm(v), String(v).trim()])).values()];

  function config() {
    if (window.ZootifyBlackFriday?.config) return window.ZootifyBlackFriday.config;
    try { return JSON.parse(document.getElementById(CONFIG_ID)?.textContent || '{}'); }
    catch { return {}; }
  }

  function cartPath(endpoint) {
    const root = window.Shopify?.routes?.root || '/';
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return endpoint ? `${prefix}cart/${endpoint}.js` : `${prefix}cart.js`;
  }

  async function cartRequest(endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(cartPath(endpoint), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Cart ${endpoint} returned ${response.status}`);
      const payload = await response.json();
      if (payload.errors) throw new Error('Shopify rejected cart update');
      return payload;
    } finally { clearTimeout(timeout); }
  }

  function eligibleLines(cart) {
    return (cart?.items || []).filter((item) => {
      const isGift = item.gift_card === true;
      const isSubscription = Boolean(item.selling_plan_allocation);
      return !isGift && !isSubscription && Number(item.quantity) > 0;
    });
  }

  function composition(cart) {
    return JSON.stringify((cart?.items || []).map((item) => [
      item.variant_id, item.quantity, item.original_line_price, item.selling_plan_allocation?.selling_plan?.id || null,
    ]));
  }

  function codesInCart(cart) {
    if (Array.isArray(cart?.discount_codes)) {
      return unique(cart.discount_codes.map((entry) => entry.code));
    }
    const result = [];
    for (const entry of cart?.cart_level_discount_applications || []) {
      const applied = entry.discount_application || entry;
      if (applied.type === 'discount_code') result.push(applied.title);
    }
    for (const item of cart?.items || []) {
      for (const entry of item.line_level_discount_allocations || []) {
        if (entry.discount_application?.type === 'discount_code') result.push(entry.discount_application.title);
      }
    }
    return unique(result);
  }

  function confirmedSaving(cart, code) {
    const match = norm(code);
    let total = 0;
    for (const entry of cart?.cart_level_discount_applications || []) {
      const applied = entry.discount_application || entry;
      if (applied.type === 'discount_code' && norm(applied.title) === match) {
        total += Math.max(0, Number(entry.amount ?? applied.total_allocated_amount ?? 0));
      }
    }
    for (const line of cart?.items || []) {
      for (const entry of line.line_level_discount_allocations || []) {
        if (entry.discount_application?.type === 'discount_code' && norm(entry.discount_application.title) === match) {
          total += Math.max(0, Number(entry.amount ?? 0));
        }
      }
    }
    return total;
  }

  function campaignRules(cart, cfg) {
    // B2G1 has a Shopify usesPerOrderLimit of 1, so at most one free item.
    const lines = eligibleLines(cart);
    const count = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
    const unitPrices = lines.map((line) => Number(line.original_price ?? line.price ?? 0));
    const subtotal = lines.reduce((sum, line) => sum + Number(line.original_line_price ?? (line.price * line.quantity) ?? 0), 0);
    // Use *upper bounds*, not assumed savings: product membership in the sale
    // collection is ultimately evaluated by Shopify. The cheapest ELIGIBLE
    // item can cost more than the cheapest item in a mixed cart. Therefore the
    // maximum cart unit price is a safe ceiling for one free item, whereas the
    // minimum would incorrectly underestimate B2G1 in mixed carts.
    const buyGetSaving = count >= 3 && unitPrices.length ? Math.max(0, ...unitPrices) : 0;
    // BF20's current $100 minimum applies to eligible products at checkout.
    // The all-cart subtotal / 5 is an upper bound, not a promised saving.
    const twentySaving = subtotal >= 10000 ? Math.round(subtotal * 0.20) : 0;
    const codes = cfg.codes || {};
    const b2g1 = String(codes.b2g1 || 'BFB2G1').trim();
    const bf20 = String(codes.bf20 || 'BF20').trim();
    const choices = [
      { code: b2g1, kind: 'b2g1', saving: buyGetSaving },
      { code: bf20, kind: 'bf20', saving: twentySaving },
    ].filter((candidate) => candidate.saving > 0);
    // Try the largest possible saving first, then verify with Shopify.
    // The other upper bound is probed whenever it could beat the confirmed amount.
    choices.sort((a, b) => b.saving - a.saving || (a.kind === 'b2g1' ? -1 : 1));
    return choices;
  }

  function enabled(cart, cfg) {
    const state = window.ZootifyBlackFriday?.getState?.();
    return Boolean(
      cfg.enabled && cfg.cartEnabled && cfg.releaseReady && cfg.autoBestOffer &&
      state && !state.preview && state.canApplyCampaign && cart?.currency === 'USD'
    );
  }

  function choiceKey(cart, cfg) {
    return `zootify-bf-choice:${String(cart.token || '').split('?')[0]}:${cfg.startDate}`;
  }

  function userOptedOut(cart, cfg) {
    // The existing cart UI saves 'none' when the shopper explicitly removes a code.
    // Respect the removal for the same cart composition; re-evaluate after a quantity change.
    const key = choiceKey(cart, cfg);
    try {
      const val = sessionStorage.getItem(key);
      if (val !== 'none') return false;
      const lastAutoComposition = sessionStorage.getItem(`${key}:autobest-composition`);
      if (lastAutoComposition && lastAutoComposition === composition(cart)) return true;
      sessionStorage.removeItem(key);
    } catch { /* Storage can be unavailable. */ }
    return false;
  }

  function recordComposition(cart, cfg) {
    try { sessionStorage.setItem(`${choiceKey(cart, cfg)}:autobest-composition`, composition(cart)); }
    catch { /* Storage can be unavailable. */ }
  }

  function managedCodes(cfg) {
    const codes = cfg.codes || {};
    return new Set(unique([
      ...MANAGED_FALLBACK, codes.b2g1, codes.bf20, codes.welcome, codes.regular,
      // Removed legacy Black Friday code names are cleared when an offer is changed.
      'BF10', 'BF30', 'BLACKFRIDAY',
    ]).map(norm));
  }

  function sectionIds() {
    return [...new Set([...document.querySelectorAll('cart-items-component[data-section-id]')]
      .map((node) => node.dataset.sectionId).filter(Boolean))].slice(0, 5);
  }

  function dispatchCart(cart) {
    // Horizon components listen for cart:update. The Shopify response provides
    // section HTML so the cart rows, subtotal, applied badge and icon refresh.
    document.dispatchEvent(new CustomEvent('cart:update', {
      bubbles: true,
      detail: {
        resource: cart,
        sourceId: EVENT_SOURCE,
        data: { source: EVENT_SOURCE, itemCount: cart.item_count, sections: cart.sections || {} },
      },
    }));
  }

  function cartQueue() {
    return window.__zootifyCartQueueV1 ||= {
      tail: Promise.resolve(),
      pending: 0,
      run(task) {
        this.pending += 1;
        document.dispatchEvent(new CustomEvent('zootify:cart-transaction'));
        const result = this.tail.catch(() => {}).then(task);
        this.tail = result.catch(() => {});
        return result.finally(() => {
          this.pending -= 1;
          document.dispatchEvent(new CustomEvent('zootify:cart-transaction'));
        });
      },
    };
  }

  function cartIsBusy() {
    return Boolean(
      processing ||
      window.__zootifyCartQueueV1?.pending > 0 ||
      document.querySelector('.cart-items-disabled') ||
      document.querySelector('zootify-cart-summary[aria-busy="true"]')
    );
  }

  async function updateCodes(codes) {
    const sections = sectionIds();
    return cartRequest('update', {
      method: 'POST',
      body: JSON.stringify({
        discount: unique(codes).join(','),
        ...(sections.length ? { sections, sections_url: `${location.pathname}${location.search}` } : {}),
      }),
    });
  }


  function verificationKey(cart, cfg) {
    return 'zbf-best-verified:' + String(cart?.token || '').split('?')[0] + ':' + cfg.startDate;
  }

  function currentCodeSignature(cart) {
    return codesInCart(cart).map(norm).sort().join('|');
  }

  // A previous comparison remains valid for this exact cart composition
  // and discount state; this prevents probing BF20/B2G1 on every page visit.
  function wasVerified(cart, cfg) {
    try {
      const record = JSON.parse(sessionStorage.getItem(verificationKey(cart, cfg)) || 'null');
      return record && record.comp === composition(cart) &&
        record.codes === currentCodeSignature(cart) &&
        record.discountTotal === Number(cart?.total_discount || 0) &&
        Date.now() - record.at < 3600000;
    } catch { return false; }
  }

  function rememberVerified(cart, cfg) {
    lastCheckedComposition = composition(cart);
    recordComposition(cart, cfg);
    try {
      sessionStorage.setItem(verificationKey(cart, cfg), JSON.stringify({
        comp: composition(cart),
        codes: currentCodeSignature(cart),
        discountTotal: Number(cart?.total_discount || 0),
        at: Date.now(),
      }));
    } catch { /* Optional browser storage. */ }
  }

  /**
   * Resolve all candidate discounts on Shopify before letting the cart UI paint.
   * The returned cart is the ONLY state that callers should render.
   * Never call cartQueue.run here: quantity changes already own that queue.
   */
  async function resolveBest(cart, cfg) {
    if (!enabled(cart, cfg)) return cart;
    const currentCodes = codesInCart(cart);
    const managed = managedCodes(cfg);
    const external = currentCodes.filter((code) => !managed.has(norm(code)));
    if (external.length || userOptedOut(cart, cfg)) return cart;

    if (wasVerified(cart, cfg)) return cart;

    const choices = campaignRules(cart, cfg);
    const selected = choices[0];
    const priorFallback = currentCodes.filter((v) =>
      [norm(cfg.codes?.welcome || 'WELCOME10'), norm(cfg.codes?.regular)].includes(norm(v))
    );
    const desired = selected ? [selected.code] : priorFallback;
    const sameCodes = currentCodes.length === desired.length &&
      currentCodes.every((code) => desired.some((value) => norm(value) === norm(code)));
    // Shopify has already confirmed the first candidate, and the alternative's
    // maximum possible saving cannot beat it: no additional cart request needed.
    if (sameCodes && (!selected || (confirmedSaving(cart, selected.code) > 0 &&
        (!choices[1] || choices[1].saving <= confirmedSaving(cart, selected.code))))) {
      rememberVerified(cart, cfg);
      return cart;
    }

    const failureKey = String(cart?.token || '') + '|' + composition(cart) + '|' +
      (selected?.code || 'none');
    if (lastFailed.key === failureKey &&
        Date.now() - lastFailed.at < FAILURE_COOLDOWN_MS) return cart;

    let result = await updateCodes(desired);
    if (selected) {
      const firstSaving = confirmedSaving(result, selected.code);
      const alternative = choices[1];

      if (firstSaving <= 0) {
        // Collection, minimum-spend, or discount combination restrictions may
        // make an estimated offer inapplicable. Ask Shopify, not the UI.
        if (alternative) {
          result = await updateCodes([alternative.code]);
          if (confirmedSaving(result, alternative.code) <= 0) {
            result = await updateCodes(priorFallback);
            lastFailed = { key: failureKey, at: Date.now() };
          }
        } else {
          result = await updateCodes(priorFallback);
          lastFailed = { key: failureKey, at: Date.now() };
        }
      } else if (alternative && alternative.saving > firstSaving) {
        const trial = await updateCodes([alternative.code]);
        if (confirmedSaving(trial, alternative.code) > firstSaving) {
          result = trial;
        } else {
          // Restore the verified winner before publishing the cart state.
          result = await updateCodes([selected.code]);
        }
      }
    }
    if (!lastFailed.key || lastFailed.key !== failureKey) {
      lastFailed = { key: '', at: 0 };
    }
    rememberVerified(result, cfg);
    return result;
  }

  async function reconcile() {
    if (processing) { needsAnotherCheck = true; return; }
    const cfg = config();
    const phase = window.ZootifyBlackFriday?.getState?.();
    if (!cfg.enabled || !cfg.cartEnabled || !cfg.releaseReady || !cfg.autoBestOffer ||
        !phase || phase.preview || !phase.canApplyCampaign) return;
    if (cartIsBusy()) { schedule('pending-cart'); return; }
    processing = true;
    try {
      await cartQueue().run(async () => {
        const current = await cartRequest('');
        const finalCart = await resolveBest(current, config());
        if (finalCart === current) return;
        autoAppliedCount += 1;
        dispatchCart(finalCart);
        document.dispatchEvent(new CustomEvent('zootify:bf-best-offer-synced', {
          detail: { code: currentCodeSignature(finalCart), count: finalCart.item_count },
        }));
      });
    } catch (error) {
      console.warn('[ZOOTIFY BF] Could not verify automatic offer.', error);
    } finally {
      processing = false;
      if (needsAnotherCheck) {
        needsAnotherCheck = false;
        schedule('next-check');
      }
    }
  }

  // Called *inside* the native cart quantity queue. No extra dispatch or
  // partial UI morph: the quantity component renders only the final cart.
  async function settleQuantity(cart) {
    if (processing || !enabled(cart, config())) return cart;
    processing = true;
    try {
      return await resolveBest(cart, config());
    } catch (error) {
      console.warn('[ZOOTIFY BF] Quantity updated; offer settlement needs retry.', error);
      needsAnotherCheck = true;
      // A failed response may occur AFTER Shopify accepts a discount change.
      // Fetch the current cart before the quantity component paints anything.
      // When section HTML is absent it fetches fresh final markup itself.
      try { return await cartRequest(''); }
      catch { return cart; }
    } finally {
      processing = false;
      if (needsAnotherCheck) {
        needsAnotherCheck = false;
        schedule('next-check');
      }
    }
  }

  function schedule(reason) {
    if (reason === EVENT_SOURCE || document.hidden) return;
    clearTimeout(timer);
    timer = setTimeout(reconcile, DEBOUNCE_MS);
  }

  document.addEventListener('cart:update', (event) => {
    if (event.detail?.data?.source !== EVENT_SOURCE) schedule('cart-update');
  });
  document.addEventListener('discount:update', () => schedule('discount-update'));
  document.addEventListener('zootify:cart-transaction', () => {
    if (!processing && !window.__zootifyCartQueueV1?.pending) schedule('cart-transaction-complete');
  });
  document.addEventListener('zootify:bf-state', () => schedule('campaign-state'));
  window.addEventListener('pageshow', () => schedule('pageshow'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule('visible'); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => schedule('page-load'), { once: true });
  } else {
    schedule('page-load');
  }

  window.ZootifyBFAutoBest = {
    get status() { return { autoAppliedCount, lastCheckedComposition, lastFailed, processing }; },
    settleQuantity,
    // Read-only testing hook. Do not use this to fabricate prices in the UI.
    estimate: (cart) => campaignRules(cart, config()),
    sync: () => schedule('manual-sync'),
  };
})();
