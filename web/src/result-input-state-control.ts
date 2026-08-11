export type ResultInputEntryState = "waiting" | "empty" | "editing" | "invalid" | "saved";

export interface ResultInputDraftAction {
  label: string;
  accessibleName: string;
  onActivate: () => Promise<void>;
}

export interface ResultInputStateControl {
  readonly element: HTMLElement;
  setState: (
    state: ResultInputEntryState,
    invalidStateLabel?: "入力中" | "要確認",
  ) => void;
  setDraftAction: (action: ResultInputDraftAction | undefined) => void;
  setBusy: (busy: boolean) => void;
}

let popoverSequence = 0;

function visibleState(
  state: ResultInputEntryState,
  invalidStateLabel: "入力中" | "要確認",
): string {
  if (state === "invalid") return invalidStateLabel;
  return {
    waiting: "待機中",
    empty: "未入力",
    editing: "入力中",
    saved: "保存済",
  }[state];
}

function staticAccessibleName(state: ResultInputEntryState): string | undefined {
  if (state === "saved") return "保存済み";
  if (state === "waiting") return "前提試合待ち";
  return undefined;
}

function positionPopover(trigger: HTMLElement, popover: HTMLElement): void {
  const triggerBox = trigger.getBoundingClientRect();
  const popoverBox = popover.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, triggerBox.right - popoverBox.width),
    Math.max(margin, window.innerWidth - popoverBox.width - margin),
  );
  const below = triggerBox.bottom + gap;
  const above = triggerBox.top - popoverBox.height - gap;
  const top = below + popoverBox.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, above);
  popover.style.left = `${String(left)}px`;
  popover.style.top = `${String(top)}px`;
}

class StateControl implements ResultInputStateControl {
  readonly element = document.createElement("span");
  private state: ResultInputEntryState;
  private invalidStateLabel: "入力中" | "要確認";
  private action?: ResultInputDraftAction;
  private busy = false;

  constructor(
    state: ResultInputEntryState,
    invalidStateLabel: "入力中" | "要確認",
  ) {
    this.state = state;
    this.invalidStateLabel = invalidStateLabel;
    this.element.className = "result-input-state-control";
    this.render();
  }

  setState(
    state: ResultInputEntryState,
    invalidStateLabel = this.invalidStateLabel,
  ): void {
    if (state === this.state && invalidStateLabel === this.invalidStateLabel) return;
    this.state = state;
    this.invalidStateLabel = invalidStateLabel;
    this.render();
  }

  setDraftAction(action: ResultInputDraftAction | undefined): void {
    const samePresentation = action === undefined
      ? this.action === undefined
      : this.action?.label === action.label &&
        this.action.accessibleName === action.accessibleName;
    this.action = action;
    if (samePresentation) return;
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (busy) this.element.setAttribute("aria-busy", "true");
    else this.element.removeAttribute("aria-busy");
    for (const button of this.element.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = busy;
    }
  }

  private render(): void {
    this.element.replaceChildren();
    const stateText = visibleState(this.state, this.invalidStateLabel);
    if (this.action === undefined) {
      const label = document.createElement("span");
      label.className = "tournament-result-state-label";
      label.dataset.state = this.state;
      label.textContent = stateText;
      const accessibleName = staticAccessibleName(this.state);
      if (accessibleName !== undefined) label.setAttribute("aria-label", accessibleName);
      this.element.append(label);
      return;
    }

    const action = this.action;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "tournament-result-state-label result-input-state-trigger";
    trigger.dataset.state = this.state;
    trigger.setAttribute("aria-label", `${action.accessibleName}の入力操作を開く`);
    trigger.setAttribute("aria-expanded", "false");
    trigger.disabled = this.busy;
    trigger.append(document.createTextNode(stateText));
    const marker = document.createElement("span");
    marker.className = "result-input-state-trigger-marker";
    marker.textContent = "▼";
    marker.setAttribute("aria-hidden", "true");
    trigger.append(marker);

    const popover = document.createElement("div");
    popover.id = `result-input-draft-popover-${String(++popoverSequence)}`;
    popover.className = "result-input-draft-popover";
    popover.setAttribute("popover", "auto");
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", action.accessibleName);
    trigger.setAttribute("popovertarget", popover.id);
    trigger.setAttribute("aria-controls", popover.id);

    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "text-button result-input-draft-action";
    actionButton.textContent = action.label;
    actionButton.setAttribute("aria-label", action.accessibleName);
    actionButton.disabled = this.busy;
    popover.append(actionButton);

    const positionOnViewportChange = (): void => {
      try {
        if (popover.matches(":popover-open")) positionPopover(trigger, popover);
      } catch {
        // `:popover-open` is unavailable only in unsupported test/browser environments.
      }
    };
    popover.addEventListener("toggle", (event) => {
      const open = (event as Event & { newState?: string }).newState === "open";
      trigger.setAttribute("aria-expanded", String(open));
      if (open) {
        positionPopover(trigger, popover);
        actionButton.focus({ preventScroll: true });
        window.addEventListener("resize", positionOnViewportChange);
        window.addEventListener("scroll", positionOnViewportChange, { capture: true, passive: true });
      } else {
        window.removeEventListener("resize", positionOnViewportChange);
        window.removeEventListener("scroll", positionOnViewportChange, { capture: true });
        if (trigger.isConnected) {
          trigger.focus({ preventScroll: true });
        }
      }
    });
    actionButton.addEventListener("click", () => {
      void this.action?.onActivate().catch(() => undefined);
    });

    this.element.append(trigger, popover);
    this.setBusy(this.busy);
  }
}

export function createResultInputStateControl(
  state: ResultInputEntryState,
  invalidStateLabel: "入力中" | "要確認" = "要確認",
): ResultInputStateControl {
  return new StateControl(state, invalidStateLabel);
}
