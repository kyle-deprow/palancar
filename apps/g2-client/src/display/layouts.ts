import type {
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

export const DISPLAY_WIDTH = 576;
export const DISPLAY_HEIGHT = 288;
export const MAX_TOTAL_CONTAINERS = 12;
export const MAX_NON_IMAGE_CONTAINERS = 8;
export const MAX_STARTUP_TEXT_LENGTH = 1_000;
export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_LENGTH = 64;

export const DISPLAY_STATES = [
  "Starting",
  "TargetSelection",
  "Ready",
  "Listening",
  "Finalizing",
  "Translating",
  "Results",
  "Recovering",
  "Error",
] as const;

export type DisplayState = (typeof DISPLAY_STATES)[number];

type PositionedContainer = {
  readonly xPosition: number;
  readonly yPosition: number;
  readonly width: number;
  readonly height: number;
  readonly containerID: number;
  readonly containerName: string;
  readonly zOrderIndex?: number;
};

export type ImmutableTextContainer = Readonly<
  Pick<
    TextContainerProperty,
    | "xPosition"
    | "yPosition"
    | "width"
    | "height"
    | "containerID"
    | "containerName"
    | "isEventCapture"
    | "zOrderIndex"
    | "content"
  >
> &
  PositionedContainer & {
    readonly isEventCapture: 0 | 1;
    readonly content: string;
  };

export type ImmutableListItemContainer = Readonly<
  Pick<ListItemContainerProperty, "itemCount">
> & {
  readonly itemCount: number;
  readonly itemName: readonly string[];
};

export type ImmutableListContainer = Readonly<
  Pick<
    ListContainerProperty,
    | "xPosition"
    | "yPosition"
    | "width"
    | "height"
    | "containerID"
    | "containerName"
    | "isEventCapture"
    | "zOrderIndex"
  >
> &
  PositionedContainer & {
    readonly isEventCapture: 0 | 1;
    readonly itemContainer: ImmutableListItemContainer;
  };

export type ImmutableImageContainer = Readonly<
  Pick<
    ImageContainerProperty,
    | "xPosition"
    | "yPosition"
    | "width"
    | "height"
    | "containerID"
    | "containerName"
    | "zOrderIndex"
  >
> &
  PositionedContainer;

export interface ImmutablePageLayout {
  readonly state: DisplayState;
  readonly containerTotalNum: number;
  readonly textObject: readonly ImmutableTextContainer[];
  readonly listObject: readonly ImmutableListContainer[];
  readonly imageObject: readonly ImmutableImageContainer[];
}

const REGION_GEOMETRY = [
  { containerID: 1, containerName: "status", xPosition: 0, yPosition: 0, width: 576, height: 36, isEventCapture: 1, zOrderIndex: 1 },
  { containerID: 2, containerName: "target", xPosition: 0, yPosition: 40, width: 576, height: 36, isEventCapture: 0, zOrderIndex: 2 },
  { containerID: 3, containerName: "source", xPosition: 0, yPosition: 80, width: 576, height: 64, isEventCapture: 0, zOrderIndex: 3 },
  { containerID: 4, containerName: "english", xPosition: 0, yPosition: 148, width: 576, height: 64, isEventCapture: 0, zOrderIndex: 4 },
  { containerID: 5, containerName: "suggestion", xPosition: 0, yPosition: 216, width: 576, height: 72, isEventCapture: 0, zOrderIndex: 5 },
] as const satisfies readonly (PositionedContainer & { readonly isEventCapture: 0 | 1 })[];

const CONTENT: Readonly<Record<DisplayState, readonly [string, string, string, string, string]>> =
  Object.freeze({
    Starting: [
      "Starting",
      "Target: Spanish / Turkish",
      "Source: waiting",
      "English: waiting",
      "Suggestion: Hola / Hello | Merhaba / Hello",
    ],
    TargetSelection: [
      "Choose target",
      "Spanish / Espanol | Turkish / Turkce",
      "Source: not started",
      "English: not started",
      "Status: swipe to choose, press to confirm",
    ],
    Ready: [
      "Ready",
      "Target: Spanish / Turkish",
      "Source: press to begin",
      "English: waiting",
      "Suggestion: Hola / Hello | Merhaba / Hello",
    ],
    Listening: [
      "Listening",
      "Target: Spanish / Turkish",
      "Source: listening...",
      "English: waiting",
      "Status: press when finished",
    ],
    Finalizing: [
      "Finalizing",
      "Target: Spanish / Turkish",
      "Source: finalizing...",
      "English: waiting",
      "Status: please wait",
    ],
    Translating: [
      "Translating",
      "Target: Spanish / Turkish",
      "Source: captured",
      "English: translating...",
      "Status: please wait",
    ],
    Results: [
      "Results",
      "Target: Spanish / Turkish",
      "Source: sample phrase",
      "English: sample translation",
      "Suggestion: Hola / Hello | Merhaba / Hello",
    ],
    Recovering: [
      "Recovering",
      "Target: Spanish / Turkish",
      "Source: unavailable",
      "English: unavailable",
      "Status: reconnecting",
    ],
    Error: [
      "Error",
      "Target: Spanish / Turkish",
      "Source: unavailable",
      "English: unavailable",
      "Status: try again",
    ],
  });

const makeLayout = (state: DisplayState): ImmutablePageLayout => {
  const textObject = REGION_GEOMETRY.map((region, index) =>
    Object.freeze({ ...region, content: CONTENT[state][index] ?? "" }),
  );
  return Object.freeze({
    state,
    containerTotalNum: textObject.length,
    textObject: Object.freeze(textObject),
    listObject: Object.freeze([]),
    imageObject: Object.freeze([]),
  });
};

export const PAGE_LAYOUTS: Readonly<Record<DisplayState, ImmutablePageLayout>> =
  Object.freeze(
    Object.fromEntries(DISPLAY_STATES.map((state) => [state, makeLayout(state)])) as Record<
      DisplayState,
      ImmutablePageLayout
    >,
  );
