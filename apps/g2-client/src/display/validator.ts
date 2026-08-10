import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  MAX_LIST_ITEMS,
  MAX_LIST_ITEM_LENGTH,
  MAX_NON_IMAGE_CONTAINERS,
  MAX_STARTUP_TEXT_LENGTH,
  MAX_TOTAL_CONTAINERS,
  type ImmutablePageLayout,
} from "./layouts.js";

export interface LayoutValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

type Container =
  | ImmutablePageLayout["textObject"][number]
  | ImmutablePageLayout["listObject"][number]
  | ImmutablePageLayout["imageObject"][number];

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

export function validatePageLayout(layout: ImmutablePageLayout): LayoutValidationResult {
  const errors: string[] = [];
  const nonImageCount = layout.textObject.length + layout.listObject.length;
  const all: readonly Container[] = [
    ...layout.textObject,
    ...layout.listObject,
    ...layout.imageObject,
  ];

  if (layout.containerTotalNum !== all.length) errors.push("containerTotalNum must match the actual container count");
  if (nonImageCount > MAX_NON_IMAGE_CONTAINERS) errors.push("non-image container count exceeds 8");
  if (layout.imageObject.length > 4) errors.push("image container count exceeds 4");
  if (all.length > MAX_TOTAL_CONTAINERS) errors.push("total container count exceeds 12");

  const ids = new Set<number>();
  const names = new Set<string>();
  let captureCount = 0;
  for (const container of all) {
    if (!isPositiveInteger(container.containerID)) errors.push("container IDs must be positive integers");
    if (ids.has(container.containerID)) errors.push("container IDs must be unique");
    ids.add(container.containerID);
    if (container.containerName.length === 0 || container.containerName.length > 16) errors.push("container names must contain 1 to 16 characters");
    if (names.has(container.containerName)) errors.push("container names must be unique");
    names.add(container.containerName);
    if (container.width <= 0 || container.height <= 0) errors.push("container dimensions must be positive");
    if (container.xPosition < 0 || container.yPosition < 0 || container.xPosition + container.width > DISPLAY_WIDTH || container.yPosition + container.height > DISPLAY_HEIGHT) errors.push("containers must remain within 576x288 bounds");
  }

  for (const text of layout.textObject) {
    captureCount += text.isEventCapture;
    if (text.content.length > MAX_STARTUP_TEXT_LENGTH) errors.push("text content exceeds 1000 characters");
  }
  for (const list of layout.listObject) {
    captureCount += list.isEventCapture;
    if (list.itemContainer.itemCount !== list.itemContainer.itemName.length) errors.push("list itemCount must match itemName length");
    if (list.itemContainer.itemName.length > MAX_LIST_ITEMS) errors.push("list contains more than 20 items");
    if (list.itemContainer.itemName.some((item) => item.length > MAX_LIST_ITEM_LENGTH)) errors.push("list item exceeds 64 characters");
  }
  for (const image of layout.imageObject) {
    if (image.width < 20 || image.width > 288) errors.push("image width must be from 20 to 288 pixels");
    if (image.height < 20 || image.height > 144) errors.push("image height must be from 20 to 144 pixels");
  }
  if (captureCount !== 1) errors.push("exactly one text or list container must capture events");

  const zOrders = all.map((container) => container.zOrderIndex);
  const specifiedZOrders = zOrders.filter((value): value is number => value !== undefined);
  if (specifiedZOrders.length !== 0 && specifiedZOrders.length !== all.length) errors.push("z-order must be specified for all containers or none");
  if (specifiedZOrders.some((value) => !Number.isInteger(value))) errors.push("z-order values must be integers");
  if (new Set(specifiedZOrders).size !== specifiedZOrders.length) errors.push("z-order values must be unique");

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
