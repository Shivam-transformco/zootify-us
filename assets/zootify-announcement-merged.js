(() => {
  const tagName = 'zootify-announcement-v1';
  if (customElements.get(tagName)) return;
  class ZootifyAnnouncement extends HTMLElement {
    connectedCallback() { this.startFrame = requestAnimationFrame(() => this.initialize()); }
    initialize() {
      if (!this.isConnected || this.initialized) return;
      this.initialized = true;
      this.abortController = new AbortController();
      this.wrapper = this.closest('.zootify-announcement-section');
      this.allSlides = Array.from(this.querySelectorAll('[data-message]'));
      this.slides = this.allSlides.filter(slide => !slide.hidden);
      this.status = this.querySelector('[data-status]');
      this.isEditor = this.dataset.designMode === 'true' || Boolean(window.Shopify?.designMode);
      this.index = 0;
      this.hovered = false;
      this.inView = !('IntersectionObserver' in window);
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.userPaused = this.reducedMotion.matches;
      this.hasInteracted = false;
      this.editorSelectedId = '';
      this.editorSectionSelected = false;
      this.interval = Math.max(5, Math.min(15, Number(this.dataset.interval) || 7)) * 1000;
      this.autoRotate = this.dataset.autoRotate === 'true' && this.slides.length > 1;
      this.campaignKey = null;
      this.dismissed = !this.isEditor && this.isStoredDismissal();
      this.hidden = this.dismissed;
      if (this.wrapper) this.wrapper.hidden = this.dismissed;
      this.setAttribute('data-ready', '');
      this.setupStickyOffset();
      this.listen(this, 'click', event => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('button[data-action]');
        if (!button || !this.contains(button) || button.disabled) return;
        if (button.dataset.action === 'previous') this.show(this.index - 1, true);
        else if (button.dataset.action === 'next') this.show(this.index + 1, true);
        else if (button.dataset.action === 'close') this.dismiss();
      });
      this.listen(this, 'pointerenter', event => {
        if (event.pointerType === 'mouse') { this.hovered = true; this.stop(); }
      });
      this.listen(this, 'pointerleave', event => {
        if (event.pointerType === 'mouse') { this.hovered = false; this.schedule(); }
      });
      this.listen(this, 'focusin', () => { this.userPaused = true; this.hasInteracted = true; this.stop(); });
      this.listen(document, 'visibilitychange', () => this.schedule());
      this.listen(document, 'zootify:bf-state', () => this.syncCampaign());
      this.listen(this, 'zootify:countdown-state', () => this.syncCampaign());
      this.listen(this.reducedMotion, 'change', event => { if (event.matches) this.userPaused = true; this.schedule(); });
      if ('IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(entries => {
          this.inView = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
          this.schedule();
        });
        this.observer.observe(this);
      }
      if (this.isEditor) {
        this.listen(document, 'shopify:block:select', event => {
          const id = String(event.detail?.blockId || '');
          if (this.allSlides.some(slide => slide.dataset.blockId === id)) this.selectEditorBlock(id);
        });
        this.listen(document, 'shopify:block:deselect', event => {
          if (String(event.detail?.blockId || '') === this.editorSelectedId) this.selectEditorBlock('');
        });
        this.listen(document, 'shopify:section:select', event => {
          if (String(event.detail?.sectionId) === this.dataset.sectionId) { this.editorSectionSelected = true; this.stop(); }
        });
        this.listen(document, 'shopify:section:deselect', event => {
          if (String(event.detail?.sectionId) === this.dataset.sectionId) { this.editorSectionSelected = false; this.schedule(); }
        });
        this.listen(document, 'shopify:section:reorder', event => {
          if (String(event.detail?.sectionId) === this.dataset.sectionId) { this.syncCampaign(true); this.scheduleSticky?.(); }
        });
      }
      this.syncCampaign(true);
    }
    setupStickyOffset() {
      if (this.dataset.sticky !== 'true' || !this.wrapper) return;
      const root = document.documentElement;
      root.dataset.zabStickyOwner = this.id;
      const update = () => {
        this.stickyFrame = 0;
        if (!this.isConnected || !this.wrapper?.isConnected) return;
        const visible = !this.hidden && !this.wrapper.hidden && getComputedStyle(this.wrapper).display !== 'none' && getComputedStyle(this).display !== 'none';
        const height = visible ? Math.ceil(this.wrapper.getBoundingClientRect().height) : 0;
        const value = `${height}px`;
        if (root.style.getPropertyValue('--zab-sticky-height') !== value) root.style.setProperty('--zab-sticky-height', value);
      };
      this.scheduleSticky = () => { if (!this.stickyFrame) this.stickyFrame = requestAnimationFrame(update); };
      if ('ResizeObserver' in window) {
        this.stickyResizeObserver = new ResizeObserver(this.scheduleSticky);
        this.stickyResizeObserver.observe(this.wrapper);
      }
      this.stickyMutationObserver = new MutationObserver(this.scheduleSticky);
      this.stickyMutationObserver.observe(this.wrapper, {attributes: true, attributeFilter: ['hidden', 'style', 'class']});
      this.stickyMutationObserver.observe(this, {attributes: true, attributeFilter: ['hidden', 'style', 'class']});
      this.listen(window, 'resize', this.scheduleSticky);
      this.scheduleSticky();
    }
    listen(target, type, handler) { target.addEventListener(type, handler, {signal: this.abortController.signal}); }
    selectEditorBlock(id) {
      if (!this.isEditor) return;
      if (id && !this.editorSelectedId) this.preEditorPause = this.userPaused;
      this.editorSelectedId = id;
      if (id) { this.userPaused = true; this.hasInteracted = true; }
      else { this.userPaused = Boolean(this.preEditorPause || this.reducedMotion.matches); this.preEditorPause = undefined; }
      this.allSlides.forEach(slide => slide.querySelector('zootify-bf-countdown')?.toggleAttribute('data-editor-selected', Boolean(id && slide.dataset.blockId === id)));
      this.syncCampaign(true);
    }
    syncCampaign(force = false) {
      const phase = window.ZootifyBlackFriday?.getState?.()?.phase || 'off';
      const campaign = this.dataset.bfAnnouncement === 'true' && ['upcoming', 'live', 'incomplete'].includes(phase);
      const currentSlide = this.slides?.[this.index];
      this.allSlides = Array.from(this.querySelectorAll('[data-message]'));
      const focusedSlide = this.allSlides.find(slide => slide.contains(document.activeElement));
      const visible = this.allSlides.filter(slide => {
        if (this.isEditor && this.editorSelectedId === slide.dataset.blockId) return true;
        if (slide.dataset.messageKind === 'countdown') {
          const timer = slide.querySelector('zootify-bf-countdown');
          return timer?.dataset.countdownAvailable === 'true' && (timer.dataset.timerSource === 'custom' || campaign);
        }
        if (slide.hasAttribute('data-bf-standard') && campaign) return false;
        const display = slide.dataset.displayPhase || 'always';
        if (display === 'live') return campaign && phase === 'live';
        if (display === 'campaign') return campaign;
        return true;
      });
      const key = [phase, campaign, this.editorSelectedId, ...visible.map(slide => slide.dataset.blockId)].join('|');
      if (!force && this.campaignKey === key) return;
      this.campaignKey = key;
      this.stop();
      const allowed = new Set(visible);
      this.allSlides.forEach(slide => {
        slide.hidden = !allowed.has(slide);
        if (slide.hidden) { slide.inert = true; slide.setAttribute('aria-hidden', 'true'); slide.classList.remove('is-active'); }
      });
      this.slides = visible;
      const multiple = visible.length > 1;
      this.autoRotate = this.dataset.autoRotate === 'true' && multiple;
      const hasClose = Boolean(this.querySelector('[data-action="close"]'));
      this.style.setProperty('--zab-rail-slots', String(multiple ? (hasClose ? 2 : 1) : (hasClose ? 1 : 0)));
      this.style.setProperty('--zab-rail-gaps', String(multiple && hasClose ? 1 : 0));
      this.querySelectorAll('[data-action="previous"], [data-action="next"]').forEach(button => { button.hidden = !multiple; });
      visible.forEach((slide, index) => {
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-label', (this.dataset.positionLabel || 'Announcement {current} of {total}').replace('{current}', String(index + 1)).replace('{total}', String(visible.length)));
      });
      const hideBar = this.dismissed || !visible.length;
      this.hidden = hideBar;
      if (this.wrapper) this.wrapper.hidden = hideBar;
      this.scheduleSticky?.();
      if (!visible.length) return;
      const selected = this.editorSelectedId ? visible.find(slide => slide.dataset.blockId === this.editorSelectedId) : null;
      const preferred = selected || (visible.includes(focusedSlide) ? focusedSlide : null) || (this.hasInteracted && visible.includes(currentSlide) ? currentSlide : null);
      this.index = preferred ? visible.indexOf(preferred) : 0;
      this.show(this.index, false);
      if (focusedSlide && !visible.includes(focusedSlide)) this.querySelector('[data-action="next"]:not([hidden])')?.focus({preventScroll: true});
    }
    stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    schedule() {
      this.stop();
      if (!this.initialized || !this.autoRotate || this.userPaused || this.editorSelectedId || this.editorSectionSelected || this.hovered || !this.inView || this.hidden || !this.isConnected || document.hidden || !this.getClientRects().length) return;
      this.timer = setTimeout(() => { this.timer = null; this.show(this.index + 1, false); }, this.interval);
    }
    show(next, manual) {
      if (!this.slides?.length) return;
      const index = (next + this.slides.length) % this.slides.length;
      if (manual) { this.userPaused = true; this.hasInteracted = true; }
      if (!manual && index !== this.index && this.slides[this.index]?.contains(document.activeElement)) { this.userPaused = true; this.stop(); return; }
      this.slides.forEach((slide, i) => { const active = i === index; slide.inert = !active; slide.setAttribute('aria-hidden', String(!active)); slide.classList.toggle('is-active', active); });
      this.index = index;
      if (manual && this.status && !this.isEditor) {
        const label = (this.dataset.positionLabel || 'Announcement {current} of {total}').replace('{current}', String(index + 1)).replace('{total}', String(this.slides.length));
        const countdown = this.slides[index].querySelector('zootify-bf-countdown');
        const text = countdown ? [countdown.getAttribute('aria-label'), countdown.querySelector('[data-zbf-countdown-accessible]')?.textContent].filter(Boolean).join(' ') : this.slides[index].querySelector('.zab__copy')?.innerText.trim() || '';
        this.status.textContent = `${label}: ${text}`;
      }
      this.scheduleSticky?.();
      this.schedule();
    }
    isStoredDismissal() {
      if (!this.querySelector('[data-action="close"]')) return false;
      try {
        const key = this.dataset.storageKey;
        if (this.dataset.dismissMode === 'session') return sessionStorage.getItem(key) === 'dismissed';
        if (this.dataset.dismissMode === 'days') {
          const until = Number(localStorage.getItem(key));
          if (Number.isFinite(until) && until > Date.now()) return true;
          if (until) localStorage.removeItem(key);
        }
      } catch (_) {}
      return false;
    }
    dismiss() {
      if (this.isEditor) return;
      const hadFocus = this.contains(document.activeElement);
      try {
        const key = this.dataset.storageKey;
        if (this.dataset.dismissMode === 'session') sessionStorage.setItem(key, 'dismissed');
        if (this.dataset.dismissMode === 'days') localStorage.setItem(key, String(Date.now() + Math.max(1, Math.min(30, Number(this.dataset.dismissDays) || 7)) * 86400000));
      } catch (_) {}
      this.stop(); this.dismissed = true; this.hidden = true;
      if (this.wrapper) this.wrapper.hidden = true;
      this.scheduleSticky?.();
      if (hadFocus && this.wrapper) {
        let sibling = this.wrapper.nextElementSibling;
        while (sibling) {
          const focusable = Array.from(sibling.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]')).find(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
          if (focusable) { focusable.focus({preventScroll: true}); break; }
          sibling = sibling.nextElementSibling;
        }
      }
    }
    disconnectedCallback() {
      cancelAnimationFrame(this.startFrame);
      cancelAnimationFrame(this.stickyFrame);
      this.stop(); this.abortController?.abort(); this.observer?.disconnect();
      this.stickyResizeObserver?.disconnect(); this.stickyMutationObserver?.disconnect();
      if (document.documentElement.dataset.zabStickyOwner === this.id) {
        document.documentElement.style.removeProperty('--zab-sticky-height');
        delete document.documentElement.dataset.zabStickyOwner;
      }
      this.initialized = false;
    }
  }
  customElements.define(tagName, ZootifyAnnouncement);
})();
