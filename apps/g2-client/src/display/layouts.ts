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
    | "textColor"
    | "paddingLength"
  >
> &
  PositionedContainer & {
    readonly isEventCapture: 0 | 1;
    readonly content: string;
    readonly textColor: number;
    readonly paddingLength: number;
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
  {
    containerID: 1,
    containerName: "status",
    xPosition: 0,
    yPosition: 0,
    width: 448,
    height: 28,
    isEventCapture: 1,
    textColor: 1,
    paddingLength: 2,
    zOrderIndex: 1,
  },
  {
    containerID: 2,
    containerName: "target",
    xPosition: 496,
    yPosition: 0,
    width: 80,
    height: 28,
    isEventCapture: 0,
    textColor: 1,
    paddingLength: 2,
    zOrderIndex: 2,
  },
  {
    containerID: 3,
    containerName: "source",
    xPosition: 0,
    yPosition: 36,
    width: 576,
    height: 40,
    isEventCapture: 0,
    textColor: 2,
    paddingLength: 4,
    zOrderIndex: 3,
  },
  {
    containerID: 4,
    containerName: "english",
    xPosition: 0,
    yPosition: 84,
    width: 576,
    height: 40,
    isEventCapture: 0,
    textColor: 2,
    paddingLength: 4,
    zOrderIndex: 4,
  },
  {
    containerID: 5,
    containerName: "translated",
    xPosition: 0,
    yPosition: 132,
    width: 576,
    height: 100,
    isEventCapture: 0,
    textColor: 4,
    paddingLength: 6,
    zOrderIndex: 5,
  },
  {
    containerID: 6,
    containerName: "hint",
    xPosition: 0,
    yPosition: 248,
    width: 576,
    height: 40,
    isEventCapture: 0,
    textColor: 1,
    paddingLength: 4,
    zOrderIndex: 6,
  },
] as const satisfies readonly (PositionedContainer & {
  readonly isEventCapture: 0 | 1;
  readonly textColor: number;
  readonly paddingLength: number;
})[];

const CONTENT: Readonly<Record<DisplayState, readonly [string, string, string, string, string, string]>> =
  Object.freeze({
    Starting: [
      "Starting",
      "ES/TR",
      "",
      "",
      "",
      "Please wait",
    ],
    TargetSelection: [
      "Choose target",
      "ES/TR",
      "",
      "",
      "[ES] / TR",
      "Swipe to change, press to confirm",
    ],
    Ready: [
      "Ready",
      "ES/TR",
      "",
      "",
      "",
      "Press to begin",
    ],
    Listening: [
      "Listening",
      "ES/TR",
      "",
      "",
      "",
      "Press when finished",
    ],
    Finalizing: [
      "Finalizing",
      "ES/TR",
      "",
      "",
      "",
      "Please wait",
    ],
    Translating: [
      "Translating",
      "ES/TR",
      "",
      "",
      "Translating...",
      "Please wait",
    ],
    Results: [
      "Results",
      "ES/TR",
      "sample phrase",
      "sample translation",
      "Hola",
      "Swipe to change, press to begin",
    ],
    Error: [
      "Error",
      "ES/TR",
      "",
      "",
      "",
      "Restart app",
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
