export interface ValidationGuidanceOptions {
  viewportHeight: number;
  reducedMotion: boolean;
}

export interface ValidationGuidanceResult {
  openedDetails: boolean;
  scrolled: boolean;
}

export function guideToInvalidField(
  field: HTMLElement,
  options: ValidationGuidanceOptions,
): ValidationGuidanceResult {
  const details = field.closest<HTMLDetailsElement>("details");
  const openedDetails = details !== null && !details.open;
  if (details !== null) details.open = true;
  field.focus({ preventScroll: true });
  const rect = field.getBoundingClientRect();
  const scrolled = rect.top < 0 || rect.bottom > options.viewportHeight;
  if (scrolled) {
    field.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: options.reducedMotion ? "auto" : "smooth",
    });
  }
  return { openedDetails, scrolled };
}
