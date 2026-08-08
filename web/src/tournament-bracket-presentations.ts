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

export function defaultTournamentBracketPresentation(
  input: TournamentBracketInput,
): TournamentBracketPresentation {
  const pool = poolObject(input);
  if (pool === undefined) {
    return tournamentBracketPresentations.standard;
  }
  const logicalLayout = readTournamentLogicalLayout(pool);
  if (pool.participant_count !== 8 && pool.participant_count !== 16) {
    return tournamentBracketPresentations.standard;
  }
  return logicalLayout?.symmetry === "mirrored"
    ? tournamentBracketPresentations.horizontal
    : tournamentBracketPresentations.standard;
}

export function tournamentBracketPresentation(
  name: string,
): TournamentBracketPresentation | undefined {
  return Object.prototype.hasOwnProperty.call(tournamentBracketPresentations, name)
    ? tournamentBracketPresentations[name as keyof typeof tournamentBracketPresentations]
    : undefined;
}
