import {
  buildTournamentBracketModel,
  renderTournamentBracket,
} from "./tournament-bracket";
import {
  tournamentBracketPreviewFixture,
  tournamentBracketPreviewFixtures,
} from "./tournament-bracket-preview-fixtures";
import {
  tournamentBracketPreviewLayout,
  tournamentBracketPreviewLayouts,
} from "./tournament-bracket-preview-layouts";
import "./style.css";
import "./tournament-bracket-preview.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`プレビュー要素「${selector}」が見つかりません。`);
  return element;
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
  if (fixture === undefined || layout === undefined) {
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
      },
      layout,
    );
    const figure = renderTournamentBracket(model, "上位トーナメント表");
    heading.textContent = `${fixture.description} / ${layout.id}`;
    description.textContent = `${String(model.participantCount)}チーム・${String(model.nodes.length)}試合・下位トーナメントは出力しません。`;
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
