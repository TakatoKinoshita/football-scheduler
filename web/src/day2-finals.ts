import { placementTournamentPools, type JsonObject } from "./types";

export class Day2FinalPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Day2FinalPlacementError";
  }
}

export interface PoolFinalPlacement {
  poolId: string;
  matchId: string;
  section: number;
  gap: number;
}

export interface Day2FinalPlacementAnalysis {
  usedSections: number;
  finals: readonly PoolFinalPlacement[];
  primaryFinalId?: string;
  primaryFinalSection?: number;
  upperFinalId?: string;
  lowerFinalId?: string;
  upperFinalSection?: number;
  lowerFinalSection?: number;
  lowerFinalSectionGap?: number;
  primaryFinalIsLast: boolean;
  bothFinalsShareLastSection: boolean;
  hasFinalPlacementAudit: boolean;
  finalPlacementAuditMatches: boolean;
  legacyRuleViolation: boolean;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonObject =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

function rankRange(value: unknown): [number, number] | undefined {
  return Array.isArray(value)
      && value.length === 2
      && value.every((item) => Number.isInteger(item) && Number(item) > 0)
    ? [Number(value[0]), Number(value[1])]
    : undefined;
}

function finalRange(pool: JsonObject): [number, number] | undefined {
  const overall = rankRange(pool.overall_rank_range);
  if (overall !== undefined) return [overall[0], overall[0] + 1];
  return [1, 2];
}

function sameRange(value: unknown, expected: readonly [number, number]): boolean {
  const actual = rankRange(value);
  return actual?.[0] === expected[0] && actual[1] === expected[1];
}

function plannedFinalId(pool: JsonObject): string | undefined {
  const expected = finalRange(pool);
  if (expected === undefined) return undefined;
  const ids = objects(pool.matches)
    .filter((match) => sameRange(match.rank_range, expected) && typeof match.id === "string")
    .map((match) => String(match.id));
  return ids.length === 1 ? ids[0] : undefined;
}

function scheduledFinalIds(
  matches: readonly JsonObject[],
  poolId: string,
  legacyField: "upper" | "lower" | undefined,
  expectedRange: readonly [number, number],
): string[] {
  return matches
    .filter((match) => {
      if (typeof match.id !== "string") return false;
      if (legacyField !== undefined) {
        const expectedPhase = legacyField === "upper" ? "upper_tournament" : "lower_tournament";
        return match.phase === expectedPhase && sameRange(match.rank_range, expectedRange);
      }
      return match.phase === "placement_tournament"
        && match.pool_id === poolId
        && match.final === true
        && sameRange(match.rank_range, expectedRange);
    })
    .map((match) => String(match.id))
    .sort();
}

function sameAudit(
  metrics: JsonObject,
  finals: readonly PoolFinalPlacement[],
): { present: boolean; matches: boolean } {
  if (Array.isArray(metrics.placement_tournament_finals)) {
    const audit = objects(metrics.placement_tournament_finals);
    const matches = audit.length === finals.length && finals.every((final, index) => {
      const item = audit[index];
      return item?.pool_id === final.poolId
        && item.section_no === final.section
        && item.final_section_gap === final.gap;
    });
    const gaps = finals.slice(1).map((final) => final.gap);
    return {
      present: true,
      matches: matches
        && metrics.non_primary_final_max_gap === Math.max(0, ...gaps)
        && metrics.non_primary_final_sum_gap === gaps.reduce((sum, gap) => sum + gap, 0),
    };
  }
  const legacyFields = [
    "upper_tournament_final_section",
    "lower_tournament_final_section",
    "lower_tournament_final_section_gap",
  ];
  const present = legacyFields.some((field) => Object.hasOwn(metrics, field));
  if (!present) return { present: false, matches: true };
  const upper = finals.find((final) => final.poolId === "upper");
  const lower = finals.find((final) => final.poolId === "lower");
  return {
    present: true,
    matches: metrics.upper_tournament_final_section === (upper?.section ?? null)
      && metrics.lower_tournament_final_section === (lower?.section ?? null)
      && metrics.lower_tournament_final_section_gap === (lower?.gap ?? null),
  };
}

export function analyzeDay2FinalPlacement(
  schedule: JsonObject,
  tournamentPlan?: JsonObject,
): Day2FinalPlacementAnalysis {
  const matches = objects(schedule.tournament_matches);
  const allPools = tournamentPlan === undefined ? [] : placementTournamentPools(tournamentPlan);
  if (allPools.length === 0) {
    throw new Day2FinalPlacementError(
      "2日目日程の順位帯を読み取れません。日程を再作成してください。",
    );
  }
  const pools = allPools.filter(
      (pool) => Number(pool.data.participant_count) >= 2,
    );
  const positions = new Map<string, number>();
  let usedSections = 0;
  for (const slot of objects(schedule.slots)) {
    if (typeof slot.match_id !== "string" || !Number.isInteger(slot.section_no)) continue;
    positions.set(slot.match_id, Number(slot.section_no));
    usedSections = Math.max(usedSections, Number(slot.section_no));
  }

  const finals: PoolFinalPlacement[] = [];
  for (const pool of pools) {
    const expectedRange = finalRange(pool.data);
    const plannedId = plannedFinalId(pool.data);
    if (expectedRange === undefined || plannedId === undefined) {
      throw new Day2FinalPlacementError(
        "トーナメント表の決勝定義を読み取れません。トーナメント表を再作成してください。",
      );
    }
    const scheduledIds = scheduledFinalIds(matches, pool.poolId, pool.legacyField, expectedRange);
    if (scheduledIds.length !== 1 || scheduledIds[0] !== plannedId) {
      throw new Day2FinalPlacementError(
        "2日目日程の決勝定義がトーナメント表と一致しません。日程を再作成してください。",
      );
    }
    const section = positions.get(plannedId);
    if (section === undefined) {
      throw new Day2FinalPlacementError(
        "2日目日程に決勝の配置がありません。日程を再作成してください。",
      );
    }
    finals.push({ poolId: pool.poolId, matchId: plannedId, section, gap: usedSections - section });
  }

  const primary = finals[0];
  const metrics = typeof schedule.metrics === "object"
      && schedule.metrics !== null
      && !Array.isArray(schedule.metrics)
    ? schedule.metrics as JsonObject
    : {};
  const audit = sameAudit(metrics, finals);
  const legacy = allPools.every((pool) => pool.legacyField !== undefined);
  const upperFinal = finals.find((final) => final.poolId === "upper");
  const lowerFinal = finals.find((final) => final.poolId === "lower");
  return {
    usedSections,
    finals,
    ...(primary === undefined ? {} : {
      primaryFinalId: primary.matchId,
      primaryFinalSection: primary.section,
    }),
    ...(legacy && upperFinal !== undefined ? {
      upperFinalId: upperFinal.matchId,
      upperFinalSection: upperFinal.section,
    } : {}),
    ...(legacy && lowerFinal !== undefined ? {
      lowerFinalId: lowerFinal.matchId,
      lowerFinalSection: lowerFinal.section,
      lowerFinalSectionGap: lowerFinal.gap,
    } : {}),
    primaryFinalIsLast: primary === undefined || primary.section === usedSections,
    bothFinalsShareLastSection: finals.length === 2 && finals.every((final) => final.section === usedSections),
    hasFinalPlacementAudit: audit.present,
    finalPlacementAuditMatches: audit.matches,
    legacyRuleViolation: legacy && !audit.present && primary?.section !== usedSections,
  };
}

export function assertNewDay2FinalPlacement(
  schedule: JsonObject,
  tournamentPlan: JsonObject,
): Day2FinalPlacementAnalysis {
  const analysis = analyzeDay2FinalPlacement(schedule, tournamentPlan);
  if (!analysis.primaryFinalIsLast) {
    throw new Day2FinalPlacementError(
      "作成された2日目日程で最高順位帯の決勝が最終セクションにありません。保存せず、日程を再作成してください。",
    );
  }
  if (!analysis.hasFinalPlacementAudit || !analysis.finalPlacementAuditMatches) {
    throw new Day2FinalPlacementError(
      "作成された2日目日程の決勝配置を確認できません。保存せず、日程を再作成してください。",
    );
  }
  return analysis;
}
