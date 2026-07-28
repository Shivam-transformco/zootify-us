/* ===============================
   WISHLIST STORAGE
   =============================== */

function getWishlist() {
  return JSON.parse(localStorage.getItem('wishlist')) || [];
}

function saveWishlist(items) {
  localStorage.setItem('wishlist', JSON.stringify(items));
  document.dispatchEvent(new CustomEvent('wishlist:updated'));
}

/* ===============================
   PRODUCT FETCH
   =============================== */

async function fetchProduct(handle) {
  const res = await fetch(`/products/${handle}.js`);
  if (!res.ok) return null;
  return res.json();
}

/* ===============================
   MONEY FORMAT
   =============================== */

function formatMoney(cents) {
  return (cents / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: 'INR' // change if needed
  });
}

/* ===============================
   PRODUCT CARD MARKUP
   =============================== */

function productCard(product) {
  const hasCompare =
    product.compare_at_price &&
    product.compare_at_price > product.price;

  return `
    <div class="wishlist-card" data-product-id="${product.id}">
      <button
        class="wishlist-remove"
        aria-label="Remove from wishlist"
      >
        ×
      </button>

      <a href="/products/${product.handle}">
        <img src="${product.featured_image}" alt="${product.title}">
      </a>

      <h3>${product.title}</h3>

      <div class="wishlist-price">
        <span class="wishlist-price-current">
          ${formatMoney(product.price)}
        </span>

        ${
          hasCompare
            ? `<span class="wishlist-price-compare">
                 ${formatMoney(product.compare_at_price)}
               </span>`
            : ''
        }
      </div>
    </div>
  `;
}

/* ===============================
   RENDER WISHLIST PAGE
   =============================== */

async function renderWishlist() {
  const grid = document.getElementById('wishlist-products');
  const empty = document.getElementById('wishlist-empty');
  if (!grid) return;

  const wishlist = getWishlist();

  if (!wishlist.length) {
    grid.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;

  let html = '';
  for (const item of wishlist) {
    if (!item.handle) continue;
    const product = await fetchProduct(item.handle);
    if (product) html += productCard(product);
  }

  grid.innerHTML = html;
}

/* ===============================
   REMOVE ITEM (FIXED BUG)
   =============================== */

document.addEventListener('click', e => {
  const btn = e.target.closest('.wishlist-remove');
  if (!btn) return;

  const card = btn.closest('.wishlist-card');
  if (!card) return;

  const productId = card.dataset.productId;

  let wishlist = getWishlist();

  /* 🔥 FIX: type-safe comparison */
  wishlist = wishlist.filter(
    item => String(item.id) !== String(productId)
  );

  saveWishlist(wishlist);
  renderWishlist();
});

/* ===============================
   HEADER COUNTER + BUTTON STATE
   =============================== */

function updateWishlistUI() {
  const wishlist = getWishlist();

  /* Header counter */
  const counter = document.querySelector('[data-wishlist-count]');
  if (counter) {
    counter.textContent = wishlist.length;
    counter.toggleAttribute('hidden', wishlist.length === 0);
  }

  /* PDP + Collection button states */
  document
    .querySelectorAll('.collection-wishlist-btn, .pdp-wishlist-btn')
    .forEach(btn => {
      const id = btn.dataset.productId;
      btn.classList.toggle(
        'is-active',
        wishlist.some(item => String(item.id) === String(id))
      );
    });
}

/* ===============================
   TOGGLE FROM PDP / COLLECTION
   =============================== */

document.addEventListener('click', e => {
  const btn = e.target.closest(
    '.collection-wishlist-btn, .pdp-wishlist-btn'
  );
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  const id = btn.dataset.productId;
  const handle = btn.dataset.productHandle;

  if (!id || !handle) {
    console.error('Wishlist error: missing product data');
    return;
  }

  let wishlist = getWishlist();
  const exists = wishlist.some(item => String(item.id) === String(id));

  wishlist = exists
    ? wishlist.filter(item => String(item.id) !== String(id))
    : [...wishlist, { id, handle }];

  saveWishlist(wishlist);
  updateWishlistUI();
});

/* ===============================
   INIT
   =============================== */

document.addEventListener('DOMContentLoaded', () => {
  renderWishlist();
  updateWishlistUI();
});

document.addEventListener('wishlist:updated', () => {
  renderWishlist();
  updateWishlistUI();
});
