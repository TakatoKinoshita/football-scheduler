import { registerSW } from "virtual:pwa-register";

import {
  calculateLeagueStandings,
  generateSchedule,
  generateTournamentPlan,
  ScheduleApiError,
} from "./api";
import {
  issuesFromApiDetails,
  isDay1LeagueInput,
  normalizeDocument,
  validateDay1LeagueDocument,
  type FieldIssue,
  type WizardStep,
} from "./day1-form";
import {
  ImportValidationError,
  parseTournamentJson,
  safeFileName,
  serializeTournamentJson,
} from "./import-export";
import { setupPwaUpdates } from "./pwa-update";
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
    <div class="scope-notice no-print" role="note">
      <strong>1日目のリーグ日程・ブロック順位から、2日目の組合せまで作成できます。</strong>
      2日目の時刻・コート・審判配置と試合結果入力は、今後追加します。
    </div>
    <div id="legacy-banner" class="notice no-print" role="note" hidden>
      従来形式の大会データを互換モードで開いています。内容を壊さないため大会設定は変更できませんが、日程の再生成と保存・印刷は利用できます。
    </div>

    <nav class="steps no-print" aria-label="作成手順">
      <button class="step" type="button" data-step="1"><b>1</b><span>大会・チーム</span></button>
      <button class="step" type="button" data-step="2"><b>2</b><span>ブロック・会場</span></button>
      <button class="step" type="button" data-step="3"><b>3</b><span>時刻・生成</span></button>
      <button class="step" type="button" data-step="4"><b>4</b><span>確認・印刷</span></button>
    </nav>

    <section class="panel wizard-panel no-print" data-panel="1" aria-labelledby="step1-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">手順 1 / 4</p>
          <h2 id="step1-heading">大会名と参加チーム</h2>
          <p>参加チームは、組合せ抽選に使う順番で1行に1チームずつ入力します。</p>
        </div>
        <span class="save-state" id="save-state" role="status">読み込み中…</span>
      </div>
      <div class="form-grid single-column">
        <label class="field" for="tournament-name">
          <span>大会名 <em>必須</em></span>
          <input id="tournament-name" autocomplete="organization-title" placeholder="例：○○地区 夏季サッカー大会" maxlength="200" />
          <small>印刷物と保存ファイルの名前に使います。</small>
          <span id="tournament-name-error" class="field-error" role="alert"></span>
        </label>
        <label class="field" for="teams">
          <span>参加チーム <em>必須</em> <small>1行に1チーム・2〜32チーム</small></span>
          <textarea id="teams" rows="12" placeholder="例：&#10;青空FC&#10;みどりSC&#10;中央キッカーズ"></textarea>
          <small id="team-count">0 / 32チーム</small>
          <span id="teams-error" class="field-error" role="alert"></span>
        </label>
      </div>
      <div class="wizard-actions">
        <span></span>
        <button id="step1-next" class="primary" type="button">次へ：ブロック・会場</button>
      </div>
    </section>

    <section class="panel wizard-panel no-print" data-panel="2" aria-labelledby="step2-heading" hidden>
      <div class="section-heading">
        <div>
          <p class="section-number">手順 2 / 4</p>
          <h2 id="step2-heading">ブロックと使用コート</h2>
          <p>ブロック数を選び、会場で同時に使えるコートを入力します。</p>
        </div>
      </div>
      <div class="form-grid">
        <label class="field" for="block-count">
          <span>ブロック数 <em>必須</em></span>
          <select id="block-count"><option value="">選択してください</option></select>
          <small>大会要項に記載された数を選んでください。自動決定はしません。</small>
          <span id="block-count-error" class="field-error" role="alert"></span>
        </label>
        <label class="field" for="assignment-mode">
          <span>チームの分け方 <em>必須</em></span>
          <select id="assignment-mode">
            <option value="random">抽選で均等に分ける</option>
            <option value="seeded_snake">入力順をシード順として均等に分ける</option>
          </select>
          <small id="assignment-help">同じ抽選番号なら、同じブロック分けを再現できます。</small>
          <span id="assignment-mode-error" class="field-error" role="alert"></span>
        </label>
        <label class="field" for="odd-split-policy">
          <span>奇数人数ブロックの上下振り分け <em>必須</em></span>
          <select id="odd-split-policy">
            <option value="upper">中央順位を上位へ入れる</option>
            <option value="lower">中央順位を下位へ入れる</option>
            <option value="alternate">ブロック順に上位・下位を交互にする</option>
          </select>
          <small>結果を見る前に大会要項どおり選びます。生成後に変えると結果を取り消します。</small>
          <span id="odd-split-policy-error" class="field-error" role="alert"></span>
        </label>
        <label class="field field-wide" for="courts">
          <span>使用コート <em>必須</em> <small>1行に1コート・1〜16コート</small></span>
          <textarea id="courts" rows="8" placeholder="例：&#10;Aコート&#10;Bコート"></textarea>
          <small id="court-count">0 / 16コート</small>
          <span id="courts-error" class="field-error" role="alert"></span>
        </label>
      </div>
      <div class="wizard-actions">
        <button id="step2-back" class="secondary" type="button">戻る</button>
        <button id="step2-next" class="primary" type="button">次へ：時刻・生成</button>
      </div>
    </section>

    <section class="panel wizard-panel no-print" data-panel="3" aria-labelledby="step3-heading" hidden>
      <div class="section-heading">
        <div>
          <p class="section-number">手順 3 / 4</p>
          <h2 id="step3-heading">開催時刻を確認して生成</h2>
          <p>安全確認後、最大30秒で1日目の結果を表示します。通信中も入力は失われません。</p>
        </div>
      </div>
      <div class="form-grid three-columns">
        <label class="field" for="start-time">
          <span>開始時刻 <em>必須</em></span>
          <input id="start-time" type="time" step="60" />
          <span id="start-time-error" class="field-error" role="alert"></span>
        </label>
        <label class="field" for="game-duration">
          <span>1試合の時間（分） <em>必須</em></span>
          <input id="game-duration" type="number" min="1" max="240" inputmode="numeric" />
          <span id="game-duration-error" class="field-error" role="alert"></span>
        </label>
        <label class="field" for="margin-minutes">
          <span>試合間隔（分） <em>必須</em></span>
          <input id="margin-minutes" type="number" min="0" max="240" inputmode="numeric" />
          <span id="margin-minutes-error" class="field-error" role="alert"></span>
        </label>
      </div>
      <details class="advanced-settings">
        <summary>詳細設定を表示</summary>
        <div class="form-grid">
          <label class="field" for="organizer-capacity">
            <span>同時に担当できる主催者審判数</span>
            <input id="organizer-capacity" type="number" min="0" max="16" inputmode="numeric" />
            <small>変更するまでは、使用コート数と同じ値になります。</small>
            <span id="organizer-capacity-error" class="field-error" role="alert"></span>
          </label>
          <label class="field" for="max-sections">
            <span>最大セクション数 <small>任意</small></span>
            <input id="max-sections" type="number" min="1" max="128" inputmode="numeric" placeholder="指定しない" />
            <small>空欄の場合は、必要な数を自動で使います。</small>
            <span id="max-sections-error" class="field-error" role="alert"></span>
          </label>
          <label class="field" for="random-seed">
            <span>抽選番号</span>
            <input id="random-seed" type="number" step="1" inputmode="numeric" />
            <small>同じ入力と番号なら同じ抽選結果になります。</small>
            <span id="random-seed-error" class="field-error" role="alert"></span>
          </label>
          <label class="check-field field-wide" for="team-referees">
            <input id="team-referees" type="checkbox" />
            <span>第2セクション以降は、空いている参加チームにも審判を割り当てる</span>
          </label>
          <span id="team-referees-error" class="field-error field-wide" role="alert"></span>
        </div>
      </details>
      <div class="generation-box">
        <h3>入力確認と安全確認</h3>
        <p id="generation-review">入力内容を確認しています。</p>
        <div id="turnstile-widget" class="turnstile-box" aria-label="安全確認">この手順を開くと安全確認を読み込みます。</div>
        <button id="generate" class="primary" type="button" disabled>1日目の日程を生成する</button>
        <p id="generation-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div class="wizard-actions">
        <button id="step3-back" class="secondary" type="button">戻る</button>
        <span></span>
      </div>
    </section>

    <section class="panel results" data-panel="4" aria-labelledby="results-heading" hidden>
      <div class="section-heading">
        <div>
          <p class="section-number">手順 4 / 4</p>
          <h2 id="results-heading">1日目のリーグ日程</h2>
          <p id="result-summary">まだ生成結果はありません。</p>
        </div>
        <button id="print" class="secondary no-print" type="button" disabled>印刷する</button>
      </div>
      <div id="result-content" class="result-content empty">
        日程を生成すると、ブロック分け、日程表、チーム別予定をここで確認できます。
      </div>
      <div id="standings-confirmation" class="standings-confirmation no-print" hidden>
        <h3>順位を確定する</h3>
        <p id="league-results-progress">試合結果を確認しています。</p>
        <div id="standings-turnstile-widget" class="turnstile-box" aria-label="順位確定の安全確認">
          安全確認を読み込んでいます。
        </div>
        <button id="confirm-standings" class="primary" type="button" disabled>順位を確定する</button>
        <p id="standings-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div id="tournament-confirmation" class="standings-confirmation no-print" hidden>
        <h3>2日目トーナメントを作成する</h3>
        <p id="tournament-review">確定順位を確認しています。</p>
        <div id="tournament-turnstile-widget" class="turnstile-box" aria-label="トーナメント作成の安全確認">
          安全確認を読み込んでいます。
        </div>
        <button id="generate-tournament" class="primary" type="button" disabled>2日目トーナメントを作成する</button>
        <p id="tournament-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div class="wizard-actions no-print">
        <button id="step4-back" class="secondary" type="button">設定へ戻る</button>
        <span></span>
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

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function inputNumber(input: HTMLInputElement): number | null {
  if (input.value.trim() === "") return null;
  return Number(input.value);
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

const storage = new TournamentStorage();
const autosave = new AutosaveController((value) => storage.saveDraft(value));
let documentState = createTournamentDocument();
let currentStep: WizardStep = 1;
let legacyCompatibility = false;
let organizerCapacityTouched = false;
let turnstileToken = "";
let turnstileWidgetId: string | undefined;
let turnstileSetupStarted = false;
let standingsTurnstileToken = "";
let standingsTurnstileWidgetId: string | undefined;
let standingsTurnstileSetupStarted = false;
let tournamentTurnstileToken = "";
let tournamentTurnstileWidgetId: string | undefined;
let tournamentTurnstileSetupStarted = false;
let turnstileLoadPromise: Promise<TurnstileApi> | undefined;
let standingsStatusOwner: "turnstile" | "calculation" = "turnstile";
let tournamentStatusOwner: "turnstile" | "generation" = "turnstile";
let generationStatusOwner: "turnstile" | "generation" = "turnstile";

const nameInput = requiredElement<HTMLInputElement>("#tournament-name");
const teamsInput = requiredElement<HTMLTextAreaElement>("#teams");
const courtsInput = requiredElement<HTMLTextAreaElement>("#courts");
const blockCountInput = requiredElement<HTMLSelectElement>("#block-count");
const assignmentModeInput = requiredElement<HTMLSelectElement>("#assignment-mode");
const oddSplitPolicyInput = requiredElement<HTMLSelectElement>("#odd-split-policy");
const startTimeInput = requiredElement<HTMLInputElement>("#start-time");
const gameDurationInput = requiredElement<HTMLInputElement>("#game-duration");
const marginInput = requiredElement<HTMLInputElement>("#margin-minutes");
const organizerCapacityInput = requiredElement<HTMLInputElement>("#organizer-capacity");
const maxSectionsInput = requiredElement<HTMLInputElement>("#max-sections");
const randomSeedInput = requiredElement<HTMLInputElement>("#random-seed");
const teamRefereesInput = requiredElement<HTMLInputElement>("#team-referees");
const saveState = requiredElement<HTMLElement>("#save-state");
const backupStatus = requiredElement<HTMLElement>("#backup-status");
const generationStatus = requiredElement<HTMLElement>("#generation-status");
const generateButton = requiredElement<HTMLButtonElement>("#generate");
const printButton = requiredElement<HTMLButtonElement>("#print");
const standingsConfirmation = requiredElement<HTMLElement>("#standings-confirmation");
const leagueResultsProgress = requiredElement<HTMLElement>("#league-results-progress");
const standingsStatus = requiredElement<HTMLElement>("#standings-status");
const standingsButton = requiredElement<HTMLButtonElement>("#confirm-standings");
const tournamentConfirmation = requiredElement<HTMLElement>("#tournament-confirmation");
const tournamentReview = requiredElement<HTMLElement>("#tournament-review");
const tournamentStatus = requiredElement<HTMLElement>("#tournament-status");
const tournamentButton = requiredElement<HTMLButtonElement>("#generate-tournament");

type TurnstileApi = NonNullable<Window["turnstile"]>;

function turnstileApi(): TurnstileApi | undefined {
  const candidate = window.turnstile;
  return candidate !== undefined &&
    typeof candidate.render === "function" &&
    typeof candidate.reset === "function"
    ? candidate
    : undefined;
}

function refreshGenerateEnabled(): void {
  generateButton.disabled =
    turnstileToken.length === 0 || !navigator.onLine || currentStep !== 3;
}

function requireTurnstileConfirmation(message: string): void {
  turnstileToken = "";
  generationStatusOwner = "turnstile";
  generationStatus.textContent = message;
  refreshGenerateEnabled();
}

function namesFromInput(field: "teams" | "courts"): string[] {
  return asObjectArray(documentState.tournament.input[field]).map((item) =>
    typeof item.name === "string"
      ? item.name
      : typeof item.id === "string"
        ? item.id
        : "名称未設定",
  );
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
  const settings = asObject(documentState.tournament.input.day);
  if (
    typeof settings?.start_time !== "string" ||
    typeof settings.game_duration_minutes !== "number" ||
    typeof settings.margin_minutes !== "number"
  ) {
    return `第${sectionNumber}セクション`;
  }
  const [hoursText, minutesText] = settings.start_time.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return `第${sectionNumber}セクション`;
  const totalMinutes =
    hours * 60 +
    minutes +
    (sectionNumber - 1) *
      (settings.game_duration_minutes + settings.margin_minutes);
  const time = `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  return `第${sectionNumber}・${time}`;
}

function resultLeaguePlan(): JsonObject | undefined {
  return asObject(documentState.tournament.result?.league_plan);
}

function resultMatches(): JsonObject[] {
  const planned = asObjectArray(resultLeaguePlan()?.matches);
  return planned.length > 0
    ? planned
    : asObjectArray(documentState.tournament.input.matches);
}

function leagueResults(): JsonObject[] {
  return asObjectArray(documentState.tournament.result?.league_results);
}

function saveLeagueResults(results: JsonObject[], standings?: JsonObject): boolean {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return false;
  const hadStandings = asObject(result.league_standings) !== undefined;
  const hadTournament = asObject(result.tournament_plan) !== undefined;
  const nextResult: JsonObject = { ...result, league_results: results };
  if (standings === undefined) {
    delete nextResult.league_standings;
  } else {
    nextResult.league_standings = standings;
  }
  delete nextResult.tournament_plan;
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      result: nextResult,
    },
  };
  saveState.textContent = "保存しています…";
  autosave.schedule(
    documentState,
    () => {
      saveState.textContent = "この端末に保存済み";
    },
    () => {
      saveState.textContent = "保存できませんでした";
      standingsStatus.textContent =
        "試合結果を保存できませんでした。端末の空き容量を確認してください。";
    },
  );
  return hadStandings || hadTournament;
}

function saveTournamentPlan(plan: JsonObject): void {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return;
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      result: { ...result, tournament_plan: plan },
    },
  };
  saveState.textContent = "保存しています…";
  autosave.schedule(
    documentState,
    () => {
      saveState.textContent = "この端末に保存済み";
    },
    () => {
      saveState.textContent = "保存できませんでした";
      tournamentStatus.textContent =
        "トーナメント表を保存できませんでした。ファイルへ保存してください。";
    },
  );
}

function orderedLeagueMatches(slots: JsonObject[]): JsonObject[] {
  const order = new Map(
    slots.map((slot, index) => [String(slot.match_id), index]),
  );
  return resultMatches()
    .filter((match) => String(match.phase) === "league")
    .sort(
      (left, right) =>
        (order.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER),
    );
}

function refreshLeagueResultsProgress(totalMatches: number): void {
  const enteredCount = new Set(
    leagueResults()
      .filter((result) => typeof result.match_id === "string")
      .map((result) => result.match_id as string),
  ).size;
  leagueResultsProgress.textContent = `入力済み ${enteredCount} / ${totalMatches}試合`;
  standingsButton.disabled =
    enteredCount !== totalMatches ||
    totalMatches === 0 ||
    !navigator.onLine ||
    standingsTurnstileToken.length === 0;
}

function refreshTournamentEnabled(): void {
  const result = asObject(documentState.tournament.result);
  const hasStandings = asObject(result?.league_standings) !== undefined;
  tournamentButton.disabled =
    !hasStandings || !navigator.onLine || tournamentTurnstileToken.length === 0;
}

function renderResult(): void {
  const summary = requiredElement<HTMLElement>("#result-summary");
  const content = requiredElement<HTMLElement>("#result-content");
  const result = documentState.tournament.result;
  if (result === undefined) {
    summary.textContent = "まだ生成結果はありません。";
    content.textContent =
      "日程を生成すると、ブロック分け、日程表、チーム別予定をここで確認できます。";
    content.classList.add("empty");
    standingsConfirmation.hidden = true;
    tournamentConfirmation.hidden = true;
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
    resultMatches()
      .filter((match) => typeof match.id === "string")
      .map((match) => [match.id as string, match]),
  );
  const status = result.status === "OPTIMAL" || result.status === "FEASIBLE" ? "生成完了" : String(result.status ?? "完了");
  summary.textContent = `${status}／配置済み ${slots.length}試合`;
  content.replaceChildren();
  content.classList.remove("empty");

  const overview = window.document.createElement("dl");
  for (const [label, value] of [
    ["大会名", documentState.tournament.name || "名称未設定"],
    ["参加チーム", `${teamNames.size}チーム`],
    ["配置済み試合", `${slots.length}試合`],
    ["保存日時", new Date(documentState.updatedAt).toLocaleString("ja-JP")],
  ] as Array<readonly [string, string]>) {
    const wrapper = window.document.createElement("div");
    appendTextElement(wrapper, "dt", label);
    appendTextElement(wrapper, "dd", value);
    overview.append(wrapper);
  }
  content.append(overview);

  const validation = asObject(result.validation);
  if (validation?.valid === true) {
    appendTextElement(content, "p", "大会規則の独立チェックに合格しています。", "validation-ok");
  }

  const leaguePlan = resultLeaguePlan();
  const blocks = asObjectArray(leaguePlan?.blocks);
  standingsConfirmation.hidden = blocks.length === 0;
  tournamentConfirmation.hidden = true;
  if (blocks.length > 0) {
    appendTextElement(content, "h3", "ブロック分け");
    const blockGrid = window.document.createElement("div");
    blockGrid.className = "block-grid";
    const rounds = asObjectArray(leaguePlan?.logical_rounds);
    for (const block of blocks) {
      const card = window.document.createElement("section");
      card.className = "block-card";
      const blockId = String(block.id ?? "-");
      appendTextElement(card, "h4", `${blockId}ブロック`);
      const list = window.document.createElement("ol");
      for (const teamId of Array.isArray(block.team_ids) ? block.team_ids : []) {
        appendTextElement(list, "li", teamNames.get(String(teamId)) ?? "名称未設定");
      }
      card.append(list);
      const roundCount = rounds.filter((round) => round.block_id === block.id).length;
      appendTextElement(card, "p", `総当たり ${roundCount}ラウンド`, "muted");
      blockGrid.append(card);
    }
    content.append(blockGrid);
  }

  if (blocks.length > 0) {
    const resultsByMatch = new Map(
      leagueResults()
        .filter((value) => typeof value.match_id === "string")
        .map((value) => [value.match_id as string, value]),
    );
    const leagueMatches = orderedLeagueMatches(slots);
    const enteredCount = leagueMatches.filter((match) =>
      resultsByMatch.has(String(match.id)),
    ).length;
    appendTextElement(content, "h3", "リーグ結果入力");
    appendTextElement(
      content,
      "p",
      `入力済み ${enteredCount} / ${leagueMatches.length}試合。得点を入力すると、この端末へ自動保存します。`,
      "muted",
    );
    const resultTable = window.document.createElement("table");
    const resultHead = window.document.createElement("thead");
    const resultHeading = window.document.createElement("tr");
    for (const heading of ["時間", "ブロック", "対戦", "得点", "保存状態"]) {
      appendTextElement(resultHeading, "th", heading);
    }
    resultHead.append(resultHeading);
    resultTable.append(resultHead);
    const resultBody = window.document.createElement("tbody");
    for (const match of leagueMatches) {
      const matchId = String(match.id);
      const current = resultsByMatch.get(matchId);
      const scheduledSlot = slots.find((slot) => slot.match_id === matchId);
      const row = window.document.createElement("tr");
      appendTextElement(
        row,
        "td",
        scheduledSlot === undefined
          ? "未配置"
          : sectionLabel(Number(scheduledSlot.section_no)),
      );
      const blockId = blocks.find(
        (block) =>
          Array.isArray(block.team_ids) &&
          block.team_ids.includes(exactTeamId(match, "home")),
      )?.id;
      appendTextElement(row, "td", String(blockId ?? "-"));
      const home = exactTeamId(match, "home");
      const away = exactTeamId(match, "away");
      const homeName = teamNames.get(home ?? "") ?? "名称未設定";
      const awayName = teamNames.get(away ?? "") ?? "名称未設定";
      appendTextElement(row, "td", `${homeName} 対 ${awayName}`);
      const scoreCell = window.document.createElement("td");
      const homeScore = window.document.createElement("input");
      const awayScore = window.document.createElement("input");
      for (const [input, teamName] of [
        [homeScore, homeName],
        [awayScore, awayName],
      ] as const) {
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.inputMode = "numeric";
        input.className = "score-input";
        input.setAttribute("aria-label", `${homeName} 対 ${awayName}・${teamName}の得点`);
      }
      homeScore.value = typeof current?.home_score === "number" ? String(current.home_score) : "";
      awayScore.value = typeof current?.away_score === "number" ? String(current.away_score) : "";
      scoreCell.append(homeScore, window.document.createTextNode(" - "), awayScore);
      row.append(scoreCell);
      const saved = appendTextElement(
        row,
        "td",
        current === undefined ? "未入力" : "保存済み",
        "muted",
      );
      const save = () => {
        const homeValue = inputNumber(homeScore);
        const awayValue = inputNumber(awayScore);
        const validHome =
          homeValue === null || (Number.isInteger(homeValue) && homeValue >= 0);
        const validAway =
          awayValue === null || (Number.isInteger(awayValue) && awayValue >= 0);
        homeScore.toggleAttribute("aria-invalid", !validHome);
        awayScore.toggleAttribute("aria-invalid", !validAway);
        if (!validHome || !validAway) {
          saved.textContent = "0以上の整数を入力";
          saved.className = "field-error";
          standingsButton.disabled = true;
          return;
        }
        const next = leagueResults().filter((value) => value.match_id !== matchId);
        if (homeValue !== null && awayValue !== null) {
          next.push({ match_id: matchId, home_score: homeValue, away_score: awayValue });
        }
        const invalidated = saveLeagueResults(next);
        saved.textContent =
          homeValue !== null && awayValue !== null ? "保存済み" : "未入力";
        saved.className = "muted";
        refreshLeagueResultsProgress(leagueMatches.length);
        if (invalidated) {
          standingsStatusOwner = "calculation";
          standingsStatus.textContent =
            "得点を変更したため、確定順位を取り消しました。もう一度順位を確定してください。";
          document.querySelector("#league-standings-view")?.remove();
          document.querySelector("#tournament-plan-view")?.remove();
          tournamentConfirmation.hidden = true;
        }
      };
      homeScore.addEventListener("input", save);
      awayScore.addEventListener("input", save);
      resultBody.append(row);
    }
    resultTable.append(resultBody);
    const resultWrapper = window.document.createElement("div");
    resultWrapper.className = "table-wrap";
    resultWrapper.append(resultTable);
    content.append(resultWrapper);
    refreshLeagueResultsProgress(leagueMatches.length);
    setupStandingsTurnstile();
    const standings = asObject(result.league_standings);
    tournamentConfirmation.hidden = standings === undefined;
    if (standings !== undefined) {
      renderLeagueStandings(content, standings, teamNames);
      const league = asObject(documentState.tournament.input.league);
      const splitLabels: Record<string, string> = {
        upper: "中央順位を上位へ入れる",
        lower: "中央順位を下位へ入れる",
        alternate: "ブロック順に上位・下位を交互にする",
      };
      const policy = String(league?.odd_split_policy ?? "upper");
      tournamentReview.textContent = `上下振り分け：${splitLabels[policy] ?? splitLabels.upper}`;
      setupTournamentTurnstile();
      refreshTournamentEnabled();
      const tournamentPlan = asObject(result.tournament_plan);
      if (tournamentPlan !== undefined) {
        renderTournamentPlan(content, tournamentPlan, standings, teamNames);
      }
    }
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
    const assignment = asObject(slot.referee_assignment);
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
      teamSchedules.get(refereeTeamId)?.push(`${sectionLabel(sectionNumber)}　${courtName}　審判`);
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

function renderLeagueStandings(content: HTMLElement, standings: JsonObject, teamNames: Map<string, string>): void {
  const section = window.document.createElement("section");
  section.id = "league-standings-view";
  appendTextElement(section, "h3", "確定順位");
  const table = window.document.createElement("table");
  const head = window.document.createElement("thead");
  const heading = window.document.createElement("tr");
  for (const label of [
    "ブロック",
    "順位",
    "チーム",
    "勝点",
    "得失点差",
    "総得点",
    "直接対戦",
    "決定根拠",
  ]) {
    appendTextElement(heading, "th", label);
  }
  head.append(heading);
  table.append(head);
  const body = window.document.createElement("tbody");
  for (const rowValue of asObjectArray(standings.standings)) {
    const row = window.document.createElement("tr");
    const headToHead = asObject(rowValue.head_to_head);
    const headToHeadLabel =
      headToHead === undefined
        ? "—"
        : `勝点${String(headToHead.points)}・得失点差${String(headToHead.goal_difference)}・総得点${String(headToHead.goals_for)}`;
    for (const value of [
      rowValue.block_id,
      rowValue.rank,
      teamNames.get(String(rowValue.team_id)) ?? "名称未設定",
      rowValue.points,
      rowValue.goal_difference,
      rowValue.goals_for,
      headToHeadLabel,
      rowValue.tie_break,
    ]) {
      appendTextElement(row, "td", String(value ?? "-"));
    }
    body.append(row);
  }
  table.append(body);
  const wrapper = window.document.createElement("div");
  wrapper.className = "table-wrap";
  wrapper.append(table);
  section.append(wrapper);
  for (const draw of asObjectArray(standings.draws)) {
    const order = Array.isArray(draw.decided_order)
      ? draw.decided_order.map((team) => teamNames.get(String(team)) ?? String(team)).join("、")
      : "";
    appendTextElement(
      section,
      "p",
      `${String(draw.block_id)}ブロックの抽選（抽選番号 ${String(draw.random_seed)}）：${order}`,
      "muted",
    );
  }
  content.append(section);
}

function tournamentEntryLabel(
  value: unknown,
  rankedTeams: Map<string, string>,
  teamNames: Map<string, string>,
): string {
  const entry = asObject(value);
  if (entry?.type === "concrete_team" && typeof entry.team_id === "string") {
    return teamNames.get(entry.team_id) ?? "名称未設定";
  }
  if (
    entry?.type === "league_rank" &&
    typeof entry.block_id === "string" &&
    typeof entry.rank === "number"
  ) {
    const teamId = rankedTeams.get(`${entry.block_id}:${entry.rank}`);
    return teamId === undefined
      ? `${entry.block_id}ブロック ${entry.rank}位`
      : (teamNames.get(teamId) ?? "名称未設定");
  }
  if (entry?.type === "winner_of" && typeof entry.match_id === "string") {
    return `${entry.match_id}の勝者`;
  }
  if (entry?.type === "loser_of" && typeof entry.match_id === "string") {
    return `${entry.match_id}の敗者`;
  }
  return "対戦結果で決定";
}

function renderTournamentPlan(
  content: HTMLElement,
  plan: JsonObject,
  standings: JsonObject,
  teamNames: Map<string, string>,
): void {
  const section = window.document.createElement("section");
  section.id = "tournament-plan-view";
  appendTextElement(section, "h3", "2日目トーナメント組合せ");
  appendTextElement(
    section,
    "p",
    "不戦通過は試合数に含めず、各トーナメントの1位から最下位までを決める表です。",
    "muted",
  );
  const rankedTeams = new Map(
    asObjectArray(standings.standings)
      .filter(
        (row) =>
          typeof row.block_id === "string" &&
          typeof row.rank === "number" &&
          typeof row.team_id === "string",
      )
      .map((row) => [`${String(row.block_id)}:${String(row.rank)}`, String(row.team_id)]),
  );

  for (const [field, heading] of [
    ["upper", "上位トーナメント"],
    ["lower", "下位トーナメント"],
  ] as const) {
    const pool = asObject(plan[field]);
    if (pool === undefined) continue;
    const poolSection = window.document.createElement("section");
    poolSection.className = "tournament-pool";
    appendTextElement(
      poolSection,
      "h4",
      `${heading}（${String(pool.participant_count ?? 0)}チーム）`,
    );

    const seedList = window.document.createElement("ol");
    seedList.className = "seed-list";
    for (const seed of asObjectArray(pool.seeds)) {
      appendTextElement(
        seedList,
        "li",
        `${teamNames.get(String(seed.team_id)) ?? "名称未設定"}（${String(seed.block_id)}ブロック ${String(seed.block_rank)}位）`,
      );
    }
    poolSection.append(seedList);

    const byes = asObjectArray(pool.byes);
    if (byes.length > 0) {
      appendTextElement(poolSection, "h5", "予備戦免除（不戦通過）");
      const byeList = window.document.createElement("ul");
      for (const bye of byes) {
        appendTextElement(
          byeList,
          "li",
          `${tournamentEntryLabel(bye.entry, rankedTeams, teamNames)} → ${String(bye.next_match_id)}`,
        );
      }
      poolSection.append(byeList);
    }

    const table = window.document.createElement("table");
    const head = window.document.createElement("thead");
    const headingRow = window.document.createElement("tr");
    for (const label of ["試合", "段階", "対戦", "決定順位範囲"]) {
      appendTextElement(headingRow, "th", label);
    }
    head.append(headingRow);
    table.append(head);
    const body = window.document.createElement("tbody");
    for (const match of asObjectArray(pool.matches)) {
      const row = window.document.createElement("tr");
      const rankRange = Array.isArray(match.rank_range)
        ? `${String(match.rank_range[0])}〜${String(match.rank_range[1])}位`
        : "-";
      for (const value of [
        match.id,
        match.round,
        `${tournamentEntryLabel(match.home, rankedTeams, teamNames)} 対 ${tournamentEntryLabel(match.away, rankedTeams, teamNames)}`,
        rankRange,
      ]) {
        appendTextElement(row, "td", String(value ?? "-"));
      }
      body.append(row);
    }
    table.append(body);
    const wrapper = window.document.createElement("div");
    wrapper.className = "table-wrap";
    wrapper.append(table);
    poolSection.append(wrapper);

    appendTextElement(poolSection, "h5", "最終順位の決まり方");
    const placements = window.document.createElement("ol");
    for (const placement of asObjectArray(pool.placements)) {
      appendTextElement(
        placements,
        "li",
        `${String(placement.rank)}位：${tournamentEntryLabel(placement.entry, rankedTeams, teamNames)}`,
      );
    }
    poolSection.append(placements);
    section.append(poolSection);
  }

  for (const draw of asObjectArray(plan.seed_draws)) {
    const order = Array.isArray(draw.decided_order)
      ? draw.decided_order.map((team) => teamNames.get(String(team)) ?? String(team)).join("、")
      : "";
    appendTextElement(
      section,
      "p",
      `${draw.pool === "upper" ? "上位" : "下位"}・ブロック${String(draw.block_rank)}位の抽選（抽選番号 ${String(draw.random_seed)}）：${order}`,
      "muted",
    );
  }
  for (const warning of asObjectArray(plan.warnings)) {
    appendTextElement(section, "p", String(warning.message ?? "組合せに注意事項があります。"), "notice");
  }
  content.append(section);
}

function requestLeagueStandings(): void {
  const result = asObject(documentState.tournament.result);
  const plan = resultLeaguePlan();
  if (result === undefined || plan === undefined) return;
  if (standingsTurnstileToken.length === 0) {
    standingsStatus.textContent = "順位確定の安全確認を完了してください。";
    return;
  }
  standingsButton.disabled = true;
  standingsStatusOwner = "calculation";
  standingsStatus.textContent = "順位を計算しています…";
  void calculateLeagueStandings(
    {
      request_kind: "league_standings",
      league_plan: plan,
      results: leagueResults(),
      random_seed: documentState.tournament.input.random_seed ?? 20260803,
    },
    standingsTurnstileToken,
  )
    .then((standings) => {
      saveLeagueResults(leagueResults(), standings);
      standingsStatus.textContent = "順位を確定し、この端末へ保存しました。";
      renderResult();
    })
    .catch((error: unknown) => {
      standingsStatus.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "順位を確定できませんでした。入力は保存されています。";
      refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
    })
    .finally(() => {
      standingsTurnstileToken = "";
      refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
      const api = turnstileApi();
      if (standingsTurnstileWidgetId !== undefined && api !== undefined) {
        try {
          api.reset(standingsTurnstileWidgetId);
        } catch {
          standingsStatus.textContent =
            "安全確認を再開できませんでした。画面を再読み込みしてください。";
        }
      }
    });
}

function requestTournamentPlan(): void {
  const result = asObject(documentState.tournament.result);
  const leaguePlan = resultLeaguePlan();
  const standings = asObject(result?.league_standings);
  if (result === undefined || leaguePlan === undefined || standings === undefined) return;
  if (tournamentTurnstileToken.length === 0) {
    tournamentStatus.textContent = "トーナメント作成の安全確認を完了してください。";
    return;
  }
  tournamentButton.disabled = true;
  tournamentStatusOwner = "generation";
  tournamentStatus.textContent = "2日目トーナメントを作成しています…";
  const league = asObject(documentState.tournament.input.league);
  void generateTournamentPlan(
    {
      request_kind: "tournament_plan",
      league_plan: leaguePlan,
      league_standings: standings,
      odd_split_policy: league?.odd_split_policy ?? "upper",
      random_seed: documentState.tournament.input.random_seed ?? 20260803,
    },
    tournamentTurnstileToken,
  )
    .then((plan) => {
      saveTournamentPlan(plan);
      tournamentStatus.textContent =
        "2日目トーナメントを作成し、この端末へ保存しました。";
      renderResult();
    })
    .catch((error: unknown) => {
      tournamentStatus.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "トーナメントを作成できませんでした。確定順位は保存されています。";
      refreshTournamentEnabled();
    })
    .finally(() => {
      tournamentTurnstileToken = "";
      refreshTournamentEnabled();
      const api = turnstileApi();
      if (tournamentTurnstileWidgetId !== undefined && api !== undefined) {
        try {
          api.reset(tournamentTurnstileWidgetId);
        } catch {
          tournamentStatus.textContent =
            "安全確認を再開できませんでした。画面を再読み込みしてください。";
        }
      }
    });
}

function renderBlockCountOptions(selected: unknown): void {
  const teamCount = lines(teamsInput.value).length;
  blockCountInput.replaceChildren();
  const placeholder = window.document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "選択してください";
  blockCountInput.append(placeholder);
  for (let value = 1; value <= Math.max(1, teamCount); value += 1) {
    const option = window.document.createElement("option");
    option.value = String(value);
    option.textContent = `${value}ブロック`;
    blockCountInput.append(option);
  }
  blockCountInput.value = typeof selected === "number" ? String(selected) : "";
}

function setLegacyControlsDisabled(disabled: boolean): void {
  for (const control of [
    teamsInput,
    courtsInput,
    blockCountInput,
    assignmentModeInput,
    oddSplitPolicyInput,
    startTimeInput,
    gameDurationInput,
    marginInput,
    organizerCapacityInput,
    maxSectionsInput,
    randomSeedInput,
    teamRefereesInput,
  ]) {
    control.disabled = disabled;
  }
  requiredElement<HTMLElement>("#legacy-banner").hidden = !disabled;
}

function updateReview(): void {
  const teamCount = lines(teamsInput.value).length;
  const courtCount = lines(courtsInput.value).length;
  const blockText = blockCountInput.value === "" ? "未選択" : `${blockCountInput.value}ブロック`;
  requiredElement<HTMLElement>("#generation-review").textContent = legacyCompatibility
    ? "従来形式の大会設定をそのまま使って日程を再生成します。"
    : `${teamCount}チーム／${blockText}／${courtCount}コート／${startTimeInput.value}開始で生成します。`;
}

function renderStep(): void {
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = Number(panel.dataset.panel) !== currentStep;
  }
  for (const step of document.querySelectorAll<HTMLButtonElement>(".step[data-step]")) {
    const active = Number(step.dataset.step) === currentStep;
    step.classList.toggle("active", active);
    if (active) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  }
  updateReview();
  refreshGenerateEnabled();
  if (currentStep === 3) setupTurnstile();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render(): void {
  const input = documentState.tournament.input;
  const league = asObject(input.league);
  const day = asObject(input.day);
  const referees = asObject(input.referees);
  nameInput.value = documentState.tournament.name;
  teamsInput.value = namesFromInput("teams").join("\n");
  courtsInput.value = namesFromInput("courts").join("\n");
  renderBlockCountOptions(league?.block_count);
  assignmentModeInput.value =
    league?.assignment_mode === "seeded_snake" ? "seeded_snake" : "random";
  oddSplitPolicyInput.value = new Set(["upper", "lower", "alternate"]).has(
    String(league?.odd_split_policy),
  )
    ? String(league?.odd_split_policy)
    : "upper";
  startTimeInput.value = typeof day?.start_time === "string" ? day.start_time : "09:30";
  gameDurationInput.value = String(day?.game_duration_minutes ?? 35);
  marginInput.value = String(day?.margin_minutes ?? 5);
  organizerCapacityInput.value = String(
    referees?.organizer_capacity ?? Math.max(1, lines(courtsInput.value).length),
  );
  maxSectionsInput.value =
    typeof day?.max_sections === "number" ? String(day.max_sections) : "";
  randomSeedInput.value = String(input.random_seed ?? 20260803);
  teamRefereesInput.checked = referees?.team_referees_required_after_first !== false;
  requiredElement<HTMLElement>("#team-count").textContent = `${lines(teamsInput.value).length} / 32チーム`;
  requiredElement<HTMLElement>("#court-count").textContent = `${lines(courtsInput.value).length} / 16コート`;
  setLegacyControlsDisabled(legacyCompatibility);
  clearFieldIssues();
  renderResult();
  renderStep();
}

function updateDraft(invalidateResult = false): void {
  const previous = cloneDocument(documentState);
  const now = new Date().toISOString();
  if (legacyCompatibility) {
    documentState = {
      ...previous,
      updatedAt: now,
      tournament: { ...previous.tournament, name: nameInput.value.trim() },
    };
  } else {
    const teamNames = lines(teamsInput.value).slice(0, 32);
    const courtNames = lines(courtsInput.value).slice(0, 16);
    const seeded = assignmentModeInput.value === "seeded_snake";
    documentState = {
      ...previous,
      updatedAt: now,
      tournament: {
        name: nameInput.value.trim(),
        input: {
          schema_version: "0.1.0",
          request_kind: "day1_league",
          teams: teamNames.map((name, index) => ({
            id: `team-${String(index + 1).padStart(2, "0")}`,
            name,
            ...(seeded ? { seed: index + 1 } : {}),
          })),
          courts: courtNames.map((name, index) => ({
            id: `court-${String(index + 1).padStart(2, "0")}`,
            name,
          })),
          league: {
            block_count: blockCountInput.value === "" ? null : Number(blockCountInput.value),
            assignment_mode: assignmentModeInput.value,
            odd_split_policy: oddSplitPolicyInput.value,
          },
          day: {
            id: "day1",
            start_time: startTimeInput.value,
            game_duration_minutes: inputNumber(gameDurationInput),
            margin_minutes: inputNumber(marginInput),
            max_sections: inputNumber(maxSectionsInput),
          },
          referees: {
            organizer_capacity: inputNumber(organizerCapacityInput),
            team_referees_required_after_first: teamRefereesInput.checked,
          },
          random_seed: inputNumber(randomSeedInput),
          solver: { max_time_seconds: 30 },
        },
        result: invalidateResult ? undefined : previous.tournament.result,
      },
    };
  }
  requiredElement<HTMLElement>("#team-count").textContent = `${lines(teamsInput.value).length} / 32チーム`;
  requiredElement<HTMLElement>("#court-count").textContent = `${lines(courtsInput.value).length} / 16コート`;
  updateReview();
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

function clearFieldIssues(): void {
  for (const error of document.querySelectorAll<HTMLElement>(".field-error")) {
    error.textContent = "";
  }
  for (const invalid of document.querySelectorAll<HTMLElement>("[aria-invalid='true']")) {
    invalid.removeAttribute("aria-invalid");
  }
}

function showFieldIssues(issues: FieldIssue[]): void {
  clearFieldIssues();
  for (const issue of issues) {
    const field = document.getElementById(issue.field);
    const error = document.getElementById(`${issue.field}-error`);
    field?.setAttribute("aria-invalid", "true");
    if (error !== null) error.textContent = issue.message;
  }
}

function goToStep(step: WizardStep, validateForward = true): boolean {
  updateDraft(false);
  if (validateForward && !legacyCompatibility && step > currentStep) {
    const through = Math.min(step - 1, 3) as 1 | 2 | 3;
    const issues = validateDay1LeagueDocument(documentState, through);
    if (issues.length > 0) {
      const first = issues[0];
      currentStep = first?.step ?? currentStep;
      showFieldIssues(issues);
      generationStatus.textContent =
        "入力を修正してください。赤字の説明に、必要な対応を表示しています。";
      renderStep();
      document.getElementById(first?.field ?? "")?.focus();
      return false;
    }
  }
  clearFieldIssues();
  currentStep = step;
  renderStep();
  return true;
}

function onConfigurationChanged(options: { courtsChanged?: boolean } = {}): void {
  if (legacyCompatibility) return;
  if (options.courtsChanged && !organizerCapacityTouched) {
    organizerCapacityInput.value = String(Math.max(1, lines(courtsInput.value).length));
  }
  const selectedBlock = blockCountInput.value === "" ? undefined : Number(blockCountInput.value);
  if (teamsInput === document.activeElement) renderBlockCountOptions(selectedBlock);
  const hadResult = documentState.tournament.result !== undefined;
  updateDraft(hadResult);
  if (hadResult) {
    renderResult();
    generationStatus.textContent =
      "大会設定を変更したため、以前の生成結果を取り消しました。もう一度生成してください。";
  }
}

nameInput.addEventListener("input", () => updateDraft(false));
teamsInput.addEventListener("input", () => onConfigurationChanged());
courtsInput.addEventListener("input", () => onConfigurationChanged({ courtsChanged: true }));
for (const control of [
  blockCountInput,
  assignmentModeInput,
  oddSplitPolicyInput,
  startTimeInput,
  gameDurationInput,
  marginInput,
  maxSectionsInput,
  randomSeedInput,
  teamRefereesInput,
]) {
  control.addEventListener("input", () => onConfigurationChanged());
  control.addEventListener("change", () => onConfigurationChanged());
}
organizerCapacityInput.addEventListener("input", () => {
  organizerCapacityTouched = true;
  onConfigurationChanged();
});

for (const stepButton of document.querySelectorAll<HTMLButtonElement>(".step[data-step]")) {
  stepButton.addEventListener("click", () => {
    const step = Number(stepButton.dataset.step) as WizardStep;
    goToStep(step, step > currentStep);
  });
}
requiredElement<HTMLButtonElement>("#step1-next").addEventListener("click", () => goToStep(2));
requiredElement<HTMLButtonElement>("#step2-back").addEventListener("click", () => goToStep(1, false));
requiredElement<HTMLButtonElement>("#step2-next").addEventListener("click", () => goToStep(3));
requiredElement<HTMLButtonElement>("#step3-back").addEventListener("click", () => goToStep(2, false));
requiredElement<HTMLButtonElement>("#step4-back").addEventListener("click", () => goToStep(3, false));

requiredElement<HTMLButtonElement>("#confirm-save").addEventListener("click", () => {
  updateDraft(false);
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
  updateDraft(false);
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
  delete backupStatus.dataset.state;
  void file
    .text()
    .then((text) => {
      const imported = parseTournamentJson(text);
      const mode = normalizeDocument(imported);
      const teams = asObjectArray(mode.document.tournament.input.teams).length;
      const matches =
        asObjectArray(mode.document.tournament.input.matches).length ||
        asObjectArray(asObject(mode.document.tournament.result?.league_plan)?.matches).length;
      const confirmed = window.confirm(
        `「${mode.document.tournament.name}」を読み込みます。\nチーム：${teams}／生成済み試合：${matches}\n\n現在の内容はひとつ前の状態として残ります。よろしいですか？`,
      );
      if (!confirmed) {
        backupStatus.textContent = "読み込みを取り消しました。現在の内容は変わっていません。";
        return;
      }
      autosave.cancel();
      documentState = mode.document;
      legacyCompatibility = mode.legacyCompatibility;
      organizerCapacityTouched = inferOrganizerCapacityTouched();
      currentStep = documentState.tournament.result === undefined ? 1 : 4;
      return storage.replaceImported(documentState).then(() => {
        render();
        backupStatus.dataset.state = "imported";
        backupStatus.textContent = mode.migrated
          ? "以前の下書きを1日目リーグ形式へ移行して復元しました。"
          : "ファイルから復元しました。内容を確認してください。";
      });
    })
    .catch((error: unknown) => {
      backupStatus.dataset.state = "import-error";
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
    const mode = normalizeDocument(previous);
    documentState = mode.document;
    legacyCompatibility = mode.legacyCompatibility;
    organizerCapacityTouched = inferOrganizerCapacityTouched();
    currentStep = documentState.tournament.result === undefined ? 1 : 4;
    render();
    backupStatus.textContent = "ひとつ前の状態へ戻しました。";
  });
});

requiredElement<HTMLButtonElement>("#delete").addEventListener("click", () => {
  if (
    !window.confirm(
      "この端末に保存した現在の大会データを削除しますか？\n削除後も「ひとつ前の状態へ戻す」で一度だけ元に戻せます。",
    )
  ) {
    return;
  }
  autosave.cancel();
  void storage.deleteCurrent().then(() => {
    documentState = createTournamentDocument();
    legacyCompatibility = false;
    organizerCapacityTouched = false;
    currentStep = 1;
    render();
    backupStatus.textContent =
      "現在のデータを削除しました。「ひとつ前の状態へ戻す」で取り消せます。";
  });
});

function apiFieldIssues(error: ScheduleApiError): FieldIssue[] {
  const issues = issuesFromApiDetails(error.details);
  if (issues.length > 0) return issues;
  if (error.code === "INVALID_BLOCK_COUNT") {
    return [
      {
        field: "block-count",
        step: 2,
        message: "ブロック数を参加チーム数以下にしてください。",
      },
    ];
  }
  return [];
}

generateButton.addEventListener("click", () => {
  updateDraft(false);
  if (!legacyCompatibility) {
    const issues = validateDay1LeagueDocument(documentState);
    if (issues.length > 0) {
      const first = issues[0];
      showFieldIssues(issues);
      currentStep = first?.step ?? 3;
      generationStatus.textContent =
        "日程を生成する前に入力を修正してください。赤字の説明に、必要な対応を表示しています。";
      renderStep();
      document.getElementById(first?.field ?? "")?.focus();
      return;
    }
  }
  if (!navigator.onLine) {
    generationStatus.textContent =
      "オフラインでは新しい日程を生成できません。保存済み結果の確認と印刷は利用できます。";
    refreshGenerateEnabled();
    return;
  }
  if (turnstileToken.length === 0) {
    requireTurnstileConfirmation("安全確認を完了してから日程を生成してください。");
    return;
  }

  generateButton.disabled = true;
  generationStatusOwner = "generation";
  generationStatus.textContent = "1日目の日程を生成しています。画面を閉じずにお待ちください…";
  void generateSchedule(documentState.tournament.input, turnstileToken)
    .then((result) => {
      documentState = {
        ...documentState,
        updatedAt: new Date().toISOString(),
        tournament: { ...documentState.tournament, result },
      };
      autosave.cancel();
      return storage.confirm(documentState).then(() => {
        generationStatus.textContent = "1日目の日程を生成し、この端末へ保存しました。";
        currentStep = 4;
        renderResult();
        renderStep();
      });
    })
    .catch((error: unknown) => {
      if (error instanceof ScheduleApiError) {
        const issues = apiFieldIssues(error);
        if (issues.length > 0) {
          showFieldIssues(issues);
          currentStep = issues[0]?.step ?? 3;
          generationStatus.textContent =
            "日程を生成できませんでした。赤字の説明に沿って入力を修正してください。";
          renderStep();
          document.getElementById(issues[0]?.field ?? "")?.focus();
        } else {
          generationStatus.textContent = error.message;
        }
      } else {
        generationStatus.textContent =
          "日程を生成できませんでした。入力は保存されています。もう一度お試しください。";
      }
    })
    .finally(() => {
      turnstileToken = "";
      refreshGenerateEnabled();
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
standingsButton.addEventListener("click", requestLeagueStandings);
tournamentButton.addEventListener("click", requestTournamentPlan);

function updateConnectionStatus(): void {
  const connection = requiredElement<HTMLElement>("#connection");
  if (navigator.onLine) {
    connection.textContent = "オンライン：日程を生成できます";
    connection.className = "connection online";
  } else {
    connection.textContent = "オフライン：保存済みの内容を確認できます";
    connection.className = "connection offline";
  }
  refreshGenerateEnabled();
  if (!standingsConfirmation.hidden) {
    refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
  }
  if (!tournamentConfirmation.hidden) refreshTournamentEnabled();
}
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();

function setupTurnstile(): void {
  if (turnstileSetupStarted) return;
  turnstileSetupStarted = true;
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#turnstile-widget");
  generateButton.disabled = true;
  if (!siteKey) {
    container.textContent =
      "安全確認の設定が完了していないため、現在は日程を生成できません。";
    requireTurnstileConfirmation(
      "安全確認の設定が完了していないため、現在は日程を生成できません。",
    );
    return;
  }
  void loadTurnstileApi()
    .then((api) => {
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
            refreshGenerateEnabled();
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
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error && error.message === "Turnstile API is unavailable"
          ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
          : "安全確認を読み込めませんでした。通信状態を確認してください。";
      container.textContent = message;
      requireTurnstileConfirmation(message);
    });
}

function loadTurnstileApi(): Promise<TurnstileApi> {
  const existing = turnstileApi();
  if (existing !== undefined) return Promise.resolve(existing);
  if (turnstileLoadPromise !== undefined) return turnstileLoadPromise;
  turnstileLoadPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = window.document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      const api = turnstileApi();
      if (api === undefined) reject(new Error("Turnstile API is unavailable"));
      else resolve(api);
    });
    script.addEventListener("error", () => reject(new Error("Turnstile could not be loaded")));
    window.document.head.append(script);
  });
  return turnstileLoadPromise;
}

function setupStandingsTurnstile(): void {
  if (standingsTurnstileSetupStarted) return;
  standingsTurnstileSetupStarted = true;
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#standings-turnstile-widget");
  if (!siteKey) {
    container.textContent = "安全確認の設定が完了していないため、順位を確定できません。";
    standingsStatus.textContent =
      "安全確認の設定が完了していないため、順位を確定できません。";
    return;
  }
  void loadTurnstileApi()
    .then((api) => {
      try {
        container.replaceChildren();
        standingsTurnstileWidgetId = api.render(container, {
          sitekey: siteKey,
          action: "calculate_standings",
          callback: (token) => {
            standingsTurnstileToken = token;
            if (standingsStatusOwner === "turnstile") {
              standingsStatus.textContent =
                token.length > 0
                  ? "安全確認が完了しました。"
                  : "安全確認を完了できませんでした。もう一度お試しください。";
            }
            refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
          },
          "expired-callback": () => {
            standingsTurnstileToken = "";
            refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
            if (standingsStatusOwner === "turnstile") {
              standingsStatus.textContent =
                "安全確認の期限が切れました。もう一度確認してください。";
            }
          },
          "error-callback": () => {
            standingsTurnstileToken = "";
            refreshLeagueResultsProgress(orderedLeagueMatches([]).length);
            if (standingsStatusOwner === "turnstile") {
              standingsStatus.textContent =
                "安全確認を完了できませんでした。通信状態を確認してください。";
            }
          },
        });
      } catch {
        container.textContent =
          "安全確認を初期化できませんでした。画面を再読み込みしてください。";
      }
    })
    .catch((error: unknown) => {
      const initialized =
        error instanceof Error && error.message === "Turnstile API is unavailable";
      container.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。通信状態を確認してください。";
      standingsStatus.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。入力はこの端末に保存されています。";
    });
}

function setupTournamentTurnstile(): void {
  if (tournamentTurnstileSetupStarted) return;
  tournamentTurnstileSetupStarted = true;
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#tournament-turnstile-widget");
  if (!siteKey) {
    container.textContent =
      "安全確認の設定が完了していないため、トーナメントを作成できません。";
    tournamentStatus.textContent = container.textContent;
    return;
  }
  void loadTurnstileApi()
    .then((api) => {
      try {
        container.replaceChildren();
        tournamentTurnstileWidgetId = api.render(container, {
          sitekey: siteKey,
          action: "generate_tournament",
          callback: (token) => {
            tournamentTurnstileToken = token;
            refreshTournamentEnabled();
            if (tournamentStatusOwner === "turnstile") {
              tournamentStatus.textContent =
                token.length > 0
                  ? "安全確認が完了しました。"
                  : "安全確認を完了できませんでした。もう一度お試しください。";
            }
          },
          "expired-callback": () => {
            tournamentTurnstileToken = "";
            refreshTournamentEnabled();
            if (tournamentStatusOwner === "turnstile") {
              tournamentStatus.textContent =
                "安全確認の期限が切れました。もう一度確認してください。";
            }
          },
          "error-callback": () => {
            tournamentTurnstileToken = "";
            refreshTournamentEnabled();
            if (tournamentStatusOwner === "turnstile") {
              tournamentStatus.textContent =
                "安全確認を完了できませんでした。通信状態を確認してください。";
            }
          },
        });
      } catch {
        container.textContent =
          "安全確認を初期化できませんでした。画面を再読み込みしてください。";
      }
    })
    .catch((error: unknown) => {
      const initialized =
        error instanceof Error && error.message === "Turnstile API is unavailable";
      container.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。通信状態を確認してください。";
      tournamentStatus.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。確定順位はこの端末に保存されています。";
    });
}

function inferOrganizerCapacityTouched(): boolean {
  const input = documentState.tournament.input;
  const referees = asObject(input.referees);
  const capacity = referees?.organizer_capacity;
  const courtCount = asObjectArray(input.courts).length;
  return typeof capacity === "number" && capacity !== Math.max(1, courtCount);
}

setupPwaUpdates(registerSW, {
  confirmRefresh: () =>
    window.confirm("新しい版を利用できます。入力を保存して画面を更新しますか？"),
  onOfflineReady: () => {
    backupStatus.textContent =
      "オフラインでも保存済みの内容を確認できる準備が整いました。";
  },
});

void storage
  .loadLatest()
  .then((saved) => {
    const mode = normalizeDocument(saved ?? createTournamentDocument());
    documentState = mode.document;
    legacyCompatibility = mode.legacyCompatibility;
    organizerCapacityTouched = inferOrganizerCapacityTouched();
    currentStep = documentState.tournament.result === undefined ? 1 : 4;
    render();
    if (mode.migrated) {
      void storage.saveDraft(documentState);
      saveState.textContent = "以前の下書きを新しい形式へ移行しました";
    } else {
      saveState.textContent = saved === undefined ? "新しい大会" : "この端末の保存内容を復元しました";
    }
  })
  .catch(() => {
    render();
    saveState.textContent = "保存内容を読み込めませんでした";
    backupStatus.textContent =
      "JSONファイルのバックアップがある場合は「ファイルから復元」をお試しください。";
  });
