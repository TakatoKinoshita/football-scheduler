import {
  buildTournamentBracketModel,
  type TournamentBracketScheduleDetails,
} from "./tournament-bracket";
import {
  tournamentBracketPreviewFixture,
  tournamentBracketPreviewFixtures,
} from "./tournament-bracket-preview-fixtures";
import {
  tournamentBracketPreviewLayout,
  tournamentBracketPreviewLayouts,
  tournamentBracketPreviewRenderer,
} from "./tournament-bracket-preview-layouts";
import "./style.css";
import "./tournament-bracket-preview.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`プレビュー要素「${selector}」が見つかりません。`);
  return element;
}

interface DummyScheduleMatch {
  id: string;
  roundNo: number;
  rangeStart: number;
  inputIndex: number;
}

function circledNumber(value: number): string {
  return value <= 20 ? String.fromCodePoint(0x245f + value) : `(${String(value)})`;
}

function timeLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function dummyScheduleByMatchId(
  plan: unknown,
): ReadonlyMap<string, TournamentBracketScheduleDetails> {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return new Map();
  const upper = (plan as Record<string, unknown>).upper;
  if (typeof upper !== "object" || upper === null || Array.isArray(upper)) return new Map();
  const rawMatches = (upper as Record<string, unknown>).matches;
  if (!Array.isArray(rawMatches)) return new Map();
  const matches: DummyScheduleMatch[] = rawMatches.flatMap((raw, inputIndex) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const match = raw as Record<string, unknown>;
    const range = Array.isArray(match.rank_range) ? match.rank_range : [];
    if (
      typeof match.id !== "string" ||
      typeof match.round_no !== "number" ||
      typeof range[0] !== "number"
    ) {
      return [];
    }
    return [{
      id: match.id,
      roundNo: match.round_no,
      rangeStart: range[0],
      inputIndex,
    }];
  });
  const courts = ["A", "B", "C"] as const;
  const gameCountByCourt = new Map(courts.map((court) => [court, 0]));
  const result = new Map<string, TournamentBracketScheduleDetails>();
  let sectionOffset = 0;
  const roundNumbers = [...new Set(matches.map((match) => match.roundNo))]
    .sort((left, right) => left - right);
  for (const roundNo of roundNumbers) {
    const roundMatches = matches
      .filter((match) => match.roundNo === roundNo)
      .sort(
        (left, right) =>
          right.rangeStart - left.rangeStart ||
          left.inputIndex - right.inputIndex ||
          left.id.localeCompare(right.id),
      );
    roundMatches.forEach((match, index) => {
      const court = courts[index % courts.length]!;
      const gameNumber = (gameCountByCourt.get(court) ?? 0) + 1;
      gameCountByCourt.set(court, gameNumber);
      const section = sectionOffset + Math.floor(index / courts.length);
      result.set(match.id, {
        displayNumber: `${court}${circledNumber(gameNumber)}`,
        timeLabel: timeLabel(9 * 60 + section * 45),
        courtName: `${court}コート`,
      });
    });
    sectionOffset += Math.ceil(roundMatches.length / courts.length);
  }
  return result;
}

const fixtureSelect = requiredElement<HTMLSelectElement>("#preview-fixture");
const layoutSelect = requiredElement<HTMLSelectElement>("#preview-layout");
const status = requiredElement<HTMLOutputElement>("#preview-status");
const heading = requiredElement<HTMLHeadingElement>("#preview-heading");
const description = requiredElement<HTMLParagraphElement>("#preview-description");
const output = requiredElement<HTMLDivElement>("#preview-output");
const controls = requiredElement<HTMLFormElement>("#preview-controls");

for (const fixture of tournamentBracketPreviewFixtures) {
  const option = document.createElement("option");
  option.value = fixture.id;
  option.textContent = fixture.description;
  fixtureSelect.append(option);
}
for (const name of Object.keys(tournamentBracketPreviewLayouts)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  layoutSelect.append(option);
}

const parameters = new URLSearchParams(window.location.search);
fixtureSelect.value = parameters.get("fixture") ?? tournamentBracketPreviewFixtures[0]?.id ?? "";
layoutSelect.value = parameters.get("layout") ?? "standard";

function renderPreview(): void {
  document.body.dataset.previewReady = "false";
  output.replaceChildren();
  const fixture = tournamentBracketPreviewFixture(fixtureSelect.value);
  const layout = tournamentBracketPreviewLayout(layoutSelect.value);
  const renderer = tournamentBracketPreviewRenderer(layoutSelect.value);
  if (fixture === undefined || layout === undefined || renderer === undefined) {
    const message = document.createElement("p");
    message.className = "preview-error";
    message.textContent = "指定されたfixtureまたはレイアウトを読み取れませんでした。";
    output.append(message);
    status.textContent = "生成失敗";
    document.body.dataset.previewReady = "true";
    return;
  }
  try {
    const model = buildTournamentBracketModel(
      {
        plan: fixture.tournamentPlan,
        pool: "upper",
        teamNames: new Map(fixture.teams.map((team) => [team.id, team.name])),
        scheduleByMatchId: dummyScheduleByMatchId(fixture.tournamentPlan),
      },
      layout,
    );
    const figure = renderer(model, "上位トーナメント表");
    heading.textContent = `${fixture.description} / ${layout.id}`;
    description.textContent = `${String(model.participantCount)}チーム・${String(fixture.expected.upperMatchCount)}試合・下位トーナメントは出力しません。`;
    output.append(figure);
    status.textContent = "生成完了";
    document.body.dataset.previewFixture = fixture.id;
    document.body.dataset.previewLayout = layout.id;
    const nextParameters = new URLSearchParams({ fixture: fixture.id, layout: layout.id });
    window.history.replaceState(null, "", `${window.location.pathname}?${nextParameters.toString()}`);
  } catch (error) {
    const message = document.createElement("p");
    message.className = "preview-error";
    message.textContent = error instanceof Error ? error.message : "プレビューを生成できませんでした。";
    output.append(message);
    status.textContent = "生成失敗";
  } finally {
    document.body.dataset.previewReady = "true";
  }
}

controls.addEventListener("change", renderPreview);
renderPreview();
