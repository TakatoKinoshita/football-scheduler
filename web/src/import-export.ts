import {
  DOCUMENT_TYPE,
  SCHEMA_VERSION,
  type JsonObject,
  type TournamentDocument,
} from "./types";
import { isDay1LeagueInput, normalizeDocument } from "./day1-form";

export const MAX_JSON_BYTES = 1_000_000;
export const LIMITS = {
  teams: 32,
  courts: 16,
  matches: 512,
  sections: 128,
} as const;

export class ImportValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportValidationError";
  }
}

function objectValue(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportValidationError("INVALID_DOCUMENT", message);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown, fieldName: string, maximum: number): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${fieldName}の一覧を読み取れませんでした。書き出したファイルを選び直してください。`,
    );
  }
  if (value.length > maximum) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `${fieldName}は${maximum}件までです。現在は${value.length}件あります。`,
    );
  }
  return value.map((entry) => objectValue(entry, `${fieldName}に不正な項目があります。`));
}

function uniqueIds(items: JsonObject[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new ImportValidationError("INVALID_REFERENCE", `${label}IDが空の項目があります。`);
    }
    if (ids.has(item.id)) {
      throw new ImportValidationError(
        "DUPLICATE_ID",
        `${label}ID「${item.id}」が重複しています。`,
      );
    }
    ids.add(item.id);
  }
  return ids;
}

function validateReferences(input: JsonObject, teams: JsonObject[], matches: JsonObject[]): void {
  const teamIds = uniqueIds(teams, "チーム");
  const matchIds = uniqueIds(matches, "試合");
  for (const match of matches) {
    const referencedTeams = [
      ...(Array.isArray(match.possible_home_team_ids) ? match.possible_home_team_ids : []),
      ...(Array.isArray(match.possible_away_team_ids) ? match.possible_away_team_ids : []),
      ...(typeof match.home_team_id === "string" ? [match.home_team_id] : []),
      ...(typeof match.away_team_id === "string" ? [match.away_team_id] : []),
    ];
    for (const teamId of referencedTeams) {
      if (typeof teamId !== "string" || !teamIds.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${String(match.id)}」が登録されていないチームを参照しています。`,
        );
      }
    }
    const prerequisites = Array.isArray(match.prerequisite_match_ids)
      ? match.prerequisite_match_ids
      : [];
    for (const matchId of prerequisites) {
      if (typeof matchId !== "string" || !matchIds.has(matchId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${String(match.id)}」が登録されていない前提試合を参照しています。`,
        );
      }
    }
  }

  const day = input.day;
  if (typeof day === "object" && day !== null && !Array.isArray(day)) {
    const maxSections = (day as JsonObject).max_sections;
    if (typeof maxSections === "number" && maxSections > LIMITS.sections) {
      throw new ImportValidationError(
        "LIMIT_EXCEEDED",
        `セクション数は${LIMITS.sections}までです。現在は${maxSections}です。`,
      );
    }
  }
  const topLevelMaxSections = input.max_sections;
  if (typeof topLevelMaxSections === "number" && topLevelMaxSections > LIMITS.sections) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `セクション数は${LIMITS.sections}までです。現在は${topLevelMaxSections}です。`,
    );
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${label}を読み取れませんでした。日程を再生成してください。`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ImportValidationError(
      "INVALID_DOCUMENT",
      `${label}は0以上の整数である必要があります。`,
    );
  }
  return value;
}

function validateLeagueResult(result: JsonObject, teams: JsonObject[], input: JsonObject): void {
  const planValue = result.league_plan;
  if (planValue === undefined) {
    if (
      result.league_results !== undefined ||
      result.league_standings !== undefined ||
      result.tournament_plan !== undefined
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "リーグ日程がないため、試合結果と順位を復元できませんでした。",
      );
    }
    return;
  }
  const plan = objectValue(planValue, "リーグ日程を読み取れませんでした。");
  const blocks = arrayValue(plan.blocks, "リーグブロック", LIMITS.teams);
  const blockIds = uniqueIds(blocks, "ブロック");
  const teamIds = new Set(
    teams.filter((team) => typeof team.id === "string").map((team) => team.id as string),
  );
  const teamToBlock = new Map<string, string>();
  for (const block of blocks) {
    const blockId = block.id as string;
    for (const teamId of stringArray(block.team_ids, `${blockId}ブロックのチーム一覧`)) {
      if (!teamIds.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `${blockId}ブロックが登録されていないチームを参照しています。`,
        );
      }
      if (teamToBlock.has(teamId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `チーム「${teamId}」が複数のブロックに登録されています。`,
        );
      }
      teamToBlock.set(teamId, blockId);
    }
  }

  const matches = arrayValue(plan.matches, "リーグ試合", LIMITS.matches);
  const matchIds = uniqueIds(matches, "試合");
  for (const match of matches) {
    if (match.phase !== "league") {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        `試合「${String(match.id)}」はリーグ試合ではありません。`,
      );
    }
    const home = stringArray(
      match.possible_home_team_ids,
      `試合「${String(match.id)}」のホームチーム`,
    );
    const away = stringArray(
      match.possible_away_team_ids,
      `試合「${String(match.id)}」のアウェーチーム`,
    );
    if (home.length !== 1 || away.length !== 1 || !teamIds.has(home[0]!) || !teamIds.has(away[0]!)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        `試合「${String(match.id)}」の対戦チームを確認できませんでした。`,
      );
    }
  }

  const rounds = arrayValue(plan.logical_rounds, "論理ラウンド", LIMITS.matches);
  const scheduledMatches = new Set<string>();
  for (const round of rounds) {
    if (typeof round.block_id !== "string" || !blockIds.has(round.block_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "論理ラウンドが登録されていないブロックを参照しています。",
      );
    }
    for (const matchId of stringArray(round.match_ids, "論理ラウンドの試合一覧")) {
      if (!matchIds.has(matchId) || scheduledMatches.has(matchId)) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${matchId}」のラウンド参照が不正です。`,
        );
      }
      scheduledMatches.add(matchId);
      const match = matches.find((candidate) => candidate.id === matchId)!;
      const home = (match.possible_home_team_ids as string[])[0]!;
      const away = (match.possible_away_team_ids as string[])[0]!;
      if (teamToBlock.get(home) !== round.block_id || teamToBlock.get(away) !== round.block_id) {
        throw new ImportValidationError(
          "INVALID_REFERENCE",
          `試合「${matchId}」のチームとブロックが一致しません。`,
        );
      }
    }
  }
  if (scheduledMatches.size !== matches.length) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "ラウンドに所属していないリーグ試合があります。",
    );
  }

  const leagueResults =
    result.league_results === undefined
      ? []
      : arrayValue(result.league_results, "リーグ結果", LIMITS.matches);
  const resultMatchIds = new Set<string>();
  for (const matchResult of leagueResults) {
    if (typeof matchResult.match_id !== "string" || !matchIds.has(matchResult.match_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "リーグ結果が日程にない試合を参照しています。",
      );
    }
    if (resultMatchIds.has(matchResult.match_id)) {
      throw new ImportValidationError(
        "DUPLICATE_ID",
        `試合「${matchResult.match_id}」の結果が重複しています。`,
      );
    }
    resultMatchIds.add(matchResult.match_id);
    nonNegativeInteger(matchResult.home_score, "ホーム得点");
    nonNegativeInteger(matchResult.away_score, "アウェー得点");
  }

  if (result.league_standings === undefined) {
    if (result.tournament_plan !== undefined) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "確定順位がないため、2日目トーナメントを復元できませんでした。",
      );
    }
    return;
  }
  if (resultMatchIds.size !== matches.length) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "全試合の結果が揃っていないため、確定順位を復元できませんでした。",
    );
  }
  const standings = objectValue(result.league_standings, "確定順位を読み取れませんでした。");
  if (standings.status !== "COMPLETE") {
    throw new ImportValidationError("INVALID_DOCUMENT", "確定順位の状態を読み取れませんでした。");
  }
  const rows = arrayValue(standings.standings, "順位表", LIMITS.teams);
  const rankedTeams = new Set<string>();
  const rankedPlaces = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.team_id !== "string" ||
      !teamIds.has(row.team_id) ||
      typeof row.block_id !== "string" ||
      !blockIds.has(row.block_id) ||
      teamToBlock.get(row.team_id) !== row.block_id
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "順位表が登録されていないチームまたはブロックを参照しています。",
      );
    }
    const rank = nonNegativeInteger(row.rank, "順位");
    if (rank === 0 || rankedTeams.has(row.team_id) || rankedPlaces.has(`${row.block_id}:${rank}`)) {
      throw new ImportValidationError("DUPLICATE_ID", "順位表に重複した順位があります。");
    }
    rankedTeams.add(row.team_id);
    rankedPlaces.add(`${row.block_id}:${rank}`);
  }
  if (rankedTeams.size !== teamToBlock.size) {
    throw new ImportValidationError("INVALID_REFERENCE", "順位表に不足しているチームがあります。");
  }
  const draws = arrayValue(standings.draws, "抽選記録", LIMITS.teams);
  for (const draw of draws) {
    if (typeof draw.block_id !== "string" || !blockIds.has(draw.block_id)) {
      throw new ImportValidationError("INVALID_REFERENCE", "抽選記録のブロックが不正です。");
    }
    const candidates = stringArray(draw.candidates, "抽選候補");
    const decidedOrder = stringArray(draw.decided_order, "抽選確定順");
    if (
      new Set(candidates).size !== candidates.length ||
      new Set(decidedOrder).size !== decidedOrder.length ||
      candidates.length !== decidedOrder.length ||
      candidates.some((teamId) => teamToBlock.get(teamId) !== draw.block_id) ||
      decidedOrder.some((teamId) => !candidates.includes(teamId)) ||
      typeof draw.random_seed !== "number" ||
      !Number.isInteger(draw.random_seed)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "抽選記録の内容が不正です。");
    }
  }
  if (result.tournament_plan !== undefined) {
    const leagueSettings = objectValue(input.league, "リーグ設定を読み取れませんでした。");
    const oddSplitPolicy =
      leagueSettings.odd_split_policy === undefined
        ? "upper"
        : String(leagueSettings.odd_split_policy);
    if (!new Set(["upper", "lower", "alternate"]).has(oddSplitPolicy)) {
      throw new ImportValidationError(
        "INVALID_DOCUMENT",
        "奇数人数ブロックの上下振り分けを読み取れませんでした。",
      );
    }
    const rowsByBlock = new Map<string, JsonObject[]>();
    for (const row of rows) {
      const blockRows = rowsByBlock.get(String(row.block_id)) ?? [];
      blockRows.push(row);
      rowsByBlock.set(String(row.block_id), blockRows);
    }
    const expectedUpperTeams = new Set<string>();
    let oddIndex = 0;
    for (const block of blocks) {
      const blockRows = (rowsByBlock.get(String(block.id)) ?? []).sort(
        (left, right) => Number(left.rank) - Number(right.rank),
      );
      const count = blockRows.length;
      let upperCount = count / 2;
      if (count % 2 === 1) {
        if (oddSplitPolicy === "upper") upperCount = (count + 1) / 2;
        else if (oddSplitPolicy === "lower") upperCount = (count - 1) / 2;
        else {
          upperCount = oddIndex % 2 === 0 ? (count + 1) / 2 : (count - 1) / 2;
          oddIndex += 1;
        }
      }
      for (const row of blockRows.slice(0, upperCount)) {
        expectedUpperTeams.add(String(row.team_id));
      }
    }
    validateTournamentPlan(
      objectValue(result.tournament_plan, "2日目トーナメントを読み取れませんでした。"),
      rows,
      teamIds,
      oddSplitPolicy,
      expectedUpperTeams,
    );
  }
}

function expectedTournamentMatchCount(participantCount: number): number {
  if (participantCount <= 1) return 0;
  const mainSize = 2 ** Math.floor(Math.log2(participantCount));
  if (mainSize === participantCount) {
    return participantCount / 2 + 2 * expectedTournamentMatchCount(participantCount / 2);
  }
  const preliminaryCount = participantCount - mainSize;
  return (
    preliminaryCount +
    expectedTournamentMatchCount(mainSize) +
    expectedTournamentMatchCount(preliminaryCount)
  );
}

function expectedTournamentByeCount(participantCount: number): number {
  if (participantCount <= 1) return 0;
  const mainSize = 2 ** Math.floor(Math.log2(participantCount));
  if (mainSize === participantCount) return 0;
  const preliminaryCount = participantCount - mainSize;
  return (
    participantCount -
    2 * preliminaryCount +
    expectedTournamentByeCount(preliminaryCount)
  );
}

function validateTournamentEntry(
  value: unknown,
  leagueRanks: Set<string>,
  teamIds: Set<string>,
  matchIds: Set<string>,
): JsonObject {
  const entry = objectValue(value, "トーナメントの参加参照を読み取れませんでした。");
  if (entry.type === "league_rank") {
    if (
      typeof entry.block_id !== "string" ||
      !Number.isInteger(entry.rank) ||
      !leagueRanks.has(`${entry.block_id}:${String(entry.rank)}`)
    ) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが存在しないリーグ順位を参照しています。",
      );
    }
    return entry;
  }
  if (entry.type === "concrete_team") {
    if (typeof entry.team_id !== "string" || !teamIds.has(entry.team_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが登録されていないチームを参照しています。",
      );
    }
    return entry;
  }
  if (entry.type === "winner_of" || entry.type === "loser_of") {
    if (typeof entry.match_id !== "string" || !matchIds.has(entry.match_id)) {
      throw new ImportValidationError(
        "INVALID_REFERENCE",
        "トーナメントが存在しない試合結果を参照しています。",
      );
    }
    return entry;
  }
  throw new ImportValidationError(
    "INVALID_DOCUMENT",
    "トーナメントの参加参照の種類を読み取れませんでした。",
  );
}

function validateTournamentPool(
  value: unknown,
  expectedPool: "upper" | "lower",
  teamByRank: Map<string, string>,
): {
  seedTeams: Set<string>;
  matchIds: Set<string>;
  seedTeamsByRank: Map<number, string[]>;
  firstMatchCount: number;
} {
  const pool = objectValue(value, "トーナメント区分を読み取れませんでした。");
  if (pool.pool !== expectedPool) {
    throw new ImportValidationError("INVALID_DOCUMENT", "トーナメント区分が一致しません。");
  }
  const participantCount = nonNegativeInteger(pool.participant_count, "トーナメント参加数");
  if (participantCount > LIMITS.teams) {
    throw new ImportValidationError(
      "LIMIT_EXCEEDED",
      `トーナメント参加数は${LIMITS.teams}チームまでです。`,
    );
  }
  const seeds = arrayValue(pool.seeds, "トーナメントシード", LIMITS.teams);
  if (seeds.length !== participantCount) {
    throw new ImportValidationError("INVALID_REFERENCE", "トーナメント参加数とシード数が一致しません。");
  }
  const seedTeams = new Set<string>();
  const seedNumbers = new Set<number>();
  const poolLeagueRanks = new Set<string>();
  const seedTeamsByRank = new Map<number, string[]>();
  for (const seed of seeds) {
    const seedNo = nonNegativeInteger(seed.seed_no, "シード番号");
    const rank = nonNegativeInteger(seed.block_rank, "ブロック順位");
    const rankKey = `${String(seed.block_id)}:${rank}`;
    if (
      seedNo === 0 ||
      seedNumbers.has(seedNo) ||
      typeof seed.team_id !== "string" ||
      seedTeams.has(seed.team_id) ||
      teamByRank.get(rankKey) !== seed.team_id
    ) {
      throw new ImportValidationError("DUPLICATE_ID", "トーナメントシードの内容が不正です。");
    }
    seedNumbers.add(seedNo);
    seedTeams.add(seed.team_id);
    poolLeagueRanks.add(rankKey);
    seedTeamsByRank.set(rank, [...(seedTeamsByRank.get(rank) ?? []), seed.team_id]);
    const entry = objectValue(seed.entry, "シードのリーグ順位参照を読み取れませんでした。");
    const team = objectValue(seed.team, "シードのチーム参照を読み取れませんでした。");
    if (
      entry.type !== "league_rank" ||
      entry.block_id !== seed.block_id ||
      entry.rank !== rank ||
      team.type !== "concrete_team" ||
      team.team_id !== seed.team_id
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "シードの参照内容が一致しません。");
    }
  }
  if (
    seedNumbers.size !== participantCount ||
    [...seedNumbers].some((number) => number < 1 || number > participantCount)
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "シード番号に欠落があります。");
  }

  const matches = arrayValue(pool.matches, "トーナメント試合", LIMITS.matches);
  if (matches.length !== expectedTournamentMatchCount(participantCount)) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "全順位を決めるために必要なトーナメント試合数と一致しません。",
    );
  }
  const matchIds = uniqueIds(matches, "トーナメント試合");
  const dependencies = new Map<string, string[]>();
  for (const match of matches) {
    if (
      match.phase !== `${expectedPool}_tournament` ||
      typeof match.round !== "string" ||
      !Number.isInteger(match.round_no) ||
      Number(match.round_no) < 1 ||
      !Array.isArray(match.rank_range) ||
      match.rank_range.length !== 2 ||
      match.rank_range.some(
        (rank) =>
          !Number.isInteger(rank) || Number(rank) < 1 || Number(rank) > participantCount,
      ) ||
      Number(match.rank_range[0]) > Number(match.rank_range[1])
    ) {
      throw new ImportValidationError("INVALID_DOCUMENT", "トーナメント試合の内容が不正です。");
    }
    const home = validateTournamentEntry(match.home, poolLeagueRanks, seedTeams, matchIds);
    const away = validateTournamentEntry(match.away, poolLeagueRanks, seedTeams, matchIds);
    dependencies.set(
      String(match.id),
      [home, away]
        .filter((entry) => entry.type === "winner_of" || entry.type === "loser_of")
        .map((entry) => String(entry.match_id)),
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (matchId: string): void => {
    if (visiting.has(matchId)) {
      throw new ImportValidationError("INVALID_REFERENCE", "トーナメント試合の参照が循環しています。");
    }
    if (visited.has(matchId)) return;
    visiting.add(matchId);
    for (const dependency of dependencies.get(matchId) ?? []) visit(dependency);
    visiting.delete(matchId);
    visited.add(matchId);
  };
  for (const matchId of matchIds) visit(matchId);

  const byes = arrayValue(pool.byes, "不戦通過記録", LIMITS.teams);
  if (byes.length !== expectedTournamentByeCount(participantCount)) {
    throw new ImportValidationError("INVALID_REFERENCE", "不戦通過記録に不足または重複があります。");
  }
  for (const bye of byes) {
    if (bye.result !== "advance_by_bye" || typeof bye.next_match_id !== "string") {
      throw new ImportValidationError("INVALID_DOCUMENT", "不戦通過記録の内容が不正です。");
    }
    const entry = validateTournamentEntry(bye.entry, poolLeagueRanks, seedTeams, matchIds);
    const nextMatch = matches.find((match) => match.id === bye.next_match_id);
    if (
      nextMatch === undefined ||
      (JSON.stringify(nextMatch.home) !== JSON.stringify(entry) &&
        JSON.stringify(nextMatch.away) !== JSON.stringify(entry))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "不戦通過の接続先が不正です。");
    }
  }

  const placements = arrayValue(pool.placements, "最終順位参照", LIMITS.teams);
  const ranks = new Set<number>();
  for (const placement of placements) {
    const rank = nonNegativeInteger(placement.rank, "最終順位");
    if (rank === 0 || rank > participantCount || ranks.has(rank)) {
      throw new ImportValidationError("DUPLICATE_ID", "最終順位参照に重複または欠落があります。");
    }
    ranks.add(rank);
    validateTournamentEntry(placement.entry, poolLeagueRanks, seedTeams, matchIds);
  }
  if (ranks.size !== participantCount) {
    throw new ImportValidationError("INVALID_REFERENCE", "最終順位参照に不足があります。");
  }
  const evaluation = objectValue(pool.evaluation, "組合せ評価を読み取れませんでした。");
  const firstMatchCount = nonNegativeInteger(
    evaluation.first_match_same_block_count,
    "初戦同一ブロック対戦数",
  );
  const possibleMatchCount = nonNegativeInteger(
    evaluation.possible_same_block_match_count,
    "同一ブロック対戦可能性数",
  );
  if (
    firstMatchCount > possibleMatchCount ||
    (evaluation.earliest_possible_same_block_round !== null &&
      evaluation.earliest_possible_same_block_round !== undefined &&
      (!Number.isInteger(evaluation.earliest_possible_same_block_round) ||
        Number(evaluation.earliest_possible_same_block_round) < 1))
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "組合せ評価の内容が不正です。");
  }
  return { seedTeams, matchIds, seedTeamsByRank, firstMatchCount };
}

function validateTournamentPlan(
  plan: JsonObject,
  standings: JsonObject[],
  teamIds: Set<string>,
  expectedPolicy: string,
  expectedUpperTeams: Set<string>,
): void {
  if (
    plan.schema_version !== SCHEMA_VERSION ||
    plan.status !== "COMPLETE" ||
    !new Set(["upper", "lower", "alternate"]).has(String(plan.odd_split_policy)) ||
    plan.odd_split_policy !== expectedPolicy ||
    typeof plan.random_seed !== "number" ||
    !Number.isInteger(plan.random_seed)
  ) {
    throw new ImportValidationError("INVALID_DOCUMENT", "2日目トーナメントの状態が不正です。");
  }
  const teamByRank = new Map(
    standings.map((row) => [`${String(row.block_id)}:${String(row.rank)}`, String(row.team_id)]),
  );
  const upper = validateTournamentPool(plan.upper, "upper", teamByRank);
  const lower = validateTournamentPool(plan.lower, "lower", teamByRank);
  const allSeeds = new Set([...upper.seedTeams, ...lower.seedTeams]);
  if (
    allSeeds.size !== teamIds.size ||
    [...upper.seedTeams].some((teamId) => lower.seedTeams.has(teamId)) ||
    upper.seedTeams.size !== expectedUpperTeams.size ||
    [...upper.seedTeams].some((teamId) => !expectedUpperTeams.has(teamId))
  ) {
    throw new ImportValidationError(
      "INVALID_REFERENCE",
      "上位・下位トーナメントの参加チームに重複または不足があります。",
    );
  }
  if ([...upper.matchIds].some((matchId) => lower.matchIds.has(matchId))) {
    throw new ImportValidationError("DUPLICATE_ID", "上下のトーナメントで試合IDが重複しています。");
  }

  const draws = arrayValue(plan.seed_draws, "シード抽選記録", LIMITS.teams * 2);
  const drawKeys = new Set<string>();
  for (const draw of draws) {
    const pool = draw.pool === "upper" ? upper : draw.pool === "lower" ? lower : undefined;
    const candidates = stringArray(draw.candidates, "シード抽選候補");
    const decidedOrder = stringArray(draw.decided_order, "シード抽選確定順");
    const blockRank = nonNegativeInteger(draw.block_rank, "シード抽選のブロック順位");
    const expectedCandidates = pool?.seedTeamsByRank.get(blockRank) ?? [];
    const drawKey = `${String(draw.pool)}:${blockRank}`;
    if (
      pool === undefined ||
      blockRank === 0 ||
      typeof draw.random_seed !== "number" ||
      !Number.isInteger(draw.random_seed) ||
      draw.random_seed !== plan.random_seed ||
      candidates.length !== decidedOrder.length ||
      new Set(candidates).size !== candidates.length ||
      decidedOrder.some((teamId) => !candidates.includes(teamId)) ||
      candidates.some((teamId) => !pool.seedTeams.has(teamId)) ||
      candidates.length !== expectedCandidates.length ||
      candidates.some((teamId) => !expectedCandidates.includes(teamId)) ||
      drawKeys.has(drawKey)
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録の内容が不正です。");
    }
    drawKeys.add(drawKey);
  }
  const expectedDrawKeys = [
    ...[...upper.seedTeamsByRank].filter(([, teams]) => teams.length > 1).map(([rank]) => `upper:${rank}`),
    ...[...lower.seedTeamsByRank].filter(([, teams]) => teams.length > 1).map(([rank]) => `lower:${rank}`),
  ];
  if (
    drawKeys.size !== expectedDrawKeys.length ||
    expectedDrawKeys.some((key) => !drawKeys.has(key))
  ) {
    throw new ImportValidationError("INVALID_REFERENCE", "シード抽選記録に不足があります。");
  }

  const warnings = arrayValue(plan.warnings, "トーナメント警告", LIMITS.matches);
  for (const warning of warnings) {
    const matchIds =
      warning.pool === "upper"
        ? upper.matchIds
        : warning.pool === "lower"
          ? lower.matchIds
          : undefined;
    if (
      typeof warning.code !== "string" ||
      typeof warning.message !== "string" ||
      matchIds === undefined ||
      stringArray(warning.match_ids, "警告対象試合").some((matchId) => !matchIds.has(matchId))
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "トーナメント警告の内容が不正です。");
    }
  }
  for (const [poolName, pool] of [
    ["upper", upper],
    ["lower", lower],
  ] as const) {
    if (
      pool.firstMatchCount > 0 &&
      !warnings.some(
        (warning) =>
          warning.pool === poolName && warning.code === "SAME_BLOCK_FIRST_MATCH_UNAVOIDABLE",
      )
    ) {
      throw new ImportValidationError("INVALID_REFERENCE", "同一ブロック初戦の警告記録に不足があります。");
    }
  }
}

export function parseTournamentJson(text: string): TournamentDocument {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new ImportValidationError(
      "FILE_TOO_LARGE",
      "ファイルが1 MBを超えています。大会を分けるか、不要な内容を減らしてください。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportValidationError(
      "INVALID_JSON",
      "ファイルを読み取れませんでした。以前このアプリで書き出したJSONファイルか確認してください。",
    );
  }

  const root = objectValue(parsed, "大会データの形式を読み取れませんでした。");
  if (root.documentType !== DOCUMENT_TYPE) {
    throw new ImportValidationError(
      "UNKNOWN_DOCUMENT_TYPE",
      "このアプリの大会データではありません。選択したファイルを確認してください。",
    );
  }
  if (root.schemaVersion !== SCHEMA_VERSION) {
    throw new ImportValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `このファイルの版「${String(root.schemaVersion)}」には対応していません。アプリを更新してから再度お試しください。`,
    );
  }

  const tournament = objectValue(root.tournament, "大会情報を読み取れませんでした。");
  if (typeof tournament.name !== "string" || tournament.name.trim().length === 0) {
    throw new ImportValidationError("INVALID_DOCUMENT", "大会名が入力されていません。");
  }
  const input = objectValue(tournament.input, "大会の入力内容を読み取れませんでした。");
  if (input.schema_version !== SCHEMA_VERSION) {
    throw new ImportValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "大会設定の版に対応していません。アプリを更新してから再度お試しください。",
    );
  }
  const teams = arrayValue(input.teams, "チーム", LIMITS.teams);
  const courts = arrayValue(input.courts, "コート", LIMITS.courts);
  uniqueIds(courts, "コート");
  const matches = isDay1LeagueInput(input)
    ? []
    : arrayValue(input.matches, "試合", LIMITS.matches);
  validateReferences(input, teams, matches);
  if (tournament.result !== undefined) {
    validateLeagueResult(
      objectValue(tournament.result, "生成結果を読み取れませんでした。"),
      teams,
      input,
    );
  }
  if (typeof root.updatedAt !== "string" || Number.isNaN(Date.parse(root.updatedAt))) {
    throw new ImportValidationError("INVALID_DOCUMENT", "保存日時を読み取れませんでした。");
  }

  const document = structuredClone(root) as unknown as TournamentDocument;
  return normalizeDocument(document).document;
}

export function serializeTournamentJson(document: TournamentDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function safeFileName(tournamentName: string): string {
  const normalized = tournamentName
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${normalized || "大会データ"}.json`;
}
