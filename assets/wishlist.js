function getWishlist() {
  return JSON.parse(localStorage.getItem('wishlist')) || [];
}

function saveWishlist(items) {
  localStorage.setItem('wishlist', JSON.stringify(items));
  document.dispatchEvent(new CustomEvent('wishlist:updated'));
}

function updateUI() {
  const wishlist = getWishlist();

  /* HEADER COUNTER */
  const counter = document.querySelector('[data-wishlist-count]');
  if (counter) {
    counter.textContent = wishlist.length;
    counter.toggleAttribute('hidden', wishlist.length === 0);
  }

  /* BUTTON STATES */
  document
    .querySelectorAll('.collection-wishlist-btn, .pdp-wishlist-btn')
    .forEach(btn => {
      const id = Number(btn.dataset.productId);

      btn.classList.toggle(
        'is-active',
        wishlist.some(item => Number(item.id) === id)
      );
    });
}

/* CLICK HANDLER */
document.addEventListener('click', e => {
  const btn = e.target.closest(
    '.collection-wishlist-btn, .pdp-wishlist-btn'
  );
  if (!btn) return;

  e.preventDefault(); // ✅ keep
  // ❌ DO NOT stopPropagation

  const id = Number(btn.dataset.productId);
  const handle = btn.dataset.productHandle;

  if (!id || !handle) {
    console.error('Wishlist error: product id or handle missing');
    return;
  }

  let wishlist = getWishlist();
  const exists = wishlist.find(p => Number(p.id) === id);

  if (exists) {
    wishlist = wishlist.filter(p => Number(p.id) !== id);
  } else {
    wishlist.push({ id, handle });
  }

  saveWishlist(wishlist);
  updateUI();
});

/* INIT */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateUI);
} else {
  updateUI();
}
document.addEventListener('wishlist:updated', updateUI);
window.addEventListener('pageshow', (e) => { if (e.persisted) updateUI(); });

/* RE-APPLY after header morph resets the counter */
function observeCounter() {
  const counter = document.querySelector('[data-wishlist-count]');
  if (!counter) return;
  new MutationObserver(() => updateUI()).observe(counter, {
    attributes: true,
    attributeFilter: ['hidden'],
    characterData: true,
    subtree: true,
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeCounter);
} else {
  observeCounter();
}
