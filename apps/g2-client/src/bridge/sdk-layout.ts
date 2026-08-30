import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

import type {
  ImmutableImageContainer,
  ImmutableListContainer,
  ImmutablePageLayout,
  ImmutableTextContainer,
} from "../display/index.js";

const zOrder = (container: { readonly zOrderIndex?: number }): { readonly zOrderIndex?: number } =>
  container.zOrderIndex === undefined ? {} : { zOrderIndex: container.zOrderIndex };

const toTextContainer = (container: ImmutableTextContainer): TextContainerProperty =>
  new TextContainerProperty({
    containerID: container.containerID,
    containerName: container.containerName,
    xPosition: container.xPosition,
    yPosition: container.yPosition,
    width: container.width,
    height: container.height,
    isEventCapture: container.isEventCapture,
    content: container.content,
    textColor: container.textColor,
    paddingLength: container.paddingLength,
    ...zOrder(container),
  });

const toListContainer = (container: ImmutableListContainer): ListContainerProperty =>
  new ListContainerProperty({
    containerID: container.containerID,
    containerName: container.containerName,
    xPosition: container.xPosition,
    yPosition: container.yPosition,
    width: container.width,
    height: container.height,
    isEventCapture: container.isEventCapture,
    itemContainer: new ListItemContainerProperty({
      itemCount: container.itemContainer.itemCount,
      itemName: [...container.itemContainer.itemName],
    }),
    ...zOrder(container),
  });

const toImageContainer = (container: ImmutableImageContainer): ImageContainerProperty =>
  new ImageContainerProperty({
    containerID: container.containerID,
    containerName: container.containerName,
    xPosition: container.xPosition,
    yPosition: container.yPosition,
    width: container.width,
    height: container.height,
    ...zOrder(container),
  });

export function toStartUpPageContainer(
  layout: ImmutablePageLayout,
): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: layout.containerTotalNum,
    textObject: layout.textObject.map(toTextContainer),
    listObject: layout.listObject.map(toListContainer),
    imageObject: layout.imageObject.map(toImageContainer),
  });
}
