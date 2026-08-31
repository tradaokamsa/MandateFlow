import { describe, expect, it } from "vitest";
import {
  isTranscriptNearBottom,
  scrollTranscriptToLatest,
  TRANSCRIPT_BOTTOM_THRESHOLD_PX,
} from "./runtime-session";

describe("transcript scroll ownership", () => {
  it("treats the last 96px as pinned to the transcript bottom", () => {
    expect(TRANSCRIPT_BOTTOM_THRESHOLD_PX).toBe(96);
    expect(isTranscriptNearBottom({ scrollHeight: 1_000, scrollTop: 804, clientHeight: 100 })).toBe(true);
    expect(isTranscriptNearBottom({ scrollHeight: 1_000, scrollTop: 803, clientHeight: 100 })).toBe(false);
  });

  it("scrolls only the transcript container and honors reduced motion", () => {
    const calls: Array<{ top: number; behavior: ScrollBehavior }> = [];
    const transcript = {
      scrollHeight: 1_200,
      scrollTop: 200,
      clientHeight: 400,
      scrollTo: (options: { top: number; behavior: ScrollBehavior }) => calls.push(options),
    };

    scrollTranscriptToLatest(transcript, true);
    expect(calls).toEqual([{ top: 1_200, behavior: "auto" }]);

    scrollTranscriptToLatest(transcript, false);
    expect(calls.at(-1)).toEqual({ top: 1_200, behavior: "smooth" });
  });
});
