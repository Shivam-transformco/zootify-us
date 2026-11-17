# Zootify US — Existing Theme Design Contract

This records the existing Black Friday theme direction. Product media extends this system; it does not replace global styles.

## Brand overview

Zootify sells phone cases and personal carry accessories. Product photography, visible materials, clear choices, and practical demonstrations lead the experience. The store should feel confident, modern, and easy to shop.

## Design thesis

Let the product carry the color, with precise typography and generous white space around it.

## Colors

| Role | Existing value | Source |
| --- | --- | --- |
| Main surface | #ffffff | scheme-1 background |
| Main text | #000000 | scheme-1 foreground |
| Deep ink | #01161e | existing custom sections / scheme-8 primary button |
| Brand accent | #6ac857 | scheme-1 primary button and hover |
| Secondary text | #68716e | zp_muted_color |
| Borders | #e6e6e6 | scheme-1 border |
| Soft surface | #f7f7f7 | scheme-2 background |

Accents belong on purposeful controls. Editorial media uses white and deep ink; photographs provide the color. Keep body text readable at 4.5:1 contrast.

## Typography

All four existing theme font pickers use Montserrat. Inherit the theme heading/body CSS variables and native Shopify font loading. Use the theme's sans-serif fallback; add no external font service. Existing PDP feature headings use 32px desktop / 22px mobile and body 16px / 14px. New editorial media headings use 34–36px desktop / 26px mobile, weight 600, line height about 1.18, modest negative tracking; body uses 16px / 14px with 1.6 line height. Keep copy concise and editable.

## Spacing and composition

Preserve the existing product purchase area, header, footer, and navigation. New media sections use up to 1440px content width, 40px desktop / 16px mobile gutters, and 64px desktop column gaps. Controls have at least 44px touch targets. Rounded editorial media uses 16–24px desktop corners and 14–16px mobile corners. Keep product media fully legible; use native image ratios for existing landscape assets.

## Components

- Header: existing white navigation with black wordmark and icon controls.
- Purchase area: existing device/color selections, price, promotion, and add-to-cart controls; preserve behavior.
- Primary/secondary buttons and inputs: inherit the current theme settings and hover/focus treatment.
- Product and collection cards: retain existing image-first cards, titles, prices, and badge styling.
- Product Film: shared family content; one full-width banner frame with optional overlay or above-media text. Separate desktop/mobile visibility and responsive videos. Desktop remains off until suitable landscape media is selected; there is no split portrait/text desktop composition.
- Product Banner: preserve the existing desktop/mobile product metafields and slider independently.
- Design Story: additional shared product/color image pair; staggered desktop images and stacked mobile images, native ratio by default. Hide repeated Product Banner imagery by default until separate story photos are selected.
- Footer: preserve existing structure and settings.

## Dos and Don'ts

- Keep all media and editorial copy editable through shared content records.
- Keep layout, sizing, spacing, color, and playback controls in the section settings.
- Preserve color/model-specific photos where their existing assets differ.
- Hide unconfigured storefront sections without empty gaps or setup instructions.
- Do not hardcode product-family detection or asset filenames into section code.
- Do not invent product capabilities or use an unrelated color/model as a substitute.
- Do not repeat the same lifestyle photos in the old banner and new story layout.
- Do not alter global typography, cart, discounts, or purchase controls for this media feature.

## Motion philosophy

Product videos play muted and inline only while visible, pause offscreen, and retain a user's explicit pause. Honor reduced motion and save-data preferences. A visible play/pause control and one-tap manual playback remain available. Avoid decorative autoplay or motion that distracts from the product.


