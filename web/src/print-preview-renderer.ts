import { buildTournamentBracketModel } from "./tournament-bracket";
import { selectTournamentBracketPresentation } from "./tournament-bracket-presentations";
import type { PrintPreviewModel } from "./print-preview-model";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function renderMetadata(model: PrintPreviewModel): HTMLElement {
  const section = element("section", undefined, "print-metadata");
  section.dataset.printSection = "metadata";
  const name = element("p", undefined, "print-metadata-item");
  name.append(element("span", "大会名", "print-metadata-label"), element("strong", model.tournamentName));
  const saved = element("p", undefined, "print-metadata-item");
  saved.append(element("span", "保存日時", "print-metadata-label"), document.createTextNode(model.savedAtLabel));
  section.append(name, saved);
  return section;
}

function renderSchedule(model: PrintPreviewModel): HTMLElement {
  const section = element("section", undefined, "print-schedule print-page");
  section.dataset.printSection = "schedule";
  section.append(element("h2", model.scheduleHeading));
  const courts = element("div", undefined, "print-court-list");
  for (const court of model.courtSchedules) {
    const card = element("article", undefined, "print-court-card");
    card.dataset.printCourt = court.courtId;
    card.append(element("h3", court.courtName));
    const table = element("table");
    const head = element("thead");
    const headRow = element("tr");
    for (const label of ["試合", "時刻", "対戦", "審判"]) headRow.append(element("th", label));
    head.append(headRow);
    const body = element("tbody");
    for (const row of court.rows) {
      const tr = element("tr");
      tr.dataset.matchId = row.matchId;
      tr.append(
        element("td", row.displayNumber),
        element("td", row.timeLabel),
        element("td", `${row.homeLabel} 対 ${row.awayLabel}`),
        element("td", row.refereeLabel),
      );
      body.append(tr);
    }
    table.append(head, body);
    card.append(table);
    courts.append(card);
  }
  section.append(courts);
  return section;
}

function renderParticipantSchedules(model: PrintPreviewModel): HTMLElement {
  const section = element("section", undefined, "print-participant-schedules print-page");
  section.dataset.printSection = "team-schedules";
  section.append(element("h2", "チーム別予定"));
  const grid = element("div", undefined, "print-two-column-grid");
  for (const participant of model.participantSchedules) {
    const card = element("article", undefined, "print-team-card");
    card.dataset.participantKey = participant.key;
    card.append(element("h3", participant.label));
    const table = element("table");
    const body = element("tbody");
    for (const entry of participant.entries) {
      const row = element("tr");
      row.append(
        element("td", entry.displayNumber),
        element("td", entry.timeLabel),
        element("td", entry.courtName),
        element("td", entry.role),
      );
      body.append(row);
    }
    table.append(body);
    card.append(table);
    grid.append(card);
  }
  section.append(grid);
  return section;
}

function renderTournamentPools(model: PrintPreviewModel): HTMLElement[] {
  return model.tournamentPools.map((pool, index) => {
    const section = element("section", undefined, "print-tournament-pool print-page");
    section.dataset.printSection = "tournament-pool";
    section.dataset.poolId = pool.poolId;
    section.dataset.poolIndex = String(index + 1);
    section.append(element("h2", pool.heading));
    const input = {
      plan: pool.plan,
      pool: pool.poolId,
      teamNames: model.teamNames,
      scheduleByMatchId: model.scheduleByMatchId,
    };
    const selection = selectTournamentBracketPresentation(input, "horizontal");
    const bracket = buildTournamentBracketModel(input, selection.presentation.layout);
    section.append(selection.presentation.render(bracket, pool.heading));
    return section;
  });
}

function renderTournamentOverview(model: PrintPreviewModel): HTMLElement {
  const overview = model.tournamentOverview;
  if (overview === undefined) throw new Error("2日目の組合せ概要を読み取れませんでした。");
  const section = element("section", undefined, "print-tournament-overview");
  section.dataset.printSection = "tournament-overview";
  section.append(element("h2", "2日目の組合せ概要"));
  const facts = element("dl", undefined, "print-overview-facts");
  for (const [label, value] of [
    ["トーナメント数", `${String(overview.tournamentCount)}組`],
    ["使用コート", `${String(overview.courtCount)}面`],
    ["総試合数", `${String(overview.matchCount)}試合`],
    ["予定時刻", `${overview.startTimeLabel}〜${overview.endTimeLabel}`],
  ]) {
    const item = element("div", undefined, "print-overview-fact");
    item.append(element("dt", label), element("dd", value));
    facts.append(item);
  }
  section.append(facts);
  const pools = element("div", undefined, "print-tournament-summary-grid");
  for (const pool of model.tournamentPools) {
    const card = element("article", undefined, "print-tournament-summary-card");
    card.dataset.summaryPoolId = pool.poolId;
    card.append(element("h3", pool.name));
    card.append(element(
      "p",
      `${pool.rankRangeLabel}・${String(pool.participantCount)}チーム`,
      "print-tournament-summary-meta",
    ));
    const list = element("ol");
    for (const participant of pool.participantEntries) list.append(element("li", participant));
    card.append(list);
    pools.append(card);
  }
  section.append(pools);
  return section;
}

function renderLeagueOverview(model: PrintPreviewModel): HTMLElement {
  const overview = model.leagueOverview;
  if (overview === undefined) throw new Error("リーグ戦の組合せ概要を読み取れませんでした。");
  const dayLabel = model.scope === "day1-league" ? "1日目" : "2日目";
  const section = element("section", undefined, "print-league-overview");
  section.dataset.printSection = "league-overview";
  section.append(element("h2", `${dayLabel}の組合せ概要`));
  const facts = element("dl", undefined, "print-overview-facts");
  for (const [label, value] of [
    [model.scope === "day1-league" ? "ブロック数" : "グループ数", `${String(overview.groupCount)}組`],
    ["使用コート", `${String(overview.courtCount)}面`],
    ["総試合数", `${String(overview.matchCount)}試合`],
    ["予定時刻", `${overview.startTimeLabel}〜${overview.endTimeLabel}`],
  ]) {
    const item = element("div", undefined, "print-overview-fact");
    item.append(element("dt", label), element("dd", value));
    facts.append(item);
  }
  section.append(facts);
  const groups = element("div", undefined, "print-league-summary-grid");
  for (const group of model.groups) {
    const card = element("article", undefined, "print-league-summary-card");
    card.dataset.summaryGroupId = group.id;
    card.append(element("h3", group.name));
    card.append(element("p", `${String(group.members.length)}チーム`, "print-league-summary-meta"));
    const list = element("ol");
    for (const member of group.members) list.append(element("li", member));
    card.append(list);
    groups.append(card);
  }
  section.append(groups);
  return section;
}

export function renderPrintPreview(model: PrintPreviewModel): HTMLElement {
  const main = element("main", undefined, "print-document");
  main.id = "print-preview-output";
  main.dataset.fixtureId = model.fixtureId;
  main.dataset.printScope = model.scope;
  main.dataset.participantResolution = model.participantResolution;
  main.append(renderMetadata(model));
  if (model.scope === "day2-tournament") {
    main.append(renderTournamentOverview(model), ...renderTournamentPools(model), renderSchedule(model));
  } else {
    main.append(renderLeagueOverview(model), renderSchedule(model), renderParticipantSchedules(model));
  }
  return main;
}
