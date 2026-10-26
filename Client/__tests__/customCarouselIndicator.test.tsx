import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";
import CustomCarousel from "../app/components/CustomCarousel/CustomCarousel";
import { CustomCarouselProps } from "../app/components/CustomCarousel/Interfaces";

// EXP-019: the indicator radius prop was typed with a typo (`inidicatorBorderRadius`), which broke `tsc`.
// Renamed to `indicatorBorderRadius`; this guards that the rename keeps the rendered radius (default 5,
// the value SettingsInstructionsScreen relies on) and that the prop still reaches every indicator.

const DATA = [{ id: "a" }, { id: "b" }];

const renderCarousel = (props: Partial<CustomCarouselProps> = {}) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <CustomCarousel data={DATA} renderItem={({ item }) => <Text>{item.id}</Text>} {...props} />
    );
  });
  return r;
};

const indicatorBorderRadius = (r: TestRenderer.ReactTestRenderer, index: number): unknown => {
  const indicator = r.root.find(
    (n) => n.props.testID === `pagination-indicator-${index}` && typeof n.props.onPress === "function"
  );
  const dot = indicator.find((n: ReactTestInstance) => n.props.style?.borderRadius !== undefined);
  return StyleSheet.flatten(dot.props.style).borderRadius;
};

describe("CustomCarousel pagination indicator radius (EXP-019)", () => {
  it("defaults to a radius of 5", () => {
    const r = renderCarousel();
    expect(indicatorBorderRadius(r, 0)).toBe(5);
    expect(indicatorBorderRadius(r, 1)).toBe(5);
  });

  it("applies indicatorBorderRadius to every indicator", () => {
    const r = renderCarousel({ indicatorBorderRadius: 12 });
    expect(indicatorBorderRadius(r, 0)).toBe(12);
    expect(indicatorBorderRadius(r, 1)).toBe(12);
  });
});
