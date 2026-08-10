---
name: g2-display-ui
description: Design and implement Even G2 glasses screens with the current container API. Use for canvas layout, text/list/image containers, page rebuilds, in-place text updates, z-ordering, readable HUD interactions, or debugging display validation and clipping.
---

# G2 display UI

Design for a glanceable firmware-rendered HUD, not a miniature web page.

## Enforce the SDK 0.0.12 display contract

- Use the 576×288 canvas with origin at the top-left.
- Design in 4-bit monochrome green: 16 intensity levels; black pixels are off.
- Position every container with absolute coordinates. Glasses containers do not support CSS, DOM layout, flexbox, or arbitrary drawing.
- Allow at most 12 containers total: at most 4 image containers and 8 non-image containers per the current official platform contract.
- Give every container a unique `containerID` and a unique `containerName` of at most 16 characters.
- Set exactly one text or list container to `isEventCapture: 1`; set all other capture flags to `0`.
- Keep every rectangle within the canvas and set `containerTotalNum` to the actual number of containers.

## Handle stacking consistently

SDK `0.0.12` supports `zOrderIndex` on text, list, and image containers.

- If any container sets `zOrderIndex`, set it on every container on that page.
- Use unique values; larger values render in front.
- Omit it from all containers when declaration-order stacking is sufficient.
- Remember that z-order does not change event capture.

## Choose the right container

### Text

- Use `TextContainerProperty` for plain, left/top-aligned text.
- Keep startup and rebuild content at or below 1,000 characters.
- Keep `TextContainerUpgrade.content` at or below 2,000 characters.
- Expect roughly 400–500 characters in a full-screen container, depending on glyphs.
- Use `textContainerUpgrade` for frequent changes and exact matching IDs/names.
- Do not assume font family, font size, weight, alignment, background fill, or animation controls exist.

### List

- Use `ListContainerProperty` for firmware-managed selection and scrolling.
- Limit a list to 20 items and item labels to 64 characters.
- Rebuild the page to change list contents; there is no list upgrade API.
- Do not assume per-row styling, separators, or row-height controls.

### Image

- Keep each `ImageContainerProperty` within 20–288 px wide and 20–144 px high.
- Create an empty image container, then call `updateImageRawData` after page creation.
- Queue image updates; never send them concurrently.
- Supply supported data (`number[]`, `Uint8Array`, `ArrayBuffer`, or base64) and design for 4-bit greyscale.
- For image-first screens, place a blank text capture container behind the image.

## Prefer stable updates

- Call `createStartUpPageContainer` once.
- Use `textContainerUpgrade` for counters, status, and streamed text; it avoids hardware flicker.
- Use `rebuildPageContainer` only for layout/type changes; it resets firmware scroll and selection state.
- Check every SDK return value and expose actionable errors during development.
- Serialize display operations so BLE-bound updates do not race.

## Design for wearability

- Keep the primary action obvious and available through one press.
- Use short copy, strong hierarchy, whitespace, and stable regions.
- Avoid rapid full-page redraws and decorative image churn.
- Do not rely on unsupported Unicode glyphs; validate required symbols in the simulator and on hardware.
- Provide the system root-exit confirmation on double press through `shutDownPageContainer(1)`.

## Verify visually

1. Unit-test container counts, bounds, unique IDs/names, one capture target, text limits, and z-order rules.
2. Use simulator screenshots for layout regressions.
3. Keep screenshots in RGBA when testing lit pixels; inspect alpha rather than RGB alone.
4. Validate font fit, greyscale, scrolling, image transfer, and flicker on physical glasses.

Official references: [display system](https://hub.evenrealities.com/docs/build/display), [page lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle), and [design guidelines](https://hub.evenrealities.com/docs/build/design-guidelines).
