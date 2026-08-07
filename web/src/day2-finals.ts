import type { JsonObject } from "./types";

export class Day2FinalPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Day2FinalPlacementError";
  }
}

export interface Day2FinalPlacementAnalysis {
  usedSections: number;
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

function isFinal(match: JsonObject): boolean {
  return Array.isArray(match.rank_range)
    && match.rank_range.length === 2
    && match.rank_range[0] === 1
    && match.rank_range[1] === 2;
}

function finalIds(matches: JsonObject[]): { upper: string[]; lower: string[] } {
  const result = { upper: [] as string[], lower: [] as string[] };
  for (const match of matches) {
    if (!isFinal(match) || typeof match.id !== "string") continue;
    if (match.phase === "upper_tournament") result.upper.push(match.id);
    if (match.phase === "lower_tournament") result.lower.push(match.id);
  }
  result.upper.sort();
  result.lower.sort();
  return result;
}

function plannedFinalIds(plan: JsonObject | undefined): {
  upper: string[];
  lower: string[];
  expectedUpper: number | undefined;
  expectedLower: number | undefined;
} | undefined {
  if (plan === undefined) return undefined;
  const upper = plan.upper;
  const lower = plan.lower;
  if (
    typeof upper !== "object" || upper === null || Array.isArray(upper)
    || typeof lower !== "object" || lower === null || Array.isArray(lower)
  ) {
    return undefined;
  }
  const upperParticipantCount = (upper as JsonObject).participant_count;
  const lowerParticipantCount = (lower as JsonObject).participant_count;
  return {
    upper: finalIds(objects((upper as JsonObject).matches)).upper,
    lower: finalIds(objects((lower as JsonObject).matches)).lower,
    expectedUpper: typeof upperParticipantCount === "number"
      ? Number(upperParticipantCount >= 2)
      : undefined,
    expectedLower: typeof lowerParticipantCount === "number"
      ? Number(lowerParticipantCount >= 2)
      : undefined,
  };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function metricValue(metrics: JsonObject, field: string): number | undefined {
  const value = metrics[field];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function analyzeDay2FinalPlacement(
  schedule: JsonObject,
  tournamentPlan?: JsonObject,
): Day2FinalPlacementAnalysis {
  const matches = objects(schedule.tournament_matches);
  const finals = finalIds(matches);
  const planned = plannedFinalIds(tournamentPlan);
  if (
    finals.upper.length > 1
    || finals.lower.length > 1
    || (planned !== undefined
      && (
        !sameIds(finals.upper, planned.upper)
        || !sameIds(finals.lower, planned.lower)
        || (planned.expectedUpper !== undefined && planned.upper.length !== planned.expectedUpper)
        || (planned.expectedLower !== undefined && planned.lower.length !== planned.expectedLower)
      ))
  ) {
    throw new Day2FinalPlacementError(
      "2日目日程の決勝定義がトーナメント表と一致しません。日程を再作成してください。",
    );
  }
  for (const match of matches) {
    if (
      (match.phase === "upper_tournament" || match.phase === "lower_tournament")
      && typeof match.final === "boolean"
      && match.final !== isFinal(match)
    ) {
      throw new Day2FinalPlacementError(
        "2日目日程の決勝注記が順位範囲と一致しません。日程を再作成してください。",
      );
    }
  }

  const positions = new Map<string, number>();
  let usedSections = 0;
  for (const slot of objects(schedule.slots)) {
    if (typeof slot.match_id !== "string" || typeof slot.section_no !== "number") continue;
    positions.set(slot.match_id, slot.section_no);
    usedSections = Math.max(usedSections, slot.section_no);
  }
  const upperFinalId = finals.upper[0];
  const lowerFinalId = finals.lower[0];
  const upperFinalSection = upperFinalId === undefined ? undefined : positions.get(upperFinalId);
  const lowerFinalSection = lowerFinalId === undefined ? undefined : positions.get(lowerFinalId);
  if (
    (upperFinalId !== undefined && upperFinalSection === undefined)
    || (lowerFinalId !== undefined && lowerFinalSection === undefined)
  ) {
    throw new Day2FinalPlacementError(
      "2日目日程に決勝の配置がありません。日程を再作成してください。",
    );
  }
  const primaryFinalSection = upperFinalSection ?? lowerFinalSection;
  const primaryFinalIsLast = primaryFinalSection === undefined || primaryFinalSection === usedSections;
  const lowerFinalSectionGap = lowerFinalSection === undefined
    ? undefined
    : usedSections - lowerFinalSection;

  const metrics = (
    typeof schedule.metrics === "object"
      && schedule.metrics !== null
      && !Array.isArray(schedule.metrics)
  ) ? schedule.metrics as JsonObject : {};
  const auditFields = [
    "upper_tournament_final_section",
    "lower_tournament_final_section",
    "lower_tournament_final_section_gap",
  ];
  const hasFinalPlacementAudit = auditFields.some((field) =>
    Object.prototype.hasOwnProperty.call(metrics, field)
  );
  const expectedUpper = upperFinalSection;
  const expectedLower = lowerFinalSection;
  const expectedGap = lowerFinalSectionGap;
  const finalPlacementAuditMatches = !hasFinalPlacementAudit || (
    auditFields.every((field) => Object.prototype.hasOwnProperty.call(metrics, field))
    && metricValue(metrics, "upper_tournament_final_section") === expectedUpper
    && metricValue(metrics, "lower_tournament_final_section") === expectedLower
    && metricValue(metrics, "lower_tournament_final_section_gap") === expectedGap
  );

  return {
    usedSections,
    ...(upperFinalId === undefined ? {} : { upperFinalId }),
    ...(lowerFinalId === undefined ? {} : { lowerFinalId }),
    ...(upperFinalSection === undefined ? {} : { upperFinalSection }),
    ...(lowerFinalSection === undefined ? {} : { lowerFinalSection }),
    ...(lowerFinalSectionGap === undefined ? {} : { lowerFinalSectionGap }),
    primaryFinalIsLast,
    bothFinalsShareLastSection:
      upperFinalSection !== undefined
      && lowerFinalSection !== undefined
      && upperFinalSection === usedSections
      && lowerFinalSection === usedSections,
    hasFinalPlacementAudit,
    finalPlacementAuditMatches,
    legacyRuleViolation: !hasFinalPlacementAudit && !primaryFinalIsLast,
  };
}

export function assertNewDay2FinalPlacement(
  schedule: JsonObject,
  tournamentPlan: JsonObject,
): Day2FinalPlacementAnalysis {
  const analysis = analyzeDay2FinalPlacement(schedule, tournamentPlan);
  if (!analysis.primaryFinalIsLast) {
    throw new Day2FinalPlacementError(
      "作成された2日目日程で決勝が最終セクションにありません。保存せず、日程を再作成してください。",
    );
  }
  if (!analysis.hasFinalPlacementAudit || !analysis.finalPlacementAuditMatches) {
    throw new Day2FinalPlacementError(
      "作成された2日目日程の決勝配置を確認できません。保存せず、日程を再作成してください。",
    );
  }
  return analysis;
}
