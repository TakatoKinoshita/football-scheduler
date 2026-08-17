import { buildProductionPrintFixture } from "./print-document-model";
import {
  displayedTeamPair,
  leagueAwayFirstMatchIds,
} from "./league-team-display-order";
import {
  buildPrintPreviewModel,
  type PrintPreviewScheduleRow,
} from "./print-preview-model";
import {
  type PrintParticipant,
  type PrintPreviewFixture,
  type PrintPreviewMatch,
  type PrintPreviewRoute,
} from "./print-preview-fixtures";
import type { TournamentDocument } from "./types";
import {
  type WorkbookCell,
  type WorkbookCellStyle,
  type WorkbookFile,
  type WorkbookSheet,
  numberCell,
  sanitizeWorkbookFileName,
  textCell,
  uniqueSheetNames,
} from "./workbook";

export type ScheduleWorkbookScope = "day1" | "day2";

export class ScheduleWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleWorkbookError";
  }
}

const META_LABEL_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  textColor: "#FFFFFF",
  backgroundColor: "#174F3F",
  borderColor: "#174F3F",
  borderStyle: "thin",
};
const META_VALUE_STYLE: WorkbookCellStyle = {
  borderColor: "#AAB8B2",
  borderStyle: "thin",
  wrap: true,
};
const HEADER_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  textColor: "#FFFFFF",
  backgroundColor: "#28705B",
  borderColor: "#174F3F",
  borderStyle: "thin",
  align: "center",
  alignVertical: "center",
  wrap: true,
};
const DATA_STYLE: WorkbookCellStyle = {
  borderColor: "#AAB8B2",
  borderStyle: "thin",
  alignVertical: "top",
  wrap: true,
};
const MATCHUP_BORDER_COLOR = "#AAB8B2";
const MATCHUP_STYLE: WorkbookCellStyle = {
  topBorderColor: MATCHUP_BORDER_COLOR,
  topBorderStyle: "thin",
  bottomBorderColor: MATCHUP_BORDER_COLOR,
  bottomBorderStyle: "thin",
  alignVertical: "top",
  wrap: true,
};
const GROUP_STYLE: WorkbookCellStyle = {
  fontWeight: "bold",
  backgroundColor: "#DDECE6",
  borderColor: "#AAB8B2",
  borderStyle: "thin",
};

interface TeamScheduleEntry {
  sectionNo: number;
  courtId: string;
  startTime: string;
  courtName: string;
  role: "試合" | "審判";
  opponent: string;
  displayNumber: string;
}

interface TeamScheduleGroup {
  key: string;
  label: string;
  entries: TeamScheduleEntry[];
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
): string {
  if (participant.type === "concrete_team") {
    return teamNames.get(participant.team_id) ?? `不明なチーム（${participant.team_id}）`;
  }
  if (participant.type === "league_rank") {
    return `${participant.block_id}ブロック${String(participant.rank)}位`;
  }
  return "前の試合結果で決定";
}

function scheduleParticipantLabel(
  participant: PrintParticipant,
  teamNames: ReadonlyMap<string, string>,
  displayNumbers: ReadonlyMap<string, string>,
): string {
  if (participant.type !== "winner_of" && participant.type !== "loser_of") {
    return participantLabel(participant, teamNames);
  }
  const displayNumber = displayNumbers.get(participant.match_id);
  if (displayNumber === undefined) {
    throw new ScheduleWorkbookError("勝敗参照元の試合番号を読み取れません。");
  }
  return `${displayNumber}${participant.type === "winner_of" ? "勝" : "負"}`;
}

function workbookAwayFirstMatchIds(fixture: PrintPreviewFixture): ReadonlySet<string> {
  if (fixture.scope === "day2-tournament") return new Set();
  return leagueAwayFirstMatchIds(
    fixture.matches.map((match) => ({
      matchId: match.id,
      homeEntryKey: participantKey(match.home),
      awayEntryKey: participantKey(match.away),
    })),
    fixture.slots.flatMap((slot) => {
      if (slot.match_id === null) return [];
      const refereeEntryKey = slot.referee_assignment.kind === "team"
        ? participantKey(slot.referee_assignment.team)
        : undefined;
      return [{
        sectionNo: slot.section_no,
        courtId: slot.court_id,
        matchId: slot.match_id,
        ...(refereeEntryKey === undefined ? {} : { refereeEntryKey }),
      }];
    }),
  );
}

function workbookScheduleRows(
  fixture: PrintPreviewFixture,
  rows: readonly PrintPreviewScheduleRow[],
): PrintPreviewScheduleRow[] {
  const teamNames = new Map(fixture.teams.map((team) => [team.id, team.name]));
  const matches = new Map(fixture.matches.map((match) => [match.id, match]));
  const slots = new Map(
    fixture.slots
      .filter((slot): slot is typeof slot & { match_id: string } => slot.match_id !== null)
      .map((slot) => [slot.match_id, slot]),
  );
  const displayNumbers = new Map(rows.map((row) => [row.matchId, row.displayNumber]));
  const awayFirstMatchIds = workbookAwayFirstMatchIds(fixture);
  return rows.map((row) => {
    const match = matches.get(row.matchId);
    const slot = slots.get(row.matchId);
    if (match === undefined || slot === undefined) {
      throw new ScheduleWorkbookError("日程の試合または審判割当てを読み取れません。");
    }
    const refereeLabel = slot.referee_assignment.kind === "organizer"
      ? "主催者"
      : slot.referee_assignment.kind === "previous_match_winner"
        ? scheduleParticipantLabel(
            { type: "winner_of", match_id: slot.referee_assignment.match_id },
            teamNames,
            displayNumbers,
          )
        : participantLabel(slot.referee_assignment.team, teamNames);
    const displayed = displayedTeamPair(
      scheduleParticipantLabel(match.home, teamNames, displayNumbers),
      scheduleParticipantLabel(match.away, teamNames, displayNumbers),
      awayFirstMatchIds.has(row.matchId),
    );
    return {
      ...row,
      homeLabel: displayed.left,
      awayLabel: displayed.right,
      refereeLabel,
    };
  });
}

function metadataRows(
  tournamentName: string,
  scope: ScheduleWorkbookScope,
  savedAtLabel: string,
): WorkbookCell[][] {
  return [
    [textCell("大会名", META_LABEL_STYLE), textCell(tournamentName, META_VALUE_STYLE)],
    [textCell("対象", META_LABEL_STYLE), textCell(scope === "day1" ? "1日目" : "2日目", META_VALUE_STYLE)],
    [textCell("保存日時", META_LABEL_STYLE), textCell(savedAtLabel, META_VALUE_STYLE)],
    [],
  ];
}

function headerRow(labels: readonly string[]): WorkbookCell[] {
  return labels.map((label) => textCell(label, HEADER_STYLE));
}

function scheduleHeaderRow(prefixLabels: readonly string[]): WorkbookCell[] {
  return [
    ...headerRow(prefixLabels),
    textCell("対戦チーム", { ...HEADER_STYLE, columnSpan: 3 }),
    null,
    null,
    textCell("主審", HEADER_STYLE),
  ];
}

function matchupCells(row: PrintPreviewScheduleRow): WorkbookCell[] {
  return [
    textCell(row.homeLabel, {
      ...MATCHUP_STYLE,
      leftBorderColor: MATCHUP_BORDER_COLOR,
      leftBorderStyle: "thin",
      align: "left",
    }),
    textCell("-", { ...MATCHUP_STYLE, align: "center", wrap: false }),
    textCell(row.awayLabel, {
      ...MATCHUP_STYLE,
      rightBorderColor: MATCHUP_BORDER_COLOR,
      rightBorderStyle: "thin",
      align: "right",
    }),
  ];
}

function scheduleDataRow(row: PrintPreviewScheduleRow): WorkbookCell[] {
  return [
    numberCell(row.sectionNo, { ...DATA_STYLE, align: "center" }),
    textCell(row.startTimeLabel, { ...DATA_STYLE, align: "center" }),
    textCell(row.courtName, { ...DATA_STYLE, align: "center" }),
    textCell(row.displayNumber, { ...DATA_STYLE, align: "center" }),
    ...matchupCells(row),
    textCell(row.refereeLabel, { ...DATA_STYLE, align: "center" }),
  ];
}

function participantMatchesSelf(
  participant: PrintParticipant,
  route: PrintPreviewRoute,
): boolean {
  if (route.resolvedTeamId !== undefined && participant.type === "concrete_team") {
    return participant.team_id === route.resolvedTeamId;
  }
  return participantKey(participant) === participantKey(route.participant);
}

function routeOpponent(
  route: PrintPreviewRoute,
  match: PrintPreviewMatch,
  teamNames: ReadonlyMap<string, string>,
): string {
  if (route.role === "referee") return "";
  if (participantMatchesSelf(match.home, route)) return participantLabel(match.away, teamNames);
  if (participantMatchesSelf(match.away, route)) return participantLabel(match.home, teamNames);
  return "前の試合結果で決定";
}

function teamScheduleGroups(
  fixture: PrintPreviewFixture,
  rows: readonly PrintPreviewScheduleRow[],
): TeamScheduleGroup[] {
  const teamNames = new Map(fixture.teams.map((team) => [team.id, team.name]));
  const rowByMatchId = new Map(rows.map((row) => [row.matchId, row]));
  const matchById = new Map(fixture.matches.map((match) => [match.id, match]));
  const courtOrder = new Map(fixture.courts.map((court, index) => [court.id, index]));
  const groups = new Map<string, TeamScheduleGroup>();
  const ensureGroup = (key: string, label: string): TeamScheduleGroup => {
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const group = { key, label, entries: [] };
    groups.set(key, group);
    return group;
  };
  const append = (
    key: string,
    label: string,
    row: PrintPreviewScheduleRow,
    role: "試合" | "審判",
    opponent: string,
  ): void => {
    ensureGroup(key, label).entries.push({
      sectionNo: row.sectionNo,
      courtId: row.courtId,
      startTime: row.startTimeLabel,
      courtName: row.courtName,
      role,
      opponent,
      displayNumber: row.displayNumber,
    });
  };

  if ((fixture.routes?.length ?? 0) > 0) {
    for (const route of fixture.routes ?? []) {
      const row = rowByMatchId.get(route.match_id);
      const match = matchById.get(route.match_id);
      if (row === undefined || match === undefined) {
        throw new ScheduleWorkbookError("チーム別予定が日程にない試合を参照しています。");
      }
      if (row.sectionNo !== route.section_no || row.courtId !== route.court_id) {
        throw new ScheduleWorkbookError("チーム別予定のセクションまたはコートが日程と一致しません。");
      }
      const key = route.resolvedTeamId === undefined
        ? participantKey(route.participant)
        : `team:${route.resolvedTeamId}`;
      const label = route.resolvedTeamId === undefined
        ? participantLabel(route.participant, teamNames)
        : (teamNames.get(route.resolvedTeamId) ?? route.resolvedTeamId);
      append(
        key,
        label,
        row,
        route.role === "match" ? "試合" : "審判",
        routeOpponent(route, match, teamNames),
      );
    }
  } else {
    for (const team of fixture.teams) ensureGroup(`team:${team.id}`, team.name);
    const slotByMatchId = new Map(
      fixture.slots
        .filter((slot): slot is typeof slot & { match_id: string } => slot.match_id !== null)
        .map((slot) => [slot.match_id, slot]),
    );
    for (const row of rows) {
      const match = matchById.get(row.matchId);
      const slot = slotByMatchId.get(row.matchId);
      if (match === undefined || slot === undefined) continue;
      for (const [participant, opponent] of [
        [match.home, participantLabel(match.away, teamNames)],
        [match.away, participantLabel(match.home, teamNames)],
      ] as const) {
        if (participant.type === "winner_of" || participant.type === "loser_of") continue;
        append(
          participantKey(participant),
          participantLabel(participant, teamNames),
          row,
          "試合",
          opponent,
        );
      }
      if (slot.referee_assignment.kind === "team") {
        const referee = slot.referee_assignment.team;
        if (referee.type !== "winner_of" && referee.type !== "loser_of") {
          append(
            participantKey(referee),
            participantLabel(referee, teamNames),
            row,
            "審判",
            "",
          );
        }
      }
    }
  }

  const registeredOrder = new Map(fixture.teams.map((team, index) => [`team:${team.id}`, index]));
  const ordered = [...groups.values()]
    .filter((group) => group.entries.length > 0)
    .sort((left, right) => {
      const leftIndex = registeredOrder.get(left.key);
      const rightIndex = registeredOrder.get(right.key);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return 0;
    });
  for (const group of ordered) {
    group.entries.sort((left, right) =>
      left.sectionNo - right.sectionNo
      || (courtOrder.get(left.courtId) ?? Number.MAX_SAFE_INTEGER)
        - (courtOrder.get(right.courtId) ?? Number.MAX_SAFE_INTEGER)
      || left.displayNumber.localeCompare(right.displayNumber, "ja")
      || left.role.localeCompare(right.role, "ja")
    );
  }
  return ordered;
}

function timeSheet(
  rows: readonly PrintPreviewScheduleRow[],
  metadata: readonly WorkbookCell[][],
): WorkbookSheet {
  return {
    name: "時間順日程表",
    columns: [8, 12, 16, 10, 23, 3, 23, 32].map((width) => ({ width })),
    rows: [
      ...metadata,
      scheduleHeaderRow(["", "開始時刻", "コート", "試合番号"]),
      ...rows.map(scheduleDataRow),
    ],
  };
}

function courtSheet(
  fixture: PrintPreviewFixture,
  rows: readonly PrintPreviewScheduleRow[],
  metadata: readonly WorkbookCell[][],
): WorkbookSheet {
  const rowsByCourt = new Map(fixture.courts.map((court) => [court.id, [] as PrintPreviewScheduleRow[]]));
  for (const row of rows) rowsByCourt.get(row.courtId)?.push(row);
  const output: WorkbookCell[][] = [...metadata];
  for (const court of fixture.courts) {
    output.push([textCell(court.name, GROUP_STYLE)]);
    output.push(scheduleHeaderRow(["", "開始時刻", "試合番号"]));
    for (const row of rowsByCourt.get(court.id) ?? []) {
      const full = scheduleDataRow(row);
      output.push([full[0]!, full[1]!, full[3]!, full[4]!, full[5]!, full[6]!, full[7]!]);
    }
    output.push([]);
  }
  return {
    name: "コート別日程表",
    columns: [8, 12, 10, 23, 3, 23, 32].map((width) => ({ width })),
    rows: output,
  };
}

function teamSheet(
  groups: readonly TeamScheduleGroup[],
  metadata: readonly WorkbookCell[][],
): WorkbookSheet {
  const output: WorkbookCell[][] = [...metadata];
  for (const group of groups) {
    output.push([textCell(group.label, GROUP_STYLE)]);
    output.push(headerRow(["開始時刻", "コート", "役割", "対戦チーム", "試合番号"]));
    for (const entry of group.entries) {
      output.push([
        textCell(entry.startTime, { ...DATA_STYLE, align: "center" }),
        textCell(entry.courtName, DATA_STYLE),
        textCell(entry.role, { ...DATA_STYLE, align: "center" }),
        textCell(entry.opponent, { ...DATA_STYLE, align: "center" }),
        textCell(entry.displayNumber, { ...DATA_STYLE, align: "center" }),
      ]);
    }
    output.push([]);
  }
  return {
    name: "チーム別予定",
    columns: [12, 16, 10, 44, 12].map((width) => ({ width })),
    rows: output,
  };
}

export function buildScheduleWorkbook(
  document: TournamentDocument,
  scope: ScheduleWorkbookScope,
): WorkbookFile {
  let fixture;
  let preview;
  try {
    fixture = buildProductionPrintFixture(document, scope);
    preview = buildPrintPreviewModel(fixture);
  } catch (error) {
    throw new ScheduleWorkbookError(
      `Excelへ出力できる日程を確認できませんでした。${error instanceof Error ? error.message : "保存内容を確認してください。"}`,
    );
  }
  const metadata = metadataRows(preview.tournamentName, scope, preview.savedAtLabel);
  const scheduleRows = workbookScheduleRows(fixture, preview.scheduleRows);
  const sheetNames = uniqueSheetNames(["時間順日程表", "コート別日程表", "チーム別予定"]);
  const sheets = [
    timeSheet(scheduleRows, metadata),
    courtSheet(fixture, scheduleRows, metadata),
    teamSheet(teamScheduleGroups(fixture, scheduleRows), metadata),
  ].map((sheet, index) => ({ ...sheet, name: sheetNames[index]! }));
  return {
    fileName: sanitizeWorkbookFileName(
      `${preview.tournamentName}_${scope === "day1" ? "1日目" : "2日目"}_日程表.xlsx`,
    ),
    sheets,
  };
}
