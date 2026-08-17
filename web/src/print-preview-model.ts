import { buildSchedulePresentation } from "./schedule-presentation";
import {
  type PrintParticipant,
  type PrintPreviewFixture,
  type PrintPreviewMatch,
  type PrintPreviewScope,
  type PrintPreviewSlot,
} from "./print-preview-fixtures";
import { placementTournamentPools, type JsonObject } from "./types";

export interface PrintPreviewScheduleRow {
  matchId: string;
  displayNumber: string;
  sectionNo: number;
  timeLabel: string;
  courtName: string;
  homeLabel: string;
  awayLabel: string;
  refereeLabel: string;
}

export interface PrintPreviewCourtSchedule {
  courtId: string;
  courtName: string;
  rows: readonly PrintPreviewScheduleRow[];
}

export interface PrintPreviewParticipantSchedule {
  key: string;
  label: string;
  entries: readonly { displayNumber: string; timeLabel: string; courtName: string; role: string }[];
}

export interface PrintPreviewGroupModel {
  id: string;
  name: string;
  members: readonly string[];
}

export interface PrintPreviewTournamentPoolModel {
  poolId: string;
  name: string;
  heading: string;
  rankRangeLabel: string;
  participantCount: number;
  participantEntries: readonly string[];
  plan: JsonObject;
}

export interface PrintPreviewTournamentOverview {
  tournamentCount: number;
  courtCount: number;
  matchCount: number;
  startTimeLabel: string;
  endTimeLabel: string;
}

export interface PrintPreviewLeagueOverview {
  groupCount: number;
  courtCount: number;
  matchCount: number;
  startTimeLabel: string;
  endTimeLabel: string;
}

export interface PrintPreviewModel {
  fixtureId: string;
  description: string;
  scope: PrintPreviewScope;
  tournamentName: string;
  savedAtLabel: string;
  participantResolution: "provisional" | "resolved";
  groups: readonly PrintPreviewGroupModel[];
  scheduleHeading: string;
  courtSchedules: readonly PrintPreviewCourtSchedule[];
  participantSchedules: readonly PrintPreviewParticipantSchedule[];
  tournamentPools: readonly PrintPreviewTournamentPoolModel[];
  leagueOverview?: PrintPreviewLeagueOverview;
  tournamentOverview?: PrintPreviewTournamentOverview;
  teamNames: ReadonlyMap<string, string>;
  scheduleByMatchId: ReadonlyMap<
    string,
    { displayNumber: string; startTime?: string; timeLabel: string; courtName: string }
  >;
}

export class PrintPreviewFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintPreviewFixtureError";
  }
}

function printParticipant(value: unknown): PrintParticipant | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as JsonObject;
  if (entry.type === "concrete_team" && typeof entry.team_id === "string") {
    return { type: "concrete_team", team_id: entry.team_id };
  }
  if (
    entry.type === "league_rank"
    && typeof entry.block_id === "string"
    && typeof entry.rank === "number"
  ) {
    return { type: "league_rank", block_id: entry.block_id, rank: entry.rank };
  }
  if (
    (entry.type === "winner_of" || entry.type === "loser_of")
    && typeof entry.match_id === "string"
  ) {
    return { type: entry.type, match_id: entry.match_id };
  }
  return undefined;
}

function participantKey(participant: PrintParticipant): string {
  if (participant.type === "concrete_team") return `team:${participant.team_id}`;
  if (participant.type === "league_rank") {
    return `rank:${participant.block_id}:${String(participant.rank)}`;
  }
  return `${participant.type}:${participant.match_id}`;
}

function participantLabel(
  participant: PrintParticipant,
  teamNames: ReadonlyMap<string, string>,
  displayNumberByMatchId: ReadonlyMap<string, string>,
): string {
  if (participant.type === "concrete_team") {
    return teamNames.get(participant.team_id) ?? `不明なチーム（${participant.team_id}）`;
  }
  if (participant.type === "league_rank") {
    return `${participant.block_id}ブロック ${String(participant.rank)}位`;
  }
  const source = displayNumberByMatchId.get(participant.match_id) ?? participant.match_id;
  return `${source}の${participant.type === "winner_of" ? "勝者" : "敗者"}`;
}

function assertParticipant(
  participant: PrintParticipant,
  teamIds: ReadonlySet<string>,
  matchIds: ReadonlySet<string>,
  label: string,
): void {
  if (participant.type === "concrete_team") {
    if (!teamIds.has(participant.team_id)) {
      throw new PrintPreviewFixtureError(`${label}が未知のチーム「${participant.team_id}」を参照しています。`);
    }
    return;
  }
  if (participant.type === "league_rank") {
    if (participant.block_id.length === 0 || !Number.isInteger(participant.rank) || participant.rank < 1) {
      throw new PrintPreviewFixtureError(`${label}のリーグ順位枠が不正です。`);
    }
    return;
  }
  if (!matchIds.has(participant.match_id)) {
    throw new PrintPreviewFixtureError(`${label}が未知の試合「${participant.match_id}」を参照しています。`);
  }
}

function validateFixture(fixture: PrintPreviewFixture): void {
  if (fixture.teams.length !== 16 && fixture.teams.length !== 32) {
    throw new PrintPreviewFixtureError("印刷fixtureのチーム数は16または32である必要があります。");
  }
  const expectedCourtCount = fixture.teams.length === 16 ? 3 : 4;
  if (fixture.courts.length !== expectedCourtCount) {
    throw new PrintPreviewFixtureError(
      `${String(fixture.teams.length)}チーム印刷fixtureのコート数は${String(expectedCourtCount)}である必要があります。`,
    );
  }
  const teamIds = new Set(fixture.teams.map((team) => team.id));
  const courtIds = new Set(fixture.courts.map((court) => court.id));
  const matchIds = new Set(fixture.matches.map((match) => match.id));
  if (teamIds.size !== fixture.teams.length) {
    throw new PrintPreviewFixtureError("印刷fixtureのチームIDが重複しています。");
  }
  if (courtIds.size !== fixture.courts.length) {
    throw new PrintPreviewFixtureError("印刷fixtureのコートIDが重複しています。");
  }
  if (matchIds.size !== fixture.matches.length) {
    throw new PrintPreviewFixtureError("印刷fixtureの試合IDが重複しています。");
  }
  for (const match of fixture.matches) {
    assertParticipant(match.home, teamIds, matchIds, `試合「${match.id}」のホーム`);
    assertParticipant(match.away, teamIds, matchIds, `試合「${match.id}」のアウェー`);
  }
  const scheduled = new Map<string, number>();
  for (const slot of fixture.slots) {
    if (!courtIds.has(slot.court_id)) {
      throw new PrintPreviewFixtureError(`日程が未知のコート「${slot.court_id}」を参照しています。`);
    }
    if (slot.match_id !== null) {
      if (!matchIds.has(slot.match_id)) {
        throw new PrintPreviewFixtureError(`日程が未知の試合「${slot.match_id}」を参照しています。`);
      }
      scheduled.set(slot.match_id, (scheduled.get(slot.match_id) ?? 0) + 1);
    }
    if (slot.referee_assignment.kind === "team") {
      assertParticipant(slot.referee_assignment.team, teamIds, matchIds, "審判割当て");
    } else if (
      slot.referee_assignment.kind === "previous_match_winner"
      && !matchIds.has(slot.referee_assignment.match_id)
    ) {
      throw new PrintPreviewFixtureError(
        `審判割当てが未知の試合「${slot.referee_assignment.match_id}」を参照しています。`,
      );
    }
  }
  for (const match of fixture.matches) {
    if (scheduled.get(match.id) !== 1) {
      throw new PrintPreviewFixtureError(`試合「${match.id}」が日程に1回だけ配置されていません。`);
    }
  }
  const expectedGroupCount = fixture.scope === "day1-league"
    ? fixture.teams.length / 4
    : fixture.scope === "day2-same-rank" ? 4 : 0;
  if (fixture.groups.length !== expectedGroupCount) {
    throw new PrintPreviewFixtureError(
      `印刷fixtureのグループ数は${String(expectedGroupCount)}である必要があります。`,
    );
  }
  if (fixture.scope === "day2-tournament") {
    if (fixture.tournamentPlan === undefined) {
      throw new PrintPreviewFixtureError("トーナメント印刷fixtureに組合せがありません。");
    }
    if (placementTournamentPools(fixture.tournamentPlan).length !== 2) {
      throw new PrintPreviewFixtureError("トーナメント印刷fixtureは2つの順位帯を必要とします。");
    }
  }
}

function refereeLabel(
  slot: PrintPreviewSlot,
  teamNames: ReadonlyMap<string, string>,
  displayNumberByMatchId: ReadonlyMap<string, string>,
): string {
  const assignment = slot.referee_assignment;
  if (assignment.kind === "organizer") return "主催者";
  if (assignment.kind === "previous_match_winner") {
    return `${displayNumberByMatchId.get(assignment.match_id) ?? assignment.match_id}の勝者`;
  }
  return participantLabel(assignment.team, teamNames, displayNumberByMatchId);
}

function participantSchedules(
  fixture: PrintPreviewFixture,
  matches: ReadonlyMap<string, PrintPreviewMatch>,
  rows: readonly PrintPreviewScheduleRow[],
): PrintPreviewParticipantSchedule[] {
  const teamNames = new Map(fixture.teams.map((team) => [team.id, team.name]));
  const displayNumbers = new Map(rows.map((row) => [row.matchId, row.displayNumber]));
  const entries = new Map<string, {
    participant: PrintParticipant;
    items: Array<{ displayNumber: string; timeLabel: string; courtName: string; role: string }>;
  }>();
  const append = (participant: PrintParticipant, row: PrintPreviewScheduleRow, role: string): void => {
    if (participant.type === "winner_of" || participant.type === "loser_of") return;
    const key = participantKey(participant);
    const current = entries.get(key) ?? { participant, items: [] };
    current.items.push({
      displayNumber: row.displayNumber,
      timeLabel: row.timeLabel,
      courtName: row.courtName,
      role,
    });
    entries.set(key, current);
  };
  for (const row of rows) {
    const match = matches.get(row.matchId)!;
    append(match.home, row, `対 ${row.awayLabel}`);
    append(match.away, row, `対 ${row.homeLabel}`);
    const slot = fixture.slots.find((candidate) => candidate.match_id === row.matchId)!;
    if (slot.referee_assignment.kind === "team") {
      append(slot.referee_assignment.team, row, "審判");
    }
  }
  return [...entries].map(([key, value]) => ({
    key,
    label: participantLabel(value.participant, teamNames, displayNumbers),
    entries: value.items.sort((left, right) =>
      left.timeLabel.localeCompare(right.timeLabel) || left.displayNumber.localeCompare(right.displayNumber)
    ),
  })).sort((left, right) => left.label.localeCompare(right.label, "ja"));
}

export function buildPrintPreviewModel(fixture: PrintPreviewFixture): PrintPreviewModel {
  validateFixture(fixture);
  const teamNames = new Map(fixture.teams.map((team) => [team.id, team.name]));
  const matchById = new Map(fixture.matches.map((match) => [match.id, match]));
  let presentation;
  try {
    presentation = buildSchedulePresentation({
      dayId: fixture.scope === "day1-league" ? "day1" : "day2",
      courts: fixture.courts,
      slots: fixture.slots,
      sectionTimings: [],
      daySettings: fixture.daySettings,
    });
  } catch (error) {
    throw new PrintPreviewFixtureError(
      `印刷fixtureの日程を読み取れませんでした。${error instanceof Error ? error.message : "入力を確認してください。"}`,
    );
  }
  const allRows = presentation.timeRows.map((row): PrintPreviewScheduleRow => {
    const match = matchById.get(row.matchId)!;
    return {
      matchId: row.matchId,
      displayNumber: row.displayNumber,
      sectionNo: row.sectionNo,
      timeLabel: row.timeLabel,
      courtName: row.courtName,
      homeLabel: participantLabel(match.home, teamNames, presentation.displayNumberByMatchId),
      awayLabel: participantLabel(match.away, teamNames, presentation.displayNumberByMatchId),
      refereeLabel: refereeLabel(row.slot, teamNames, presentation.displayNumberByMatchId),
    };
  });
  const rowByMatchId = new Map(allRows.map((row) => [row.matchId, row]));
  const courtSchedules = presentation.courtGroups.map((group) => ({
    courtId: group.court.id,
    courtName: group.court.name,
    rows: group.rows.map((row) => rowByMatchId.get(row.matchId)!),
  }));
  const savedAt = new Date(fixture.savedAt);
  if (Number.isNaN(savedAt.valueOf())) {
    throw new PrintPreviewFixtureError("印刷fixtureの保存日時が不正です。");
  }
  const tournamentPools = fixture.tournamentPlan === undefined
    ? []
    : placementTournamentPools(fixture.tournamentPlan).map((pool) => {
        const range = Array.isArray(pool.data.overall_rank_range)
          ? pool.data.overall_rank_range
          : [];
        const rankRangeLabel = range.length === 2
          ? `総合${String(range[0])}〜${String(range[1])}位`
          : "総合順位帯未設定";
        const participantEntries = (Array.isArray(pool.data.seeds) ? pool.data.seeds : [])
          .filter((seed): seed is JsonObject =>
            typeof seed === "object" && seed !== null && !Array.isArray(seed)
          )
          .slice()
          .sort((left, right) => Number(left.seed_no ?? 0) - Number(right.seed_no ?? 0))
          .map((seed) => {
            const entry = printParticipant(seed.entry);
            const sourceLabel = entry === undefined
              ? "参加枠未設定"
              : participantLabel(entry, teamNames, presentation.displayNumberByMatchId);
            const resolvedName = fixture.participantResolution === "resolved"
              && typeof seed.team_id === "string"
              ? teamNames.get(seed.team_id)
              : undefined;
            return resolvedName === undefined ? sourceLabel : `${resolvedName}（${sourceLabel}）`;
          });
        return {
          poolId: pool.poolId,
          name: pool.displayName,
          heading: `${pool.displayName}表`,
          rankRangeLabel,
          participantCount: Number(pool.data.participant_count ?? participantEntries.length),
          participantEntries,
          plan: fixture.tournamentPlan!,
        };
      });
  const lastScheduleRow = presentation.timeRows.at(-1);
  return {
    fixtureId: fixture.id,
    description: fixture.description,
    scope: fixture.scope,
    tournamentName: fixture.tournamentName,
    savedAtLabel: new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(savedAt),
    participantResolution: fixture.participantResolution,
    groups: fixture.groups.map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((member) =>
        participantLabel(member, teamNames, presentation.displayNumberByMatchId)
      ),
    })),
    scheduleHeading: fixture.scope === "day1-league" ? "1日目の日程表" : "2日目の日程表",
    courtSchedules,
    participantSchedules: fixture.scope === "day2-tournament"
      ? []
      : participantSchedules(fixture, matchById, allRows),
    tournamentPools,
    ...(fixture.scope !== "day2-tournament"
      ? {
          leagueOverview: {
            groupCount: fixture.groups.length,
            courtCount: fixture.courts.length,
            matchCount: fixture.matches.length,
            startTimeLabel: presentation.timeRows[0]?.startTime ?? "未設定",
            endTimeLabel: lastScheduleRow?.matchEnd ?? "未設定",
          },
        }
      : {}),
    ...(fixture.scope === "day2-tournament"
      ? {
          tournamentOverview: {
            tournamentCount: tournamentPools.length,
            courtCount: fixture.courts.length,
            matchCount: fixture.matches.length,
            startTimeLabel: presentation.timeRows[0]?.startTime ?? "未設定",
            endTimeLabel: lastScheduleRow?.matchEnd ?? "未設定",
          },
        }
      : {}),
    teamNames,
    scheduleByMatchId: new Map(presentation.timeRows.map((row) => [
      row.matchId,
      {
        displayNumber: row.displayNumber,
        ...(row.startTime === undefined ? {} : { startTime: row.startTime }),
        timeLabel: row.timeLabel,
        courtName: row.courtName,
      },
    ])),
  };
}
