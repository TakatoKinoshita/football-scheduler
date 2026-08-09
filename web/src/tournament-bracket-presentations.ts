import {
  standardTournamentBracketLayout,
  type TournamentBracketInput,
  type TournamentBracketLayoutStrategy,
  type TournamentBracketModel,
} from "./tournament-bracket";
import { renderTournamentBracket } from "./tournament-bracket";
import { renderTournamentBracketExploration } from "./tournament-bracket-exploration-renderer";
import {
  horizontalTournamentBracketLayout,
  verticalTournamentBracketLayout,
} from "./tournament-bracket-exploration-layouts";
import { readTournamentLogicalLayout } from "./tournament-logical-layout";
import type { JsonObject } from "./types";

export type TournamentBracketRenderer = (
  model: TournamentBracketModel,
  heading: string,
) => HTMLElement;

export interface TournamentBracketPresentation {
  readonly id: "standard" | "vertical" | "horizontal";
  readonly layout: TournamentBracketLayoutStrategy;
  readonly render: TournamentBracketRenderer;
}

export type TournamentBracketViewMode = "horizontal" | "vertical";

export const TOURNAMENT_BRACKET_VIEW_STORAGE_KEY =
  "football-scheduler:tournament-bracket-view:v1";

export interface TournamentBracketViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TournamentBracketPresentationSelection {
  readonly presentation: TournamentBracketPresentation;
  readonly fallbackReason?: string;
}

export const tournamentBracketPresentations = {
  standard: {
    id: "standard",
    layout: standardTournamentBracketLayout,
    render: renderTournamentBracket,
  },
  vertical: {
    id: "vertical",
    layout: verticalTournamentBracketLayout,
    render: renderTournamentBracketExploration,
  },
  horizontal: {
    id: "horizontal",
    layout: horizontalTournamentBracketLayout,
    render: renderTournamentBracketExploration,
  },
} as const satisfies Readonly<Record<string, TournamentBracketPresentation>>;

function poolObject(input: TournamentBracketInput): JsonObject | undefined {
  const value = input.plan[input.pool];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resolveStorage(
  supplied: TournamentBracketViewStorage | null | undefined,
): TournamentBracketViewStorage | undefined {
  if (supplied === null) return undefined;
  if (supplied !== undefined) return supplied;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadTournamentBracketViewMode(
  storage?: TournamentBracketViewStorage | null,
): TournamentBracketViewMode {
  try {
    const saved = resolveStorage(storage)?.getItem(TOURNAMENT_BRACKET_VIEW_STORAGE_KEY);
    return saved === "vertical" ? "vertical" : "horizontal";
  } catch {
    return "horizontal";
  }
}

export function saveTournamentBracketViewMode(
  mode: TournamentBracketViewMode,
  storage?: TournamentBracketViewStorage | null,
): boolean {
  const normalized = mode === "vertical" ? "vertical" : "horizontal";
  try {
    const target = resolveStorage(storage);
    if (target === undefined) return false;
    target.setItem(TOURNAMENT_BRACKET_VIEW_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function selectTournamentBracketPresentation(
  input: TournamentBracketInput,
  mode: TournamentBracketViewMode,
): TournamentBracketPresentationSelection {
  const pool = poolObject(input);
  if (pool === undefined) {
    return {
      presentation: tournamentBracketPresentations.standard,
      fallbackReason: "トーナメント情報を読み取れないため、標準版で表示します。",
    };
  }
  const logicalLayout = readTournamentLogicalLayout(pool);
  if (pool.participant_count !== 8 && pool.participant_count !== 16) {
    return {
      presentation: tournamentBracketPresentations.standard,
      fallbackReason:
        "この参加数では水平版・垂直版の表示切替を利用できないため、標準版で表示します。",
    };
  }
  if (logicalLayout === undefined) {
    return {
      presentation: tournamentBracketPresentations.standard,
      fallbackReason:
        "この大会データには表示切替に必要な配置情報がないため、標準版で表示します。",
    };
  }
  if (logicalLayout.symmetry !== "mirrored") {
    return {
      presentation: tournamentBracketPresentations.standard,
      fallbackReason:
        "この組合せは水平版・垂直版の対応形状ではないため、標準版で表示します。",
    };
  }
  return { presentation: tournamentBracketPresentations[mode] };
}

export function defaultTournamentBracketPresentation(
  input: TournamentBracketInput,
): TournamentBracketPresentation {
  return selectTournamentBracketPresentation(input, "horizontal").presentation;
}

export function tournamentBracketPresentation(
  name: string,
): TournamentBracketPresentation | undefined {
  return Object.prototype.hasOwnProperty.call(tournamentBracketPresentations, name)
    ? tournamentBracketPresentations[name as keyof typeof tournamentBracketPresentations]
    : undefined;
}
