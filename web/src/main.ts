import { registerSW } from "virtual:pwa-register";

import { generateSchedule, ScheduleApiError } from "./api";
import {
  ImportValidationError,
  parseTournamentJson,
  safeFileName,
  serializeTournamentJson,
} from "./import-export";
import { AutosaveController, TournamentStorage } from "./storage";
import {
  cloneDocument,
  createTournamentDocument,
  type JsonObject,
  type TournamentDocument,
} from "./types";
import "./style.css";

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          action: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
        },
      ) => string;
      reset: (widgetId: string) => void;
    };
  }
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("画面を初期化できませんでした。");

root.innerHTML = `
  <header class="site-header no-print">
    <div>
      <p class="eyebrow">地域大会の運営を、ひとつずつ</p>
      <h1>大会日程スケジューラー</h1>
    </div>
    <div class="connection" id="connection" role="status" aria-live="polite"></div>
  </header>
  <main>
    <nav class="steps no-print" aria-label="作成手順">
      <span class="step active"><b>1</b> 大会</span>
      <span class="step"><b>2</b> チーム・会場</span>
      <span class="step"><b>3</b> 日程生成</span>
      <span class="step"><b>4</b> 確認・印刷</span>
    </nav>

    <section class="panel no-print" aria-labelledby="tournament-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">手順 1–2</p>
          <h2 id="tournament-heading">大会の基本情報</h2>
          <p>入力内容はこの端末へ自動保存されます。</p>
        </div>
        <span class="save-state" id="save-state" role="status">読み込み中…</span>
      </div>
      <div class="form-grid">
        <label class="field field-wide">
          <span>大会名 <em>必須</em></span>
          <input id="tournament-name" autocomplete="organization-title" placeholder="例：○○地区 夏季サッカー大会" maxlength="200" />
        </label>
        <label class="field">
          <span>参加チーム <small>1行に1チーム</small></span>
          <textarea id="teams" rows="8" placeholder="例：&#10;青空FC&#10;みどりSC&#10;中央キッカーズ"></textarea>
          <small id="team-count">0 / 32チーム</small>
        </label>
        <label class="field">
          <span>使用コート <small>1行に1コート</small></span>
          <textarea id="courts" rows="8" placeholder="例：&#10;Aコート&#10;Bコート"></textarea>
          <small id="court-count">0 / 16コート</small>
        </label>
      </div>
      <div class="notice" role="note">
        大会規則の詳細入力画面は段階的に実装中です。以前に書き出した完全な大会データを読み込んだ場合は、生成APIを利用できます。
      </div>
    </section>

    <section class="panel no-print" aria-labelledby="generate-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">手順 3</p>
          <h2 id="generate-heading">日程を生成</h2>
          <p>安全確認後、最大30秒で結果を表示します。通信中も入力は失われません。</p>
        </div>
      </div>
      <div id="turnstile-widget" class="turnstile-box" aria-label="安全確認">安全確認を読み込んでいます…</div>
      <button id="generate" class="primary" type="button" disabled>日程を生成する</button>
      <p id="generation-status" class="status-message" role="status" aria-live="polite"></p>
    </section>

    <section class="panel results" aria-labelledby="results-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">手順 4</p>
          <h2 id="results-heading">保存済みの結果</h2>
          <p id="result-summary">まだ生成結果はありません。</p>
        </div>
        <button id="print" class="secondary no-print" type="button" disabled>印刷する</button>
      </div>
      <div id="result-content" class="result-content empty">
        日程を生成すると、試合数や終了予定などをここで確認できます。
      </div>
    </section>

    <section class="panel no-print" aria-labelledby="backup-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">バックアップ</p>
          <h2 id="backup-heading">保存・復元</h2>
          <p>JSONファイルを大会関係者へ渡すと、別の端末でも復元できます。</p>
        </div>
      </div>
      <div class="button-row">
        <button id="confirm-save" class="secondary" type="button">現在の内容を確定</button>
        <button id="export" class="secondary" type="button">ファイルへ保存</button>
        <label class="secondary file-button">
          ファイルから復元
          <input id="import" type="file" accept="application/json,.json" />
        </label>
        <button id="restore" class="text-button" type="button">ひとつ前の状態へ戻す</button>
        <button id="delete" class="danger" type="button">この端末から削除</button>
      </div>
      <p id="backup-status" class="status-message" role="status" aria-live="polite"></p>
    </section>
  </main>
  <footer class="no-print">大会データはこの端末だけに保存されます。定期的にファイルへ保存してください。</footer>
`;

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`画面要素 ${selector} が見つかりません。`);
  return element;
}

const storage = new TournamentStorage();
const autosave = new AutosaveController((value) => storage.saveDraft(value));
let documentState = createTournamentDocument();
let turnstileToken = "";
let turnstileWidgetId: string | undefined;
let generationStatusOwner: "turnstile" | "generation" = "turnstile";

const nameInput = requiredElement<HTMLInputElement>("#tournament-name");
const teamsInput = requiredElement<HTMLTextAreaElement>("#teams");
const courtsInput = requiredElement<HTMLTextAreaElement>("#courts");
const saveState = requiredElement<HTMLElement>("#save-state");
const backupStatus = requiredElement<HTMLElement>("#backup-status");
const generationStatus = requiredElement<HTMLElement>("#generation-status");
const generateButton = requiredElement<HTMLButtonElement>("#generate");
const printButton = requiredElement<HTMLButtonElement>("#print");

type TurnstileApi = NonNullable<Window["turnstile"]>;

function turnstileApi(): TurnstileApi | undefined {
  const candidate = window.turnstile;
  return candidate !== undefined &&
    typeof candidate.render === "function" &&
    typeof candidate.reset === "function"
    ? candidate
    : undefined;
}

function requireTurnstileConfirmation(message: string): void {
  turnstileToken = "";
  generateButton.disabled = true;
  generationStatusOwner = "turnstile";
  generationStatus.textContent = message;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function asObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function namesFromInput(field: "teams" | "courts"): string[] {
  return asObjectArray(documentState.tournament.input[field]).map((item) =>
    typeof item.name === "string" ? item.name : typeof item.id === "string" ? item.id : "名称未設定",
  );
}

function appendTextElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = window.document.createElement(tagName);
  element.textContent = text;
  if (className !== undefined) element.className = className;
  parent.append(element);
  return element;
}

function idNameMap(field: "teams" | "courts"): Map<string, string> {
  return new Map(
    asObjectArray(documentState.tournament.input[field])
      .filter((item) => typeof item.id === "string")
      .map((item) => [
        item.id as string,
        typeof item.name === "string" ? item.name : "名称未設定",
      ]),
  );
}

function exactTeamId(match: JsonObject | undefined, side: "home" | "away"): string | undefined {
  if (match === undefined) return undefined;
  const direct = match[`${side}_team_id`];
  if (typeof direct === "string") return direct;
  const possible = match[`possible_${side}_team_ids`];
  return Array.isArray(possible) && possible.length === 1 && typeof possible[0] === "string"
    ? possible[0]
    : undefined;
}

function sectionLabel(sectionNumber: number): string {
  const day = documentState.tournament.input.day;
  if (typeof day !== "object" || day === null || Array.isArray(day)) return `第${sectionNumber}`;
  const settings = day as JsonObject;
  if (
    typeof settings.start_time !== "string" ||
    typeof settings.game_duration_minutes !== "number" ||
    typeof settings.margin_minutes !== "number"
  ) {
    return `第${sectionNumber}`;
  }
  const [hoursText, minutesText] = settings.start_time.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return `第${sectionNumber}`;
  const totalMinutes =
    hours * 60 +
    minutes +
    (sectionNumber - 1) * (settings.game_duration_minutes + settings.margin_minutes);
  const time = `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  return `第${sectionNumber}・${time}`;
}

function renderResult(): void {
  const summary = requiredElement<HTMLElement>("#result-summary");
  const content = requiredElement<HTMLElement>("#result-content");

  const result = documentState.tournament.result;
  if (result === undefined) {
    summary.textContent = "まだ生成結果はありません。";
    content.textContent = "日程を生成すると、試合数や終了予定などをここで確認できます。";
    content.classList.add("empty");
    printButton.disabled = true;
    return;
  }

  const slots = asObjectArray(result.slots)
    .filter((slot) => typeof slot.match_id === "string")
    .sort(
      (left, right) =>
        Number(left.section_no) - Number(right.section_no) ||
        String(left.court_id).localeCompare(String(right.court_id), "ja"),
    );
  const teamNames = idNameMap("teams");
  const courtNames = idNameMap("courts");
  const matches = new Map(
    asObjectArray(documentState.tournament.input.matches)
      .filter((match) => typeof match.id === "string")
      .map((match) => [match.id as string, match]),
  );
  const status = typeof result.status === "string" ? result.status : "完了";
  summary.textContent = `生成状態：${status}／配置済み ${slots.length}試合`;
  content.replaceChildren();
  content.classList.remove("empty");

  const overview = window.document.createElement("dl");
  const overviewItems: Array<readonly [string, string]> = [
    ["大会名", documentState.tournament.name || "名称未設定"],
    ["参加チーム", `${teamNames.size}チーム`],
    ["配置済み試合", `${slots.length}試合`],
    ["保存日時", new Date(documentState.updatedAt).toLocaleString("ja-JP")],
  ];
  for (const [label, value] of overviewItems) {
    const wrapper = window.document.createElement("div");
    appendTextElement(wrapper, "dt", label);
    appendTextElement(wrapper, "dd", value);
    overview.append(wrapper);
  }
  content.append(overview);
  const validation = result.validation;
  if (
    typeof validation === "object" &&
    validation !== null &&
    !Array.isArray(validation) &&
    (validation as JsonObject).valid === true
  ) {
    appendTextElement(content, "p", "大会規則の独立チェックに合格しています。", "validation-ok");
  }

  appendTextElement(content, "h3", "日程表");
  const tableWrapper = window.document.createElement("div");
  tableWrapper.className = "table-wrap";
  const table = window.document.createElement("table");
  const head = window.document.createElement("thead");
  const headingRow = window.document.createElement("tr");
  for (const heading of ["時間", "コート", "対戦", "審判"]) {
    appendTextElement(headingRow, "th", heading);
  }
  head.append(headingRow);
  table.append(head);
  const body = window.document.createElement("tbody");
  const teamSchedules = new Map<string, string[]>();
  for (const teamId of teamNames.keys()) teamSchedules.set(teamId, []);

  for (const slot of slots) {
    const match = matches.get(String(slot.match_id));
    const homeId = exactTeamId(match, "home");
    const awayId = exactTeamId(match, "away");
    const homeName = homeId === undefined ? "前の試合結果で決定" : (teamNames.get(homeId) ?? "名称未設定");
    const awayName = awayId === undefined ? "前の試合結果で決定" : (teamNames.get(awayId) ?? "名称未設定");
    const courtName = courtNames.get(String(slot.court_id)) ?? "コート未設定";
    const sectionNumber = Number(slot.section_no);
    const row = window.document.createElement("tr");
    appendTextElement(row, "td", sectionLabel(sectionNumber));
    appendTextElement(row, "td", courtName);
    appendTextElement(row, "td", `${homeName} 対 ${awayName}`);
    const assignment =
      typeof slot.referee_assignment === "object" &&
      slot.referee_assignment !== null &&
      !Array.isArray(slot.referee_assignment)
        ? (slot.referee_assignment as JsonObject)
        : undefined;
    const kind = assignment?.kind ?? assignment?.type;
    const refereeTeamId = typeof assignment?.team_id === "string" ? assignment.team_id : undefined;
    const refereeName =
      kind === "organizer"
        ? "主催者"
        : refereeTeamId === undefined
          ? "確認中"
          : (teamNames.get(refereeTeamId) ?? "名称未設定");
    appendTextElement(row, "td", refereeName);
    body.append(row);

    if (homeId !== undefined) {
      teamSchedules.get(homeId)?.push(`${sectionLabel(sectionNumber)}　${courtName}　対 ${awayName}`);
    }
    if (awayId !== undefined) {
      teamSchedules.get(awayId)?.push(`${sectionLabel(sectionNumber)}　${courtName}　対 ${homeName}`);
    }
    if (refereeTeamId !== undefined) {
      teamSchedules
        .get(refereeTeamId)
        ?.push(`${sectionLabel(sectionNumber)}　${courtName}　審判`);
    }
  }
  table.append(body);
  tableWrapper.append(table);
  content.append(tableWrapper);

  appendTextElement(content, "h3", "チーム別予定");
  const teamGrid = window.document.createElement("div");
  teamGrid.className = "team-schedule-grid";
  for (const [teamId, teamName] of teamNames) {
    const card = window.document.createElement("section");
    card.className = "team-card";
    appendTextElement(card, "h4", teamName);
    const schedule = teamSchedules.get(teamId) ?? [];
    if (schedule.length === 0) {
      appendTextElement(card, "p", "確定済みの予定はありません。", "muted");
    } else {
      const list = window.document.createElement("ul");
      for (const item of schedule) appendTextElement(list, "li", item);
      card.append(list);
    }
    teamGrid.append(card);
  }
  content.append(teamGrid);
  printButton.disabled = false;
}

function render(): void {
  nameInput.value = documentState.tournament.name;
  teamsInput.value = namesFromInput("teams").join("\n");
  courtsInput.value = namesFromInput("courts").join("\n");
  requiredElement<HTMLElement>("#team-count").textContent = `${lines(teamsInput.value).length} / 32チーム`;
  requiredElement<HTMLElement>("#court-count").textContent = `${lines(courtsInput.value).length} / 16コート`;
  renderResult();
}

function updateDraft(): void {
  const teamNames = lines(teamsInput.value).slice(0, 32);
  const courtNames = lines(courtsInput.value).slice(0, 16);
  const previousInput = documentState.tournament.input;
  documentState = {
    ...cloneDocument(documentState),
    updatedAt: new Date().toISOString(),
    tournament: {
      name: nameInput.value.trim(),
      input: {
        ...previousInput,
        teams: teamNames.map((name, index) => ({ id: `team-${String(index + 1).padStart(2, "0")}`, name })),
        courts: courtNames.map((name, index) => ({ id: `court-${String(index + 1).padStart(2, "0")}`, name })),
      },
      result: documentState.tournament.result,
    },
  };
  requiredElement<HTMLElement>("#team-count").textContent = `${teamNames.length} / 32チーム`;
  requiredElement<HTMLElement>("#court-count").textContent = `${courtNames.length} / 16コート`;
  saveState.textContent = "保存しています…";
  autosave.schedule(
    documentState,
    () => {
      saveState.textContent = "この端末に保存済み";
    },
    () => {
      saveState.textContent = "保存できませんでした";
      backupStatus.textContent = "端末の保存容量を確認し、ファイルへ保存してください。";
    },
  );
}

nameInput.addEventListener("input", updateDraft);
for (const input of [teamsInput, courtsInput]) {
  input.addEventListener("input", () => {
    documentState.tournament.result = undefined;
    renderResult();
    generationStatus.textContent = "チームまたはコートを変更したため、以前の生成結果を取り消しました。";
    updateDraft();
  });
}

requiredElement<HTMLButtonElement>("#confirm-save").addEventListener("click", () => {
  updateDraft();
  autosave.cancel();
  void storage
    .confirm(documentState)
    .then(() => {
      saveState.textContent = "現在の内容を確定しました";
      backupStatus.textContent = "次に確定すると、今回の状態をひとつ前の状態として残します。";
    })
    .catch(() => {
      backupStatus.textContent = "確定保存できませんでした。ファイルへ保存してください。";
    });
});

requiredElement<HTMLButtonElement>("#export").addEventListener("click", () => {
  updateDraft();
  const blob = new Blob([serializeTournamentJson(documentState)], { type: "application/json" });
  const link = window.document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = safeFileName(documentState.tournament.name);
  link.click();
  URL.revokeObjectURL(link.href);
  backupStatus.textContent = "ファイルへ保存しました。保存先を確認してください。";
});

requiredElement<HTMLInputElement>("#import").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  void file
    .text()
    .then((text) => {
      const imported = parseTournamentJson(text);
      const teams = asObjectArray(imported.tournament.input.teams).length;
      const matches = asObjectArray(imported.tournament.input.matches).length;
      const confirmed = window.confirm(
        `「${imported.tournament.name}」を読み込みます。\nチーム：${teams}／試合：${matches}\n\n現在の内容はひとつ前の状態として残ります。よろしいですか？`,
      );
      if (!confirmed) {
        backupStatus.textContent = "読み込みを取り消しました。現在の内容は変わっていません。";
        return;
      }
      autosave.cancel();
      documentState = imported;
      return storage.replaceImported(imported).then(() => {
        render();
        backupStatus.textContent = "ファイルから復元しました。内容を確認してください。";
      });
    })
    .catch((error: unknown) => {
      backupStatus.textContent =
        error instanceof ImportValidationError
          ? error.message
          : "ファイルを読み込めませんでした。端末の空き容量とファイルを確認してください。";
    })
    .finally(() => {
      input.value = "";
    });
});

requiredElement<HTMLButtonElement>("#restore").addEventListener("click", () => {
  if (!window.confirm("現在の内容を、ひとつ前に確定した状態へ戻しますか？")) return;
  autosave.cancel();
  void storage.restorePrevious().then((previous) => {
    if (previous === undefined) {
      backupStatus.textContent = "戻せる状態がありません。";
      return;
    }
    documentState = previous;
    render();
    backupStatus.textContent = "ひとつ前の状態へ戻しました。";
  });
});

requiredElement<HTMLButtonElement>("#delete").addEventListener("click", () => {
  if (!window.confirm("この端末に保存した現在の大会データを削除しますか？\n削除後も「ひとつ前の状態へ戻す」で一度だけ元に戻せます。")) return;
  autosave.cancel();
  void storage.deleteCurrent().then(() => {
    documentState = createTournamentDocument();
    render();
    backupStatus.textContent = "現在のデータを削除しました。「ひとつ前の状態へ戻す」で取り消せます。";
  });
});

generateButton.addEventListener("click", () => {
  if (turnstileToken.length === 0) {
    requireTurnstileConfirmation("安全確認を完了してから日程を生成してください。");
    return;
  }
  updateDraft();
  generateButton.disabled = true;
  generationStatusOwner = "generation";
  generationStatus.textContent = "日程を生成しています。画面を閉じずにお待ちください…";
  void generateSchedule(documentState.tournament.input, turnstileToken)
    .then((result) => {
      documentState = {
        ...documentState,
        updatedAt: new Date().toISOString(),
        tournament: { ...documentState.tournament, result },
      };
      autosave.cancel();
      return storage.confirm(documentState).then(() => {
        generationStatus.textContent = "日程を生成し、この端末へ保存しました。";
        render();
      });
    })
    .catch((error: unknown) => {
      generationStatus.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "日程を生成できませんでした。入力は保存されています。もう一度お試しください。";
    })
    .finally(() => {
      turnstileToken = "";
      generateButton.disabled = true;
      const api = turnstileApi();
      if (turnstileWidgetId === undefined || api === undefined) {
        requireTurnstileConfirmation(
          "安全確認を再開できませんでした。画面を再読み込みしてください。",
        );
        return;
      }
      try {
        api.reset(turnstileWidgetId);
      } catch {
        requireTurnstileConfirmation(
          "安全確認を再開できませんでした。画面を再読み込みしてください。",
        );
      }
    });
});

printButton.addEventListener("click", () => window.print());

function updateConnectionStatus(): void {
  const connection = requiredElement<HTMLElement>("#connection");
  if (navigator.onLine) {
    connection.textContent = "オンライン：日程を生成できます";
    connection.className = "connection online";
  } else {
    connection.textContent = "オフライン：保存済みの内容を確認できます";
    connection.className = "connection offline";
  }
}
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();

function setupTurnstile(): void {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#turnstile-widget");
  generateButton.disabled = true;
  if (!siteKey) {
    container.textContent = "安全確認の設定が完了していないため、現在は日程を生成できません。";
    requireTurnstileConfirmation(
      "安全確認の設定が完了していないため、現在は日程を生成できません。",
    );
    return;
  }
  const script = window.document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  script.addEventListener("load", () => {
    const api = turnstileApi();
    if (api === undefined) {
      container.textContent =
        "安全確認を初期化できませんでした。画面を再読み込みしてください。";
      requireTurnstileConfirmation(
        "安全確認を初期化できませんでした。画面を再読み込みしてください。",
      );
      return;
    }
    try {
      container.replaceChildren();
      turnstileWidgetId = api.render(container, {
        sitekey: siteKey,
        action: "generate_schedule",
        callback: (token) => {
          if (token.length === 0) {
            requireTurnstileConfirmation(
              "安全確認を完了できませんでした。もう一度お試しください。",
            );
            return;
          }
          turnstileToken = token;
          generateButton.disabled = false;
          if (generationStatusOwner === "turnstile") {
            generationStatus.textContent = "安全確認が完了しました。";
          }
        },
        "expired-callback": () => {
          requireTurnstileConfirmation(
            "安全確認の期限が切れました。もう一度確認してください。",
          );
        },
        "error-callback": () => {
          requireTurnstileConfirmation(
            "安全確認を完了できませんでした。通信状態を確認してください。",
          );
        },
      });
    } catch {
      container.textContent =
        "安全確認を初期化できませんでした。画面を再読み込みしてください。";
      requireTurnstileConfirmation(
        "安全確認を初期化できませんでした。画面を再読み込みしてください。",
      );
    }
  });
  script.addEventListener("error", () => {
    container.textContent = "安全確認を読み込めませんでした。通信状態を確認してください。";
    requireTurnstileConfirmation(
      "安全確認を読み込めませんでした。通信状態を確認してください。",
    );
  });
  window.document.head.append(script);
}

registerSW({
  onNeedRefresh() {
    if (window.confirm("新しい版を利用できます。入力を保存して画面を更新しますか？")) {
      window.location.reload();
    }
  },
  onOfflineReady() {
    backupStatus.textContent = "オフラインでも保存済みの内容を確認できる準備が整いました。";
  },
});

void storage
  .loadLatest()
  .then((saved) => {
    documentState = saved ?? createTournamentDocument();
    render();
    saveState.textContent = saved === undefined ? "新しい大会" : "この端末の保存内容を復元しました";
  })
  .catch(() => {
    render();
    saveState.textContent = "保存内容を読み込めませんでした";
    backupStatus.textContent = "JSONファイルのバックアップがある場合は「ファイルから復元」をお試しください。";
  });
setupTurnstile();
