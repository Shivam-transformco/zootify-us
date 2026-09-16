import { Component } from '@theme/component';
import { fetchConfig, preloadImage, onAnimationEnd, yieldToMainThread } from '@theme/utilities';
import { ThemeEvents, CartAddEvent, CartErrorEvent, CartUpdateEvent, VariantUpdateEvent } from '@theme/events';
import { cartPerformance } from '@theme/performance';
import { morph } from '@theme/morph';

// Error message display duration - gives users time to read the message
const ERROR_MESSAGE_DISPLAY_DURATION = 10000;

// Button re-enable delay after error - prevents rapid repeat attempts
const ERROR_BUTTON_REENABLE_DELAY = 1000;

// Success message display duration for screen readers
const SUCCESS_MESSAGE_DISPLAY_DURATION = 5000;

// ZOOTIFY: one real product-page button is used on desktop and mobile.
const GO_TO_CART_TEXT = 'GO TO CART';
const ADDING_TO_CART_TEXT = 'ADDING…';
const CART_BUTTON_LABEL = '.add-to-cart-text__content > span > span';

/** @param {HTMLButtonElement | undefined} button */
function isProductPageButton(button) {
  return Boolean(
    button?.matches('[data-testid="standalone-add-to-cart"]') &&
      !button.closest('.quick-add-modal, product-card')
  );
}

/**
 * @typedef {HTMLElement & {
 *   source: Element,
 *   destination: Element,
 *   useSourceSize: string | boolean
 * }} FlyToCart
 */

/**
 * A custom element that manages an add to cart button.
 *
 * @typedef {object} AddToCartRefs
 * @property {HTMLButtonElement} addToCartButton - The add to cart button.
 * @extends Component<AddToCartRefs>
 */
export class AddToCartComponent extends Component {
  requiredRefs = ['addToCartButton'];

  /** @type {number[] | undefined} */
  #resetTimeouts = /** @type {number[]} */ ([]);
  #animationId = 0;

  connectedCallback() {
    super.connectedCallback();

    this.addEventListener('pointerenter', this.#preloadImage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.cancelAddToCartAnimation();
    this.removeEventListener('pointerenter', this.#preloadImage);
  }

  /**
   * Disables the add to cart button.
   */
  disable() {
    this.refs.addToCartButton.disabled = true;
  }

  /**
   * Enables the add to cart button.
   */
  enable() {
    this.refs.addToCartButton.disabled = false;
  }

  /**
   * Handles the click event for the add to cart button.
   * @param {MouseEvent & {target: HTMLElement}} event - The click event.
   */
  handleClick(event) {
    const { addToCartButton } = this.refs;

    if (
      addToCartButton.disabled ||
      this.closest('product-form-component')?.hasAttribute('data-zootify-submitting')
    ) {
      event.preventDefault();
      return;
    }

    // If the selected variant is already in the cart, use the same button to open the cart.
    if (addToCartButton.dataset.goToCart === 'true') {
      event.preventDefault();
      window.location.href = Theme.routes.cart_url || '/cart';
      return;
    }

    const form = this.closest('form');
    if (!form?.checkValidity()) return;

    // Check if adding would exceed max before animating
    const productForm = /** @type {ProductFormComponent | null} */ (this.closest('product-form-component'));
    const quantitySelector = productForm?.refs.quantitySelector;
    if (quantitySelector?.canAddToCart) {
      const validation = quantitySelector.canAddToCart();
      // Don't animate if it would exceed max
      if (!validation.canAdd) {
        return;
      }
    }
    // Product-page success feedback starts only after Shopify confirms the add.
    // Quick-add cards/modals retain their existing click animation.
    if (isProductPageButton(addToCartButton) && productForm) return;

    if (this.refs.addToCartButton.dataset.puppet !== 'true') {
      const animationEnabled = this.dataset.addToCartAnimation === 'true';
      if (animationEnabled && !event.target.closest('.quick-add-modal')) {
        this.#animateFlyToCart();
      }
      this.animateAddToCart();
    }
  }

  /** Play the existing effects after a confirmed product-page addition. */
  animateConfirmedAddition() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (this.dataset.addToCartAnimation === 'true') this.#animateFlyToCart();
    void this.animateAddToCart();
  }

  /** Invalidate old animation callbacks when a variant or component changes. */
  cancelAddToCartAnimation() {
    ++this.#animationId;
    this.#resetTimeouts?.forEach((timeoutId) => clearTimeout(timeoutId));
    this.#resetTimeouts = [];
    this.refs.addToCartButton?.removeAttribute('data-added');
  }

  #preloadImage = () => {
    const image = this.dataset.productVariantMedia;

    if (!image) return;

    preloadImage(image);
  };

  /**
   * Animates the fly to cart animation.
   */
  #animateFlyToCart() {
    const { addToCartButton } = this.refs;
    const cartIcon = document.querySelector('.header-actions__cart-icon');

    const image = this.dataset.productVariantMedia;

    if (!cartIcon || !addToCartButton || !image) return;

    const flyToCartElement = /** @type {FlyToCart} */ (document.createElement('fly-to-cart'));

    let flyToCartClass = addToCartButton.classList.contains('quick-add__button')
      ? 'fly-to-cart--quick'
      : 'fly-to-cart--main';

    flyToCartElement.classList.add(flyToCartClass);
    flyToCartElement.style.setProperty('background-image', `url(${image})`);
    flyToCartElement.style.setProperty('--start-opacity', '0');
    flyToCartElement.source = addToCartButton;
    flyToCartElement.destination = cartIcon;

    document.body.appendChild(flyToCartElement);
  }

  /**
   * Animates the add to cart button.
   */
  animateAddToCart = async function () {
    const { addToCartButton } = this.refs;

    // Keep the theme's existing effect and display duration.
    this.cancelAddToCartAnimation();
    const animationId = this.#animationId;

    if (addToCartButton.dataset.added !== 'true') {
      addToCartButton.dataset.added = 'true';
    }

    // The onAnimationEnd can trigger a style recalculation so we yield to the main thread first.
    await yieldToMainThread();
    await onAnimationEnd(addToCartButton);
    if (animationId !== this.#animationId || !addToCartButton.isConnected) return;

    // Create new timeout and store it in the array
    const timeoutId = setTimeout(() => {
      if (animationId !== this.#animationId) return;

      // Set the final label BEFORE revealing it. Do not flash ADD TO CART again.
      if (isProductPageButton(addToCartButton)) {
        const label = addToCartButton.querySelector(CART_BUTTON_LABEL);
        if (label) {
          label.textContent = addToCartButton.dataset.goToCart === 'true'
            ? GO_TO_CART_TEXT
            : addToCartButton.dataset.defaultAddToCartText || Theme.translations?.add_to_cart || 'ADD TO CART';
        }
      }
      addToCartButton.removeAttribute('data-added');

      // Remove this timeout from the array
      const index = this.#resetTimeouts.indexOf(timeoutId);
      if (index > -1) {
        this.#resetTimeouts.splice(index, 1);
      }
    }, 800);

    this.#resetTimeouts.push(timeoutId);
  };
}

if (!customElements.get('add-to-cart-component')) {
  customElements.define('add-to-cart-component', AddToCartComponent);
}

/**
 * A custom element that manages a product form.
 *
 * @typedef {{items: Array<{quantity: number, variant_id: number}>}} Cart
 *
 * @typedef {object} ProductFormRefs
 * @property {HTMLInputElement} variantId - The form input for submitting the variant ID.
 * @property {AddToCartComponent | undefined} addToCartButtonContainer - The add to cart button container element.
 * @property {HTMLElement | undefined} addToCartTextError - The add to cart text error.
 * @property {HTMLElement | undefined} acceleratedCheckoutButtonContainer - The accelerated checkout button container element.
 * @property {HTMLElement} liveRegion - The live region.
 * @property {HTMLElement | undefined} quantityLabelCartCount - The quantity label cart count element.
 * @property {HTMLElement | undefined} quantityRules - The quantity rules element.
 * @property {HTMLElement | undefined} productFormButtons - The product form buttons container.
 * @property {HTMLElement | undefined} volumePricing - The volume pricing component.
 * @property {any | undefined} quantitySelector - The quantity selector component.
 * @property {HTMLElement | undefined} quantitySelectorWrapper - The quantity selector wrapper element.
 * @property {HTMLElement | undefined} quantityLabel - The quantity label element.
 * @property {HTMLElement | undefined} pricePerItem - The price per item component.
 *
 * @extends Component<ProductFormRefs>
 */
class ProductFormComponent extends Component {
  requiredRefs = ['variantId', 'liveRegion'];
  #abortController = new AbortController();
  #cartRequestId = 0;
  #cartQuantity = 0;
  #variantUpdating = false;

  /** @type {number | undefined} */
  #timeout;

  connectedCallback() {
    super.connectedCallback();

    if (this.#abortController.signal.aborted) this.#abortController = new AbortController();
    const { signal } = this.#abortController;
    const target = this.closest('.shopify-section, dialog, product-card');
    target?.addEventListener(ThemeEvents.variantUpdate, this.#onVariantUpdate, { signal });
    target?.addEventListener(ThemeEvents.variantSelected, this.#onVariantSelected, { signal });

    // Listen for cart updates to sync data-cart-quantity
    document.addEventListener(ThemeEvents.cartUpdate, this.#onCartUpdate, { signal });
    window.addEventListener('pageshow', this.#onPageShow, { signal });

    // Sync the initial button state in case the selected variant is already in the cart.
    // Waiting one microtask ensures the product-form child refs are available after initial parsing.
    queueMicrotask(() => {
      if (!this.isConnected) return;
      this.#rememberDefaultButtonState();
      void this.#fetchAndUpdateCartQuantity();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#abortController.abort();
    ++this.#cartRequestId;
  }

  /** Refresh a browser-restored product page after visiting the cart. */
  #onPageShow = (event) => {
    if (event.persisted) void this.#fetchAndUpdateCartQuantity();
  };

  /** Save Shopify's normal label/availability, not a temporary loading label. */
  #rememberDefaultButtonState() {
    const button = this.refs.addToCartButtonContainer?.refs.addToCartButton;
    if (!button || !isProductPageButton(button)) return;
    const text = button.querySelector(CART_BUTTON_LABEL)?.textContent?.trim();
    if (!text || text === GO_TO_CART_TEXT || text === ADDING_TO_CART_TEXT) return;
    button.dataset.defaultAddToCartText = text;
    button.dataset.defaultAddToCartDisabled = String(button.disabled);
  }

  /**
   * Updates quantity selector with cart data for current variant
   * @param {Cart} cart - The cart object with items array
   * @returns {number} The cart quantity for the current variant
   */
  #updateCartQuantityFromData(cart) {
    const variantIdInput = /** @type {HTMLInputElement | null} */ (this.querySelector('input[name="id"]'));
    if (!variantIdInput?.value || !cart?.items) return 0;

    // A variant can occupy more than one line (for example, with line-item properties).
    const cartQty = cart.items.reduce(
      (quantity, item) => quantity + (String(item.variant_id) === variantIdInput.value ? Number(item.quantity) : 0),
      0
    );

    // Use public API to update quantity selector
    const quantitySelector = /** @type {any | undefined} */ (this.querySelector('quantity-selector-component'));
    if (quantitySelector?.setCartQuantity) {
      quantitySelector.setCartQuantity(cartQty);
    }

    // Update quantity label if it exists
    this.#updateQuantityLabel(cartQty);

    // Keep the main purchase button in sync with the selected variant's cart state.
    this.#updateAddToCartButtonState(cartQty);

    return cartQty;
  }

  /**
   * Render the current cart state on the single product-page button.
   * @param {number} cartQty - Quantity of the selected variant in the cart.
   */
  #updateAddToCartButtonState(cartQty) {
    this.#cartQuantity = cartQty;
    const button = this.refs.addToCartButtonContainer?.refs.addToCartButton;
    if (!button || !isProductPageButton(button)) return;
    const label = button.querySelector(CART_BUTTON_LABEL);
    if (!(label instanceof HTMLElement)) return;

    if (!button.dataset.defaultAddToCartText) this.#rememberDefaultButtonState();
    const submitting = this.hasAttribute('data-zootify-submitting');
    const inCart = cartQty > 0;
    if (inCart) button.dataset.goToCart = 'true';
    else button.removeAttribute('data-go-to-cart');

    // During the checkmark effect, keep the label hidden until its reset callback.
    if (button.dataset.added !== 'true') {
      label.textContent = submitting ? ADDING_TO_CART_TEXT : inCart
        ? GO_TO_CART_TEXT
        : button.dataset.defaultAddToCartText || 'ADD TO CART';
    }

    button.disabled = submitting || this.#variantUpdating ||
      (!inCart && button.dataset.defaultAddToCartDisabled === 'true');
    if (submitting) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  /**
   * Fetches cart and updates quantity selector for current variant
   * @returns {Promise<number>} The cart quantity for the current variant
   */
  async #fetchAndUpdateCartQuantity() {
    const variantIdInput = /** @type {HTMLInputElement | null} */ (this.querySelector('input[name="id"]'));
    if (!variantIdInput?.value) return 0;

    const variantId = variantIdInput.value;
    const requestId = ++this.#cartRequestId;
    try {
      const response = await fetch(`${window.Shopify?.routes?.root || '/'}cart.js`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Cart refresh failed (${response.status})`);
      const cart = await response.json();

      // An older cart read must not undo a confirmed add or a newer variant selection.
      if (!this.isConnected || requestId !== this.#cartRequestId || this.refs.variantId.value !== variantId) {
        return this.#cartQuantity;
      }
      return this.#updateCartQuantityFromData(cart);
    } catch (error) {
      console.error('Failed to fetch cart quantity:', error);
      return 0;
    }
  }

  /**
   * Updates data-cart-quantity when cart is updated from elsewhere
   * @param {CartUpdateEvent|CartAddEvent} event
   */
  #onCartUpdate = async (event) => {
    // Skip if this event came from this component
    if (event.target === this || (this.id && event.detail?.sourceId === this.id)) return;

    const cart = /** @type {Cart} */ (event.detail?.resource);
    if (cart?.items && event.detail?.data?.source !== 'product-form-component') {
      ++this.#cartRequestId;
      this.#updateCartQuantityFromData(cart);
    } else {
      await this.#fetchAndUpdateCartQuantity();
    }
  };

  /**
   * Handles the submit event for the product form.
   *
   * @param {Event} event - The submit event.
   */
  handleSubmit(event) {
    const { addToCartTextError } = this.refs;
    // Stop default behaviour from the browser
    event.preventDefault();

    const mainContainer = this.refs.addToCartButtonContainer;
    const mainButton = mainContainer?.refs.addToCartButton;
    const mainPurchase = isProductPageButton(mainButton);
    if (mainPurchase && (this.hasAttribute('data-zootify-submitting') || this.#variantUpdating)) return;
    // Also cover keyboard / requestSubmit(), not only a pointer click.
    if (mainPurchase && mainButton?.dataset.goToCart === 'true') {
      window.location.href = Theme.routes.cart_url || '/cart';
      return;
    }

    if (this.#timeout) clearTimeout(this.#timeout);

    // Query for ALL add-to-cart components
    const allAddToCartContainers = /** @type {NodeListOf<AddToCartComponent>} */ (
      this.querySelectorAll('add-to-cart-component')
    );

    // Check if ANY add to cart button is disabled and do an early return if it is
    const anyButtonDisabled = Array.from(allAddToCartContainers).some(
      (container) => container.refs.addToCartButton?.disabled
    );
    if (anyButtonDisabled) return;

    // Send the add to cart information to the cart
    const form = this.querySelector('form');

    if (!form) throw new Error('Product form element missing');

    if (this.refs.quantitySelector?.canAddToCart) {
      const validation = this.refs.quantitySelector.canAddToCart();

      if (!validation.canAdd) {
        // Disable ALL add-to-cart buttons
        for (const container of allAddToCartContainers) {
          container.disable();
        }

        const errorTemplate = this.dataset.quantityErrorMax || '';
        const errorMessage = errorTemplate.replace('{{ maximum }}', validation.maxQuantity?.toString() || '');
        if (addToCartTextError) {
          addToCartTextError.classList.remove('hidden');

          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = errorMessage;
          } else {
            const newTextNode = document.createTextNode(errorMessage);
            addToCartTextError.appendChild(newTextNode);
          }

          this.#setLiveRegionText(errorMessage);

          if (this.#timeout) clearTimeout(this.#timeout);
          this.#timeout = setTimeout(() => {
            if (!addToCartTextError) return;
            addToCartTextError.classList.add('hidden');
            this.#clearLiveRegionText();
          }, ERROR_MESSAGE_DISPLAY_DURATION);
        }

        setTimeout(() => {
          // Re-enable ALL add-to-cart buttons
          for (const container of allAddToCartContainers) {
            container.enable();
          }
        }, ERROR_BUTTON_REENABLE_DELAY);

        return;
      }
    }

    const formData = new FormData(form);

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    let cartItemComponentsSectionIds = [];
    cartItemsComponents.forEach((item) => {
      if (item instanceof HTMLElement && item.dataset.sectionId) {
        cartItemComponentsSectionIds.push(item.dataset.sectionId);
      }
      formData.append('sections', cartItemComponentsSectionIds.join(','));
    });

    const fetchCfg = fetchConfig('javascript', { body: formData });
    const submittedVariantId = String(formData.get('id') || '');
    const submittedProductId = this.dataset.productId;
    if (mainPurchase) {
      this.#rememberDefaultButtonState();
      ++this.#cartRequestId;
      this.setAttribute('data-zootify-submitting', '');
      this.#updateAddToCartButtonState(this.#cartQuantity);
    }

    fetch(Theme.routes.cart_add_url, {
      ...fetchCfg,
      headers: {
        ...fetchCfg.headers,
        Accept: 'text/html',
      },
    })
      .then(async (httpResponse) => {
        const response = await httpResponse.json();
        if (!httpResponse.ok && !response.status) response.status = httpResponse.status;
        return response;
      })
      .then(async (response) => {
        if (response.status) {
          // Shopify can partially add a quantity even when returning a stock error.
          if (mainPurchase) void this.#fetchAndUpdateCartQuantity();
          this.dispatchEvent(
            new CartErrorEvent(form.getAttribute('id') || '', response.message, response.description, response.errors)
          );

          if (!addToCartTextError) return;
          addToCartTextError.classList.remove('hidden');

          // Reuse the text node if the user is spam-clicking
          const textNode = addToCartTextError.childNodes[2];
          if (textNode) {
            textNode.textContent = response.message;
          } else {
            const newTextNode = document.createTextNode(response.message);
            addToCartTextError.appendChild(newTextNode);
          }

          // Create or get existing error live region for screen readers
          this.#setLiveRegionText(response.message);

          this.#timeout = setTimeout(() => {
            if (!addToCartTextError) return;
            addToCartTextError.classList.add('hidden');

            // Clear the announcement
            this.#clearLiveRegionText();
          }, ERROR_MESSAGE_DISPLAY_DURATION);

          // When we add more than the maximum amount of items to the cart, we need to dispatch a cart update event
          // because our back-end still adds the max allowed amount to the cart.
          this.dispatchEvent(
            new CartAddEvent({}, this.id, {
              didError: true,
              source: 'product-form-component',
              itemCount: Number(formData.get('quantity')) || Number(this.dataset.quantityDefault),
              productId: submittedProductId,
            })
          );

          return;
        } else {
          const id = formData.get('id');

          if (addToCartTextError) {
            addToCartTextError.classList.add('hidden');
            addToCartTextError.removeAttribute('aria-live');
          }

          if (!id) throw new Error('Form ID is required');

          // Add aria-live region to inform screen readers that the item was added
          // Get the added text from any add-to-cart button
          const anyAddToCartButton = allAddToCartContainers[0]?.refs.addToCartButton;
          if (anyAddToCartButton) {
            const addedTextElement = anyAddToCartButton.querySelector('.add-to-cart-text--added');
            const addedText = addedTextElement?.textContent?.trim() || Theme.translations.added;

            this.#setLiveRegionText(addedText);

            setTimeout(() => {
              this.#clearLiveRegionText();
            }, SUCCESS_MESSAGE_DISPLAY_DURATION);
          }

          if (mainPurchase) {
            // The successful add response confirms presence; do not wait for a second request.
            const addedItems = Array.isArray(response.items) ? response.items : [response];
            const addedQuantity = addedItems.reduce((quantity, item) => quantity +
              (String(item.variant_id ?? item.id) === submittedVariantId ? Number(item.quantity) || 0 : 0), 0);
            ++this.#cartRequestId;
            if (this.isConnected && !this.#variantUpdating && this.refs.variantId.value === submittedVariantId && addedQuantity > 0) {
              this.refs.addToCartButtonContainer?.animateConfirmedAddition();
              this.#updateAddToCartButtonState(addedQuantity);
            }
            // Reconcile quantity rules in parallel; the button no longer waits for this.
            void this.#fetchAndUpdateCartQuantity();
          } else {
            await this.#fetchAndUpdateCartQuantity();
          }

          this.dispatchEvent(
            new CartAddEvent({}, id.toString(), {
              source: 'product-form-component',
              itemCount: Number(formData.get('quantity')) || Number(this.dataset.quantityDefault),
              productId: submittedProductId,
              sections: response.sections,
            })
          );
        }
      })
      .catch((error) => {
        console.error(error);
        if (mainPurchase) {
          const message = 'We could not confirm the addition. Please check your cart and try again.';
          this.#setLiveRegionText(message);
          if (addToCartTextError) {
            addToCartTextError.classList.remove('hidden');
            const textNode = addToCartTextError.childNodes[2];
            if (textNode) textNode.textContent = message;
            else addToCartTextError.appendChild(document.createTextNode(message));
          }
          // Never retry an add automatically: the server may already have received it.
          void this.#fetchAndUpdateCartQuantity();
        }
      })
      .finally(() => {
        if (mainPurchase) {
          this.removeAttribute('data-zootify-submitting');
          this.#updateAddToCartButtonState(this.#cartQuantity);
        }
        cartPerformance.measureFromEvent('add:user-action', event);
      });
  }

  /**
   * Updates the quantity label with the current cart quantity
   * @param {number} cartQty - The quantity in cart
   */
  #updateQuantityLabel(cartQty) {
    const quantityLabel = this.refs.quantityLabelCartCount;
    if (quantityLabel) {
      const inCartText = quantityLabel.textContent?.match(/\((\d+)\s+(.+)\)/);
      if (inCartText && inCartText[2]) {
        quantityLabel.textContent = `(${cartQty} ${inCartText[2]})`;
      }

      // Show/hide based on quantity
      quantityLabel.classList.toggle('hidden', cartQty === 0);
    }
  }

  /**
   * @param {*} text
   */
  #setLiveRegionText(text) {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = text;
  }

  #clearLiveRegionText() {
    const liveRegion = this.refs.liveRegion;
    liveRegion.textContent = '';
  }

  /**
   * Morphs or removes/adds an element based on current and new element states
   * @param {Element | null | undefined} currentElement - The current element in the DOM
   * @param {Element | null | undefined} newElement - The new element from the server response
   * @param {Element | null} [insertReferenceElement] - Element to insert before if adding new element
   */
  #morphOrUpdateElement(currentElement, newElement, insertReferenceElement = null) {
    if (currentElement && newElement) {
      morph(currentElement, newElement);
    } else if (currentElement && !newElement) {
      currentElement.remove();
    } else if (!currentElement && newElement && insertReferenceElement) {
      insertReferenceElement.insertAdjacentElement('beforebegin', /** @type {Element} */ (newElement.cloneNode(true)));
    }
  }

  /**
   * @param {VariantUpdateEvent} event
   */
  #onVariantUpdate = async (event) => {
    if (event.detail.data.newProduct) {
      this.dataset.productId = event.detail.data.newProduct.id;
    } else if (event.detail.data.productId !== this.dataset.productId) {
      return;
    }

    const { variantId } = this.refs;

    // Invalidate old cart reads and success animations before replacing the variant markup.
    ++this.#cartRequestId;
    this.#cartQuantity = 0;
    this.refs.addToCartButtonContainer?.cancelAddToCartAnimation();

    // Update the variant ID
    variantId.value = event.detail.resource?.id ?? '';
    const { addToCartButtonContainer: currentAddToCartButtonContainer, acceleratedCheckoutButtonContainer } = this.refs;
    const currentAddToCartButton = currentAddToCartButtonContainer?.refs.addToCartButton;

    // Update state and text for add-to-cart button
    if (!currentAddToCartButtonContainer || (!currentAddToCartButton && !acceleratedCheckoutButtonContainer)) return;

    // Update the button state
    if (event.detail.resource == null || event.detail.resource.available == false) {
      currentAddToCartButtonContainer.disable();
    } else {
      currentAddToCartButtonContainer.enable();
    }

    const newAddToCartButton = event.detail.data.html.querySelector('product-form-component [ref="addToCartButton"]');
    if (newAddToCartButton && currentAddToCartButton) {
      morph(currentAddToCartButton, newAddToCartButton);
    }

    if (acceleratedCheckoutButtonContainer) {
      if (event.detail.resource == null || event.detail.resource.available == false) {
        acceleratedCheckoutButtonContainer?.setAttribute('hidden', 'true');
      } else {
        acceleratedCheckoutButtonContainer?.removeAttribute('hidden');
      }
    }

    // Set the data attribute for the product variant media if it exists
    if (event.detail.resource) {
      const productVariantMedia = event.detail.resource.featured_media?.preview_image?.src;
      if (productVariantMedia) {
        this.refs.addToCartButtonContainer?.setAttribute(
          'data-product-variant-media',
          productVariantMedia + '&width=100'
        );
      }
    }

    // Check if quantity rules, price-per-item, or add-to-cart are appearing/disappearing (causes layout shift)
    const {
      quantityRules,
      pricePerItem,
      quantitySelector,
      productFormButtons,
      quantityLabel,
      quantitySelectorWrapper,
    } = this.refs;

    // Update quantity selector's min/max/step attributes and cart quantity for the new variant
    const newQuantityInput = /** @type {HTMLInputElement | null} */ (
      event.detail.data.html.querySelector('quantity-selector-component input[ref="quantityInput"]')
    );

    if (quantitySelector?.updateConstraints && newQuantityInput) {
      quantitySelector.updateConstraints(newQuantityInput.min, newQuantityInput.max || null, newQuantityInput.step);
    }

    const newQuantityRules = event.detail.data.html.querySelector('.quantity-rules');
    const isQuantityRulesChanging = !!quantityRules !== !!newQuantityRules;

    const newPricePerItem = event.detail.data.html.querySelector('price-per-item');
    const isPricePerItemChanging = !!pricePerItem !== !!newPricePerItem;

    if ((isQuantityRulesChanging || isPricePerItemChanging) && quantitySelector) {
      // Store quantity value before morphing entire container
      const currentQuantityValue = quantitySelector.getValue?.();

      const newProductFormButtons = event.detail.data.html.querySelector('.product-form-buttons');

      if (productFormButtons && newProductFormButtons) {
        morph(productFormButtons, newProductFormButtons);

        // Get the NEW quantity selector after morphing and update its constraints
        const newQuantityInputElement = /** @type {HTMLInputElement | null} */ (
          event.detail.data.html.querySelector('quantity-selector-component input[ref="quantityInput"]')
        );

        if (this.refs.quantitySelector?.updateConstraints && newQuantityInputElement && currentQuantityValue) {
          // Temporarily set the old value so updateConstraints can snap it properly
          this.refs.quantitySelector.setValue(currentQuantityValue);
          // updateConstraints will snap to valid increment if needed
          this.refs.quantitySelector.updateConstraints(
            newQuantityInputElement.min,
            newQuantityInputElement.max || null,
            newQuantityInputElement.step
          );
        }
      }
    } else {
      // Update elements individually when layout isn't changing
      /** @type {Array<[string, HTMLElement | undefined, HTMLElement | undefined]>} */
      const morphTargets = [
        ['.quantity-label', quantityLabel, quantitySelector],
        ['.quantity-rules', quantityRules, this.refs.productFormButtons],
        ['price-per-item', pricePerItem, quantitySelectorWrapper],
      ];

      for (const [selector, currentElement, fallback] of morphTargets) {
        this.#morphOrUpdateElement(currentElement, event.detail.data.html.querySelector(selector), fallback);
      }
    }

    // Morph volume pricing if it exists
    const currentVolumePricing = this.refs.volumePricing;
    const newVolumePricing = event.detail.data.html.querySelector('volume-pricing');
    this.#morphOrUpdateElement(currentVolumePricing, newVolumePricing, this.refs.productFormButtons);

    // Let Horizon refresh child refs if morph replaced the complete button area.
    const updatedVariantId = variantId.value;
    await Promise.resolve();
    if (!this.isConnected || this.refs.variantId.value !== updatedVariantId) return;
    this.#variantUpdating = false;
    this.#rememberDefaultButtonState();
    this.#updateAddToCartButtonState(0);

    // Always check the newly selected variant against the cart so the button can switch
    // between ADD TO CART and GO TO CART correctly.
    await this.#fetchAndUpdateCartQuantity();
  };

  /**
   * Disable the add to cart button while the UI is updating before #onVariantUpdate is called.
   * Accelerated checkout button is also disabled via its own event listener not exposed to the theme.
   */
  #onVariantSelected = () => {
    this.#variantUpdating = true;
    ++this.#cartRequestId;
    this.#cartQuantity = 0;
    this.refs.addToCartButtonContainer?.cancelAddToCartAnimation();
    this.refs.addToCartButtonContainer?.refs.addToCartButton?.removeAttribute('data-go-to-cart');
    this.refs.addToCartButtonContainer?.disable();
  };
}

if (!customElements.get('product-form-component')) {
  customElements.define('product-form-component', ProductFormComponent);
}
