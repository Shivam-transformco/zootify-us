(function () {
  if (window.ZootifyBlackFriday) return;
  const node = document.getElementById('zootify-bf-config');
  if (!node) return;
  let config;
  try { config = JSON.parse(node.textContent); } catch { return; }
  const timers = new Set();
  const boot = Date.now();
  let previousSignature = '';
  const formatters = new Map();

  function zonedTimestamp(date, time, zone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return NaN;
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
    const checked = new Date(wall);
    if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day || hour > 23 || minute > 59) return NaN;
    try {
      let formatter = formatters.get(zone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        formatters.set(zone, formatter);
      }
      const partsAt = (value) => Object.fromEntries(formatter.formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
      let result = wall;
      for (let attempt = 0; attempt < 3; attempt++) {
        const parts = partsAt(result);
        const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        const corrected = result + wall - represented;
        if (corrected === result) break;
        result = corrected;
      }
      const parts = partsAt(result);
      if (parts.year !== year || parts.month !== month || parts.day !== day || parts.hour !== hour || parts.minute !== minute) return NaN;
      return result;
    } catch { return NaN; }
  }

  function getState(now = Date.now()) {
    const startMs = zonedTimestamp(config.startDate, config.startTime, config.timezone);
    const endMs = config.endDate ? zonedTimestamp(config.endDate, config.endTime, config.timezone) : NaN;
    const startValid = Number.isFinite(startMs);
    const endValid = Number.isFinite(endMs) && endMs > startMs;
    const invalidEnd = Boolean(config.endDate) && !endValid;
    let actualPhase = 'off';
    if (config.enabled) {
      if (!startValid || invalidEnd) actualPhase = 'incomplete';
      else if (now < startMs) actualPhase = 'upcoming';
      else if (endValid && now >= endMs) actualPhase = 'ended';
      else actualPhase = 'live';
    }
    const preview = Boolean(config.designMode);
    const testing = Boolean(config.enabled && config.releaseReady && config.testMode && config.unpublishedTheme && !preview && startValid && endValid && now < endMs);
    const simulatePhase = Boolean(preview && config.previewPhase && config.previewPhase !== 'schedule' && config.enabled);
    let phase = testing ? 'live' : actualPhase;
    let displayNow = now;
    if (simulatePhase) {
      phase = config.previewPhase === 'last_day' ? 'upcoming' : config.previewPhase;
      if (phase === 'upcoming' && startValid) displayNow = startMs - (config.previewPhase === 'last_day' ? 22 * 3600000 : 48 * 3600000) + (now - boot);
      if (phase === 'live' && endValid) displayNow = Math.max(startMs, endMs - 23 * 3600000) + (now - boot);
    }
    return {
      phase,
      actualPhase,
      preview,
      testing,
      startMs,
      endMs,
      displayNow,
      validSchedule: startValid && endValid,
      canApplyCampaign: Boolean(!preview && config.enabled && config.releaseReady && startValid && endValid && (actualPhase === 'live' || testing))
    };
  }

  function remainingParts(milliseconds) {
    const remaining = Math.max(0, Number(milliseconds) || 0);
    const seconds = remaining > 0 ? Math.max(1, Math.floor(remaining / 1000)) : 0;
    return {
      days: Math.floor(seconds / 86400),
      hours: Math.floor(seconds / 3600) % 24,
      minutes: Math.floor(seconds / 60) % 60,
      seconds: seconds % 60
    };
  }

  function formatRemaining(milliseconds, compact) {
    const parts = remainingParts(milliseconds);
    const labels = config.labels || {};
    const pad = (value) => String(value).padStart(2, '0');
    const values = [];
    if (parts.days > 0) values.push(pad(parts.days) + (compact ? labels.dayShort || 'd' : ' ' + (parts.days === 1 ? labels.day || 'day' : labels.days || 'days')));
    values.push(pad(parts.hours) + (compact ? labels.hourShort || 'h' : ' ' + (labels.hours || 'hrs')));
    values.push(pad(parts.minutes) + (compact ? labels.minuteShort || 'm' : ' ' + (labels.minutes || 'min')));
    values.push(pad(parts.seconds) + (compact ? labels.secondShort || 's' : ' ' + (labels.seconds || 'sec')));
    return values.join(' ');
  }

  function updateRegion(element, state) {
    const campaignVisible = Boolean(config.enabled && (state.phase === 'live' || state.testing));
    if (element.hasAttribute('data-zbf-campaign')) element.hidden = !campaignVisible;
    if (element.hasAttribute('data-zbf-normal')) element.hidden = campaignVisible;
  }

  function updateRegions(state) {
    document.documentElement.dataset.zbfPhase = state.phase;
    document.documentElement.dataset.zbfActualPhase = state.actualPhase;
    document.querySelectorAll('[data-zbf-campaign], [data-zbf-normal]').forEach((element) => updateRegion(element, state));
    document.querySelectorAll('[data-zbf-preview-note]').forEach((element) => { element.hidden = !state.preview; });
  }

  function refresh(force = false) {
    const now = Date.now();
    const state = getState(now);
    const signature = [state.phase, state.actualPhase, state.preview, state.canApplyCampaign, state.startMs, state.endMs].join('|');
    if (force || signature !== previousSignature) {
      previousSignature = signature;
      updateRegions(state);
      document.dispatchEvent(new CustomEvent('zootify:bf-state', { detail: state }));
    }
    for (const timer of timers) timer.update(state, now);
  }

  class ZootifyBFRegion extends HTMLElement {
    connectedCallback() { updateRegion(this, getState()); }
  }

  class ZootifyBFCountdown extends HTMLElement {
    static get observedAttributes() {
      return ['data-timer-source', 'data-prefix', 'data-live-prefix', 'data-mobile-prefix',
        'data-mobile-live-prefix', 'data-custom-date', 'data-custom-time', 'data-custom-timezone',
        'data-editor-selected'];
    }

    connectedCallback() {
      timers.add(this);
      this.update(getState());
      queueMicrotask(() => { if (this.isConnected) this.update(getState()); });
    }

    disconnectedCallback() {
      timers.delete(this);
      this.elements = null;
      this.stateSignature = null;
    }

    attributeChangedCallback() {
      if (this.isConnected) this.update(getState());
    }

    nodes() {
      if (this.elements?.desktop?.isConnected) return this.elements;
      const desktop = this.querySelector('[data-zbf-countdown-desktop]');
      const mobile = this.querySelector('[data-zbf-countdown-mobile]');
      const values = this.querySelector('[data-zbf-countdown-value]');
      const accessible = this.querySelector('[data-zbf-countdown-accessible]');
      if (!desktop || !mobile || !values || !accessible) return null;
      const cells = {};
      for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
        cells[unit] = {
          cell: this.querySelector('[data-zbf-unit="' + unit + '"]'),
          digit: this.querySelector('[data-zbf-digit="' + unit + '"]'),
          label: this.querySelector('[data-zbf-unit-label="' + unit + '"]')
        };
        if (!cells[unit].cell || !cells[unit].digit || !cells[unit].label) return null;
      }
      this.elements = { desktop, mobile, values, accessible, cells };
      return this.elements;
    }

    reminder(state, now) {
      const labels = config.labels || {};
      const compact = this.hasAttribute('data-compact');
      const source = this.dataset.timerSource === 'custom' ? 'custom' : 'campaign';
      const initial = compact ? labels.startsCompact || 'Starts in' : labels.starts || 'Sale starts in';
      let phase = state.phase;
      let available = Boolean(config.enabled) && ['upcoming', 'live', 'incomplete'].includes(phase);
      let message = labels.coming || 'Black Friday is coming';
      let mobileMessage = message;
      let remaining = 0;
      if (source === 'custom') {
        const date = String(this.dataset.customDate || '').trim();
        const time = String(this.dataset.customTime || '00:00').trim();
        const timezone = String(this.dataset.customTimezone || config.timezone || 'UTC').trim();
        const key = [date, time, timezone].join('|');
        if (key !== this.deadlineKey) {
          this.deadlineKey = key;
          this.deadlineMs = zonedTimestamp(date, time, timezone);
        }
        const valid = Number.isFinite(this.deadlineMs);
        phase = !valid ? 'incomplete' : now < this.deadlineMs ? 'running' : 'ended';
        available = phase === 'running';
        message = this.dataset.prefix || initial;
        mobileMessage = this.dataset.mobilePrefix || message;
        if (available) remaining = this.deadlineMs - now;
        else {
          message = phase === 'incomplete' ? labels.configure || 'Set a deadline to preview this reminder' : labels.reminderEnded || 'This reminder has ended';
          mobileMessage = message;
        }
      } else if (phase === 'upcoming' && Number.isFinite(state.startMs)) {
        remaining = Math.max(0, state.startMs - state.displayNow);
        if (remaining > 0) {
          message = this.dataset.prefix || initial;
          mobileMessage = this.dataset.mobilePrefix || message;
        }
      } else if (phase === 'live') {
        message = labels.live || 'Black Friday is live';
        mobileMessage = message;
        if (Number.isFinite(state.endMs) && state.endMs > state.startMs) {
          remaining = Math.max(0, state.endMs - state.displayNow);
          if (remaining > 0) {
            message = this.dataset.livePrefix || (compact ? labels.endsCompact || 'Ends in' : labels.ends || 'Sale ends in');
            mobileMessage = this.dataset.mobileLivePrefix || message;
          }
        }
      } else if (phase === 'ended') {
        message = labels.ended || 'Black Friday has ended';
        mobileMessage = message;
      }
      return { source, phase, available, message, mobileMessage, remaining };
    }

    update(state, now = Date.now()) {
      const elements = this.nodes();
      if (!elements) return;
      const reminder = this.reminder(state, now);
      const labels = config.labels || {};
      const compact = this.hasAttribute('data-compact');
      const editorSelected = Boolean(config.designMode && this.hasAttribute('data-editor-selected'));
      const hidden = !reminder.available && !editorSelected;
      if (this.hidden !== hidden) this.hidden = hidden;
      if (elements.desktop.textContent !== reminder.message) elements.desktop.textContent = reminder.message;
      if (elements.mobile.textContent !== reminder.mobileMessage) elements.mobile.textContent = reminder.mobileMessage;
      if (this.getAttribute('aria-label') !== reminder.message) this.setAttribute('aria-label', reminder.message);
      const hasValue = reminder.remaining > 0 && reminder.available;
      if (elements.values.hidden === hasValue) elements.values.hidden = !hasValue;
      let accessible = '';
      if (hasValue) {
        const parts = remainingParts(reminder.remaining);
        const names = compact
          ? { days: labels.dayShort || 'd', hours: labels.hourShort || 'h', minutes: labels.minuteShort || 'm', seconds: labels.secondShort || 's' }
          : { days: parts.days === 1 ? labels.day || 'day' : labels.days || 'days', hours: labels.hours || 'hrs', minutes: labels.minutes || 'min', seconds: labels.seconds || 'sec' };
        for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
          const cell = elements.cells[unit];
          const value = String(parts[unit]).padStart(2, '0');
          if (cell.digit.textContent !== value) cell.digit.textContent = value;
          if (cell.label.textContent !== names[unit]) cell.label.textContent = names[unit];
        }
        const hideDays = parts.days === 0;
        if (elements.cells.days.cell.hidden !== hideDays) elements.cells.days.cell.hidden = hideDays;
        accessible = formatRemaining(reminder.remaining, false);
      }
      if (elements.accessible.textContent !== accessible) elements.accessible.textContent = accessible;
      const available = String(reminder.available);
      if (this.dataset.countdownAvailable !== available) this.dataset.countdownAvailable = available;
      if (this.dataset.countdownPhase !== reminder.phase) this.dataset.countdownPhase = reminder.phase;
      const signature = [reminder.source, reminder.phase, reminder.available].join('|');
      if (signature !== this.stateSignature) {
        this.stateSignature = signature;
        this.dispatchEvent(new CustomEvent('zootify:countdown-state', {
          bubbles: true, detail: { source: reminder.source, phase: reminder.phase, available: reminder.available }
        }));
      }
    }
  }

  window.ZootifyBlackFriday = Object.freeze({ config, getState, zonedTimestamp, remainingParts, formatRemaining, refresh });
  if (!customElements.get('zootify-bf-region')) customElements.define('zootify-bf-region', ZootifyBFRegion);
  if (!customElements.get('zootify-bf-countdown')) customElements.define('zootify-bf-countdown', ZootifyBFCountdown);
  refresh(true);
  window.setInterval(() => { if (!document.hidden) refresh(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  window.addEventListener('pageshow', () => refresh(true));
  document.addEventListener('shopify:section:load', () => refresh(true));
})();
