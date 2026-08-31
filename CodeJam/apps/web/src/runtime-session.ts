export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 96;

export interface TranscriptScrollElement {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void;
}

export function isTranscriptNearBottom(
  element: Pick<TranscriptScrollElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = TRANSCRIPT_BOTTOM_THRESHOLD_PX,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function scrollTranscriptToLatest(
  element: TranscriptScrollElement,
  prefersReducedMotion: boolean,
): void {
  element.scrollTo({
    top: element.scrollHeight,
    behavior: prefersReducedMotion ? "auto" : "smooth",
  });
}
