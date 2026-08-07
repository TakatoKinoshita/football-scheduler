import { registerSW } from "virtual:pwa-register";

import {
  calculateTournamentStandings,
  calculateLeagueStandings,
  generateDay2Schedule,
  generateSchedule,
  generateTournamentPlan,
  ScheduleApiError,
} from "./api";
import {
  buildDay1ScheduleRequest,
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
import {
  bindDay2ScheduleParticipants,
  day2ParticipantResolution,
  unbindDay2ScheduleParticipants,
} from "./day2-resolution";
import { setupPwaUpdates } from "./pwa-update";
import {
  buildSchedulePresentation,
  loadScheduleViewMode,
  saveScheduleViewMode,
  type SchedulePresentation,
  type SchedulePresentationRow,
  type ScheduleViewMode,
} from "./schedule-presentation";
import { AutosaveController, TournamentStorage } from "./storage";
import {
  bindTournamentParticipants,
  tournamentParticipantResolution,
  unbindTournamentParticipants,
} from "./tournament-resolution";
import {
  applyTournamentResultChange,
  overallTournamentRank,
  overallTournamentRankRange,
  resolveTournamentProgress,
  tournamentMatchDescendants,
  type TournamentMatchProgress,
} from "./tournament-results";
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
      <strong>1日目の日程から、順位確定前でも2日目の仮トーナメント・仮日程・審判まで作成できます。</strong>
      リーグ順位の確定後は、2日目の試合結果を入力して総合最終順位まで確定できます。
    </div>
    <div id="legacy-banner" class="notice no-print" role="note" hidden>
      従来形式の大会データを互換モードで開いています。内容を壊さないため大会設定は変更できませんが、日程の再生成と保存・印刷は利用できます。
    </div>

    <nav class="steps no-print" aria-label="作成手順">
      <button class="step" type="button" data-step="1"><b>1</b><span>大会・チーム</span></button>
      <button class="step" type="button" data-step="2"><b>2</b><span>ブロック・会場</span></button>
      <button class="step" type="button" data-step="3"><b>3</b><span>1日目設定</span></button>
      <button class="step" type="button" data-step="4"><b>4</b><span>1日目</span></button>
      <button class="step" type="button" data-step="5"><b>5</b><span>2日目</span></button>
    </nav>

    <section class="panel wizard-panel no-print" data-panel="1" aria-labelledby="step1-heading">
      <div class="section-heading">
        <div>
          <p class="section-number">手順 1 / 5</p>
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
          <p class="section-number">手順 2 / 5</p>
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
          <p class="section-number">手順 3 / 5</p>
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

    <section id="day1-results-panel" class="panel results day-result" data-panel="4" aria-labelledby="results-heading" hidden>
      <div class="section-heading">
        <div>
          <p class="section-number">手順 4 / 5</p>
          <h2 id="results-heading">1日目の日程とリーグ結果</h2>
          <p id="result-summary">まだ生成結果はありません。</p>
        </div>
        <button id="print" class="secondary no-print" type="button" disabled>1日目を印刷</button>
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
      <div id="go-day2-area" class="next-day-callout no-print" hidden>
        <div>
          <h3>2日目の準備へ進めます</h3>
          <p>順位未確定でも仮トーナメントを作成でき、確定後はチーム名を反映します。</p>
        </div>
        <button id="go-day2" class="primary" type="button">2日目へ進む</button>
      </div>
      <div class="wizard-actions no-print">
        <button id="step4-back" class="secondary" type="button">設定へ戻る</button>
        <span></span>
      </div>
    </section>

    <section id="day2-results-panel" class="panel results day-result" data-panel="5" aria-labelledby="day2-results-heading" hidden>
      <div class="section-heading">
        <div>
          <p class="section-number">手順 5 / 5</p>
          <h2 id="day2-results-heading">2日目のトーナメントと日程</h2>
          <p id="day2-result-summary">1日目の日程を作成すると、仮トーナメントを作成できます。</p>
        </div>
        <button id="print-day2" class="secondary no-print" type="button" disabled>2日目を印刷</button>
      </div>
      <div id="day2-result-content" class="result-content empty">
        1日目タブで日程を作成してください。
      </div>
      <div id="tournament-confirmation" class="standings-confirmation no-print" hidden>
        <h3>2日目トーナメントを作成する</h3>
        <p id="tournament-review">リーグ順位枠を確認しています。</p>
        <div id="tournament-turnstile-widget" class="turnstile-box" aria-label="トーナメント作成の安全確認">
          安全確認を読み込んでいます。
        </div>
        <button id="generate-tournament" class="primary" type="button" disabled>2日目トーナメントを作成する</button>
        <p id="tournament-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div id="day2-confirmation" class="standings-confirmation no-print" hidden>
        <h3>2日目日程を作成する</h3>
        <p>1日目の日程と確定済みトーナメント表は変更しません。</p>
        <div class="form-grid three-columns">
          <label class="field" for="day2-start-time">
            <span>開始時刻</span>
            <input id="day2-start-time" type="time" step="60" value="09:30" />
          </label>
          <label class="field" for="day2-game-duration">
            <span>1試合の時間（分）</span>
            <input id="day2-game-duration" type="number" min="1" max="240" inputmode="numeric" value="35" />
          </label>
          <label class="field" for="day2-margin-minutes">
            <span>試合間隔（分）</span>
            <input id="day2-margin-minutes" type="number" min="0" max="240" inputmode="numeric" value="10" />
          </label>
        </div>
        <details class="advanced-settings">
          <summary>2日目の詳細設定を表示</summary>
          <div class="form-grid">
            <label class="field" for="day2-end-time">
              <span>終了時刻 <small>任意</small></span>
              <input id="day2-end-time" type="time" step="60" />
            </label>
            <label class="field" for="day2-max-sections">
              <span>最大セクション数 <small>任意</small></span>
              <input id="day2-max-sections" type="number" min="1" max="128" inputmode="numeric" />
            </label>
            <label class="field" for="day2-fallback">
              <span>審判を確保できない場合</span>
              <select id="day2-fallback">
                <option value="organizer">主催者審判へ切り替える</option>
                <option value="strict">配置を組み直し、切替を許可しない</option>
              </select>
            </label>
            <label class="field field-wide" for="day2-breaks">
              <span>休憩 <small>任意・1行に「セクション:分」</small></span>
              <textarea id="day2-breaks" rows="3" placeholder="例：&#10;4:60"></textarea>
            </label>
          </div>
        </details>
        <p id="day2-review">2日目設定を確認しています。</p>
        <div id="day2-turnstile-widget" class="turnstile-box" aria-label="2日目日程作成の安全確認">
          安全確認を読み込んでいます。
        </div>
        <button id="generate-day2" class="primary" type="button" disabled>2日目の日程を作成する</button>
        <p id="day2-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div id="tournament-results-confirmation" class="standings-confirmation no-print" hidden>
        <h3>総合最終順位を確定する</h3>
        <p id="tournament-results-progress">2日目の試合結果を確認しています。</p>
        <div id="tournament-results-turnstile-widget" class="turnstile-box" aria-label="最終順位確定の安全確認">
          安全確認を読み込んでいます。
        </div>
        <button id="confirm-tournament-results" class="primary" type="button" disabled>総合最終順位を確定する</button>
        <p id="tournament-results-status" class="status-message" role="status" aria-live="polite"></p>
      </div>
      <div class="wizard-actions no-print">
        <button id="step5-back" class="secondary" type="button">1日目へ戻る</button>
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

function restoredWizardStep(document: TournamentDocument): WizardStep {
  const result = asObject(document.tournament.result);
  if (result === undefined) return 1;
  return asObject(result.tournament_plan) !== undefined ||
    asObject(result.day2_schedule) !== undefined
    ? 5
    : 4;
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

type WebScheduleSlot = JsonObject & {
  section_no: number;
  court_id: string;
  match_id: string | null;
};

function scheduleSlots(value: unknown): WebScheduleSlot[] {
  return asObjectArray(value).filter(
    (slot): slot is WebScheduleSlot =>
      Number.isInteger(slot.section_no) &&
      Number(slot.section_no) > 0 &&
      typeof slot.court_id === "string" &&
      (typeof slot.match_id === "string" || slot.match_id === null),
  );
}

function buildWebSchedulePresentation(
  dayId: "day1" | "day2",
  schedule: JsonObject,
): SchedulePresentation<WebScheduleSlot> {
  const settings = asObject(
    dayId === "day1"
      ? documentState.tournament.input.day
      : documentState.tournament.input.day2,
  );
  return buildSchedulePresentation({
    dayId,
    courts: asObjectArray(documentState.tournament.input.courts)
      .filter(
        (court): court is JsonObject & { id: string; name: string } =>
          typeof court.id === "string" && typeof court.name === "string",
      )
      .map((court) => ({ id: court.id, name: court.name })),
    slots: scheduleSlots(schedule.slots),
    sectionTimings: asObjectArray(schedule.section_timings)
      .filter(
        (timing) => Number.isInteger(timing.section_no) && Number(timing.section_no) > 0,
      )
      .map((timing) => ({
        section_no: Number(timing.section_no),
        start_time: typeof timing.start_time === "string" ? timing.start_time : null,
        match_end: typeof timing.match_end_time === "string" ? timing.match_end_time : null,
      })),
    daySettings: {
      start_time: typeof settings?.start_time === "string" ? settings.start_time : null,
      game_duration_minutes:
        typeof settings?.game_duration_minutes === "number"
          ? settings.game_duration_minutes
          : null,
      margin_minutes:
        typeof settings?.margin_minutes === "number" ? settings.margin_minutes : null,
      breaks: asObjectArray(settings?.breaks)
        .filter(
          (item) =>
            Number.isInteger(item.after_section) &&
            Number(item.after_section) > 0 &&
            Number.isInteger(item.duration_minutes) &&
            Number(item.duration_minutes) >= 0,
        )
        .map((item) => ({
          after_section: Number(item.after_section),
          duration_minutes: Number(item.duration_minutes),
        })),
    },
  });
}

function appendMatchDisplayNumber(
  parent: HTMLElement,
  matchId: string,
  displayNumber: string,
): HTMLElement {
  const badge = appendTextElement(parent, "span", displayNumber, "match-display-number");
  badge.dataset.matchId = matchId;
  badge.dataset.displayNumber = displayNumber;
  badge.setAttribute("aria-label", `試合番号 ${displayNumber}`);
  return badge;
}

function createScheduleViewToggle(
  dayId: "day1" | "day2",
  mode: ScheduleViewMode,
  onChange: (mode: ScheduleViewMode) => void,
): HTMLFieldSetElement {
  const fieldset = window.document.createElement("fieldset");
  fieldset.id = `${dayId}-schedule-view-toggle`;
  fieldset.className = "schedule-view-toggle no-print";
  appendTextElement(fieldset, "legend", "日程の表示");
  for (const [value, label] of [
    ["time", "時間順"],
    ["court", "コート別"],
  ] as const) {
    const wrapper = window.document.createElement("label");
    const input = window.document.createElement("input");
    input.type = "radio";
    input.name = `${dayId}-schedule-view`;
    input.value = value;
    input.checked = mode === value;
    input.addEventListener("change", () => {
      if (input.checked) onChange(value);
    });
    wrapper.append(input, window.document.createTextNode(label));
    fieldset.append(wrapper);
  }
  return fieldset;
}

const storage = new TournamentStorage();
const autosave = new AutosaveController((value) => storage.saveDraft(value));
let documentState = createTournamentDocument();
let currentStep: WizardStep = 1;
let day1ScheduleViewMode = loadScheduleViewMode("day1");
let day2ScheduleViewMode = loadScheduleViewMode("day2");
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
let day2TurnstileToken = "";
let day2TurnstileWidgetId: string | undefined;
let day2TurnstileSetupStarted = false;
let tournamentResultsTurnstileToken = "";
let tournamentResultsTurnstileWidgetId: string | undefined;
let tournamentResultsTurnstileSetupStarted = false;
let turnstileLoadPromise: Promise<TurnstileApi> | undefined;
let standingsStatusOwner: "turnstile" | "calculation" = "turnstile";
let tournamentStatusOwner: "turnstile" | "generation" = "turnstile";
let day2StatusOwner: "turnstile" | "generation" = "turnstile";
let tournamentResultsStatusOwner: "turnstile" | "calculation" = "turnstile";
let generationStatusOwner: "turnstile" | "generation" = "turnstile";
const tournamentResultDrafts = new Map<
  string,
  {
    regularHome: string;
    regularAway: string;
    penaltyHome: string;
    penaltyAway: string;
  }
>();

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
const day2PrintButton = requiredElement<HTMLButtonElement>("#print-day2");
const goDay2Area = requiredElement<HTMLElement>("#go-day2-area");
const standingsConfirmation = requiredElement<HTMLElement>("#standings-confirmation");
const leagueResultsProgress = requiredElement<HTMLElement>("#league-results-progress");
const standingsStatus = requiredElement<HTMLElement>("#standings-status");
const standingsButton = requiredElement<HTMLButtonElement>("#confirm-standings");
const tournamentConfirmation = requiredElement<HTMLElement>("#tournament-confirmation");
const tournamentReview = requiredElement<HTMLElement>("#tournament-review");
const tournamentStatus = requiredElement<HTMLElement>("#tournament-status");
const tournamentButton = requiredElement<HTMLButtonElement>("#generate-tournament");
const day2Confirmation = requiredElement<HTMLElement>("#day2-confirmation");
const day2StartTimeInput = requiredElement<HTMLInputElement>("#day2-start-time");
const day2GameDurationInput = requiredElement<HTMLInputElement>("#day2-game-duration");
const day2MarginInput = requiredElement<HTMLInputElement>("#day2-margin-minutes");
const day2EndTimeInput = requiredElement<HTMLInputElement>("#day2-end-time");
const day2MaxSectionsInput = requiredElement<HTMLInputElement>("#day2-max-sections");
const day2FallbackInput = requiredElement<HTMLSelectElement>("#day2-fallback");
const day2BreaksInput = requiredElement<HTMLTextAreaElement>("#day2-breaks");
const day2Review = requiredElement<HTMLElement>("#day2-review");
const day2Status = requiredElement<HTMLElement>("#day2-status");
const day2Button = requiredElement<HTMLButtonElement>("#generate-day2");
const tournamentResultsConfirmation = requiredElement<HTMLElement>(
  "#tournament-results-confirmation",
);
const tournamentResultsProgress = requiredElement<HTMLElement>("#tournament-results-progress");
const tournamentResultsStatus = requiredElement<HTMLElement>("#tournament-results-status");
const tournamentResultsButton = requiredElement<HTMLButtonElement>(
  "#confirm-tournament-results",
);

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

function namedInputsWithStableIds(
  existingValue: unknown,
  names: readonly string[],
  prefix: "team" | "court",
): Array<{ id: string; name: string }> {
  const existing = asObjectArray(existingValue);
  const used = new Set<string>();
  return names.map((name, index) => {
    const existingId = existing[index]?.id;
    let id = typeof existingId === "string" && existingId.length > 0 && !used.has(existingId)
      ? existingId
      : "";
    if (id === "") {
      let candidateNumber = index + 1;
      do {
        id = `${prefix}-${String(candidateNumber).padStart(2, "0")}`;
        candidateNumber += 1;
      } while (used.has(id));
    }
    used.add(id);
    return { id, name };
  });
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

function day2SectionLabel(sectionNumber: number, schedule: JsonObject): string {
  const timing = asObjectArray(schedule.section_timings).find(
    (item) => Number(item.section_no) === sectionNumber,
  );
  const start = typeof timing?.start_time === "string" ? timing.start_time.slice(0, 5) : undefined;
  return start === undefined
    ? `第${sectionNumber}セクション`
    : `第${sectionNumber}・${start}`;
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

function tournamentResults(): JsonObject[] {
  return asObjectArray(documentState.tournament.result?.tournament_results);
}

function saveLeagueResults(results: JsonObject[], standings?: JsonObject): boolean {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return false;
  const hadStandings = asObject(result.league_standings) !== undefined;
  const existingStandings = asObject(result.league_standings);
  const existingDay2 = asObject(result.day2_schedule);
  const hadResolvedDay2 =
    existingDay2 !== undefined && day2ParticipantResolution(existingDay2) === "resolved";
  const existingPlan = asObject(result.tournament_plan);
  const hadResolvedTournament =
    existingPlan !== undefined && tournamentParticipantResolution(existingPlan) === "resolved";
  const nextResult: JsonObject = { ...result, league_results: results };
  if (standings === undefined) {
    tournamentResultDrafts.clear();
    delete nextResult.league_standings;
    delete nextResult.tournament_results;
    delete nextResult.final_standings;
    if (existingPlan !== undefined) {
      nextResult.tournament_plan =
        tournamentParticipantResolution(existingPlan) === "resolved"
          ? unbindTournamentParticipants(existingPlan)
          : existingPlan;
    }
    if (existingDay2 !== undefined) {
      nextResult.day2_schedule =
        day2ParticipantResolution(existingDay2) === "resolved"
          ? unbindDay2ScheduleParticipants(existingDay2, existingStandings)
          : existingDay2;
    }
  } else {
    nextResult.league_standings = standings;
    if (existingPlan !== undefined) {
      nextResult.tournament_plan = bindTournamentParticipants(existingPlan, standings);
    }
    if (existingDay2 !== undefined) {
      nextResult.day2_schedule = bindDay2ScheduleParticipants(existingDay2, standings);
    }
  }
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
  return hadStandings || hadResolvedTournament || hadResolvedDay2;
}

function saveTournamentPlan(plan: JsonObject): void {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return;
  tournamentResultDrafts.clear();
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      result: {
        ...result,
        tournament_plan: plan,
        day2_schedule: undefined,
        integrated_validation: undefined,
        tournament_results: undefined,
        final_standings: undefined,
      },
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

function parseDay2Breaks(): JsonObject[] | undefined {
  const parsed: JsonObject[] = [];
  const seen = new Set<number>();
  for (const line of lines(day2BreaksInput.value)) {
    const match = /^(\d+)\s*:\s*(\d+)$/.exec(line);
    if (match === null) return undefined;
    const afterSection = Number(match[1]);
    const duration = Number(match[2]);
    if (afterSection < 1 || duration < 1 || seen.has(afterSection)) return undefined;
    seen.add(afterSection);
    parsed.push({ after_section: afterSection, duration_minutes: duration });
  }
  return parsed;
}

function currentDay2Settings(): JsonObject | undefined {
  const duration = inputNumber(day2GameDurationInput);
  const margin = inputNumber(day2MarginInput);
  const maxSections = inputNumber(day2MaxSectionsInput);
  const breaks = parseDay2Breaks();
  if (
    day2StartTimeInput.value === "" ||
    duration === null ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    margin === null ||
    !Number.isInteger(margin) ||
    margin < 0 ||
    (maxSections !== null && (!Number.isInteger(maxSections) || maxSections < 1)) ||
    breaks === undefined
  ) {
    return undefined;
  }
  return {
    id: "day2",
    start_time: day2StartTimeInput.value,
    game_duration_minutes: duration,
    margin_minutes: margin,
    max_sections: maxSections,
    end_time: day2EndTimeInput.value || null,
    breaks,
  };
}

function saveDay2Settings(): void {
  const day2 = currentDay2Settings();
  if (day2 === undefined) {
    day2Status.textContent =
      "2日目設定を確認してください。休憩は「4:60」のように入力します。";
    day2Button.disabled = true;
    return;
  }
  const result = asObject(documentState.tournament.result);
  const nextResult = result === undefined ? undefined : { ...result };
  if (nextResult !== undefined) {
    delete nextResult.day2_schedule;
    delete nextResult.integrated_validation;
  }
  const referees = asObject(documentState.tournament.input.referees) ?? {};
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      input: {
        ...documentState.tournament.input,
        day2,
        referees: { ...referees, tournament_fallback: day2FallbackInput.value },
      },
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
      day2Status.textContent = "2日目設定を保存できませんでした。ファイルへ保存してください。";
    },
  );
  if (nextResult !== undefined) {
    const tournamentPlan = asObject(nextResult.tournament_plan);
    if (tournamentPlan !== undefined) {
      renderDay2Preparation(
        nextResult,
        requiredElement<HTMLElement>("#day2-result-content"),
        requiredElement<HTMLElement>("#day2-result-summary"),
        asObject(nextResult.league_standings),
        tournamentPlan,
        idNameMap("teams"),
        idNameMap("courts"),
      );
    }
  }
  day2StatusOwner = "generation";
  day2Status.textContent =
    "2日目設定を変更したため、以前の日程を取り消しました。もう一度作成してください。";
  requiredElement<HTMLElement>("#day2-result-summary").textContent =
    "2日目設定が変更されました。日程をもう一度作成してください。";
  refreshDay2Enabled();
}

function saveDay2Schedule(schedule: JsonObject): void {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return;
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      result: {
        ...result,
        day2_schedule: schedule,
        integrated_validation: schedule.integrated_validation,
      },
    },
  };
  saveState.textContent = "保存しています…";
  autosave.schedule(
    documentState,
    () => {
      saveState.textContent = "この端末に保存済み";
    },
    () => {
      day2Status.textContent = "2日目日程を保存できませんでした。ファイルへ保存してください。";
    },
  );
}

function saveTournamentResults(results: JsonObject[]): void {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return;
  const nextResult: JsonObject = { ...result, tournament_results: results };
  delete nextResult.final_standings;
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
      tournamentResultsStatus.textContent =
        "2日目の試合結果を保存できませんでした。ファイルへ保存してください。";
    },
  );
}

async function saveFinalStandings(standings: JsonObject): Promise<void> {
  const result = asObject(documentState.tournament.result);
  if (result === undefined) return;
  documentState = {
    ...documentState,
    updatedAt: new Date().toISOString(),
    tournament: {
      ...documentState.tournament,
      result: { ...result, final_standings: standings },
    },
  };
  autosave.cancel();
  saveState.textContent = "保存しています…";
  try {
    await storage.saveDraft(documentState);
    saveState.textContent = "この端末に保存済み";
  } catch (error) {
    saveState.textContent = "保存できませんでした";
    tournamentResultsStatus.textContent =
      "総合最終順位を保存できませんでした。ファイルへ保存してください。";
    throw error;
  }
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
  const hasLeaguePlan = asObject(result?.league_plan) !== undefined;
  tournamentButton.disabled =
    !hasLeaguePlan || !navigator.onLine || tournamentTurnstileToken.length === 0;
}

function refreshDay2Enabled(): void {
  const result = asObject(documentState.tournament.result);
  const tournamentPlan = asObject(result?.tournament_plan);
  const hasTournament = tournamentPlan !== undefined;
  const provisional =
    tournamentPlan !== undefined && tournamentParticipantResolution(tournamentPlan) === "provisional";
  const settings = currentDay2Settings();
  day2Review.textContent =
    !hasTournament
      ? "先に2日目トーナメントを作成してください。"
      : settings === undefined
      ? "2日目設定に入力誤りがあります。休憩は「4:60」の形式で入力してください。"
      : `${provisional ? "仮日程／" : ""}${String(settings.start_time)}開始／1試合${String(settings.game_duration_minutes)}分／間隔${String(settings.margin_minutes)}分／${day2FallbackInput.value === "strict" ? "主催者切替なし" : "必要時は主催者へ切替"}`;
  day2Button.disabled =
    !hasTournament ||
    settings === undefined ||
    !navigator.onLine ||
    day2TurnstileToken.length === 0;
}

function refreshTournamentResultsEnabled(): void {
  const result = asObject(documentState.tournament.result);
  const plan = asObject(result?.tournament_plan);
  let enteredCount = 0;
  let totalCount = 0;
  let complete = false;
  if (plan !== undefined && tournamentParticipantResolution(plan) === "resolved") {
    try {
      const progress = resolveTournamentProgress(plan, tournamentResults());
      enteredCount = progress.orderedMatches.filter((match) => match.result !== undefined).length;
      totalCount = progress.orderedMatches.length;
      complete = progress.complete;
    } catch {
      complete = false;
    }
  }
  tournamentResultsProgress.textContent = `入力済み ${enteredCount} / ${totalCount}試合`;
  tournamentResultsButton.disabled =
    plan === undefined ||
    !complete ||
    !navigator.onLine ||
    tournamentResultsTurnstileToken.length === 0;
}

interface ScheduleRowDetails {
  matchup: string;
  referee: string;
  phase?: string;
}

function appendScheduleTable(
  parent: HTMLElement,
  rows: readonly SchedulePresentationRow<WebScheduleSlot>[],
  options: {
    tableLabel: string;
    showCourt: boolean;
    showPhase: boolean;
    details: (row: SchedulePresentationRow<WebScheduleSlot>) => ScheduleRowDetails;
  },
): void {
  const wrapper = window.document.createElement("div");
  wrapper.className = "table-wrap schedule-table-wrap";
  const table = window.document.createElement("table");
  table.className = "schedule-table";
  table.setAttribute("aria-label", options.tableLabel);
  const head = window.document.createElement("thead");
  const heading = window.document.createElement("tr");
  const labels = ["試合", "セクション", "時間"];
  if (options.showCourt) labels.push("コート");
  if (options.showPhase) labels.push("区分");
  labels.push("対戦", "審判");
  for (const label of labels) appendTextElement(heading, "th", label);
  head.append(heading);
  table.append(head);
  const body = window.document.createElement("tbody");
  for (const row of rows) {
    const details = options.details(row);
    const tableRow = window.document.createElement("tr");
    tableRow.dataset.matchId = row.matchId;
    const numberCell = window.document.createElement("td");
    appendMatchDisplayNumber(numberCell, row.matchId, row.displayNumber);
    tableRow.append(numberCell);
    appendTextElement(tableRow, "td", `第${row.sectionNo}`);
    appendTextElement(tableRow, "td", row.timeLabel);
    if (options.showCourt) appendTextElement(tableRow, "td", row.courtName);
    if (options.showPhase) appendTextElement(tableRow, "td", details.phase ?? "-");
    appendTextElement(tableRow, "td", details.matchup);
    appendTextElement(tableRow, "td", details.referee);
    body.append(tableRow);
  }
  table.append(body);
  wrapper.append(table);
  parent.append(wrapper);
}

function renderScheduleView(
  container: HTMLElement,
  presentation: SchedulePresentation<WebScheduleSlot>,
  mode: ScheduleViewMode,
  options: {
    showPhase: boolean;
    details: (row: SchedulePresentationRow<WebScheduleSlot>) => ScheduleRowDetails;
  },
): void {
  container.replaceChildren();
  container.dataset.scheduleView = mode;
  if (mode === "time") {
    appendScheduleTable(container, presentation.timeRows, {
      tableLabel: "時間順の日程",
      showCourt: true,
      showPhase: options.showPhase,
      details: options.details,
    });
    return;
  }
  const grid = window.document.createElement("div");
  grid.className = "court-schedule-grid";
  for (const group of presentation.courtGroups) {
    const card = window.document.createElement("section");
    card.className = "court-schedule-card";
    card.dataset.courtId = group.court.id;
    appendTextElement(card, "h4", `${group.courtCode}：${group.court.name}`);
    if (group.rows.length === 0) {
      appendTextElement(card, "p", "このコートに配置された試合はありません。", "muted");
    } else {
      appendScheduleTable(card, group.rows, {
        tableLabel: `${group.court.name}の日程`,
        showCourt: false,
        showPhase: options.showPhase,
        details: options.details,
      });
    }
    grid.append(card);
  }
  container.append(grid);
}

function renderResult(): void {
  const summary = requiredElement<HTMLElement>("#result-summary");
  const content = requiredElement<HTMLElement>("#result-content");
  const day2Summary = requiredElement<HTMLElement>("#day2-result-summary");
  const day2Content = requiredElement<HTMLElement>("#day2-result-content");
  const result = documentState.tournament.result;
  tournamentConfirmation.hidden = true;
  day2Confirmation.hidden = true;
  tournamentResultsConfirmation.hidden = true;
  goDay2Area.hidden = true;
  day2PrintButton.disabled = true;
  if (result === undefined) {
    summary.textContent = "まだ生成結果はありません。";
    content.textContent =
      "日程を生成すると、ブロック分け、日程表、チーム別予定をここで確認できます。";
    content.classList.add("empty");
    day2Summary.textContent = "1日目の日程を作成すると、仮トーナメントを作成できます。";
    day2Content.textContent =
      "1日目タブで日程を作成してください。";
    day2Content.classList.add("empty");
    standingsConfirmation.hidden = true;
    printButton.disabled = true;
    return;
  }

  const schedulePresentation = buildWebSchedulePresentation("day1", result);
  const slots = schedulePresentation.timeRows.map((row) => row.slot);
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
  day2Content.replaceChildren();
  day2Content.classList.add("empty");
  day2Content.textContent =
    "順位未確定でも、ブロック順位枠から仮トーナメントを作成できます。";
  day2Summary.textContent = "1日目の日程から2日目の仮トーナメントを作成できます。";

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
  goDay2Area.hidden = blocks.length === 0;

  appendTextElement(content, "h3", "1日目の日程表");
  const day1ScheduleContainer = window.document.createElement("div");
  day1ScheduleContainer.id = "day1-schedule-view";
  day1ScheduleContainer.className = "schedule-view-content";
  const teamSchedules = new Map<string, string[]>();
  for (const teamId of teamNames.keys()) teamSchedules.set(teamId, []);
  const day1Details = (
    presentationRow: SchedulePresentationRow<WebScheduleSlot>,
  ): ScheduleRowDetails => {
    const slot = presentationRow.slot;
    const match = matches.get(presentationRow.matchId);
    const homeId = exactTeamId(match, "home");
    const awayId = exactTeamId(match, "away");
    const homeName =
      homeId === undefined
        ? "前の試合結果で決定"
        : (teamNames.get(homeId) ?? "名称未設定");
    const awayName =
      awayId === undefined
        ? "前の試合結果で決定"
        : (teamNames.get(awayId) ?? "名称未設定");
    const assignment = asObject(slot.referee_assignment);
    const kind = assignment?.kind ?? assignment?.type;
    const refereeTeamId =
      typeof assignment?.team_id === "string" ? assignment.team_id : undefined;
    const refereeName =
      kind === "organizer"
        ? "主催者"
        : refereeTeamId === undefined
          ? "確認中"
          : (teamNames.get(refereeTeamId) ?? "名称未設定");
    return { matchup: `${homeName} 対 ${awayName}`, referee: refereeName };
  };
  for (const presentationRow of schedulePresentation.timeRows) {
    const slot = presentationRow.slot;
    const match = matches.get(presentationRow.matchId);
    const homeId = exactTeamId(match, "home");
    const awayId = exactTeamId(match, "away");
    const homeName =
      homeId === undefined ? "前の試合結果で決定" : (teamNames.get(homeId) ?? "名称未設定");
    const awayName =
      awayId === undefined ? "前の試合結果で決定" : (teamNames.get(awayId) ?? "名称未設定");
    const assignment = asObject(slot.referee_assignment);
    const refereeTeamId =
      typeof assignment?.team_id === "string" ? assignment.team_id : undefined;
    if (homeId !== undefined) {
      teamSchedules
        .get(homeId)
        ?.push(`${presentationRow.timeLabel}　${presentationRow.courtName}　対 ${awayName}`);
    }
    if (awayId !== undefined) {
      teamSchedules
        .get(awayId)
        ?.push(`${presentationRow.timeLabel}　${presentationRow.courtName}　対 ${homeName}`);
    }
    if (refereeTeamId !== undefined) {
      teamSchedules
        .get(refereeTeamId)
        ?.push(`${presentationRow.timeLabel}　${presentationRow.courtName}　審判`);
    }
  }
  const renderDay1Schedule = (): void => {
    renderScheduleView(
      day1ScheduleContainer,
      schedulePresentation,
      day1ScheduleViewMode,
      { showPhase: false, details: day1Details },
    );
  };
  content.append(
    createScheduleViewToggle("day1", day1ScheduleViewMode, (mode) => {
      day1ScheduleViewMode = mode;
      saveScheduleViewMode("day1", mode);
      renderDay1Schedule();
    }),
    day1ScheduleContainer,
  );
  renderDay1Schedule();

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
      const scheduledRow = schedulePresentation.timeRows.find((item) => item.matchId === matchId);
      const row = window.document.createElement("tr");
      appendTextElement(
        row,
        "td",
        scheduledRow === undefined
          ? "未配置"
          : scheduledRow.timeLabel,
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
          document.querySelector("#league-standings-view")?.remove();
          const updatedResult = asObject(documentState.tournament.result);
          if (updatedResult !== undefined) {
            renderDay2Preparation(
              updatedResult,
              day2Content,
              day2Summary,
              undefined,
              asObject(updatedResult.tournament_plan),
              teamNames,
              courtNames,
            );
          }
          standingsStatusOwner = "calculation";
          standingsStatus.textContent =
            "得点を変更したため、確定順位を取り消しました。2日目は順位枠の仮トーナメントへ戻しました。";
          day2Summary.textContent =
            "得点が変更されました。仮トーナメントと仮日程を保持し、確定チーム名だけを外しました。";
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
    if (standings !== undefined) {
      renderLeagueStandings(content, standings, teamNames);
    }
    const tournamentPlan = asObject(result.tournament_plan);
    renderDay2Preparation(
      result,
      day2Content,
      day2Summary,
      standings,
      tournamentPlan,
      teamNames,
      courtNames,
    );
  }

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

function renderDay2StandingsSummary(
  content: HTMLElement,
  standings: JsonObject,
  teamNames: Map<string, string>,
): void {
  const section = window.document.createElement("section");
  section.id = "day2-standings-summary";
  appendTextElement(section, "h3", "1日目の確定順位");
  appendTextElement(
    section,
    "p",
    "この順位を順位枠へ対応させます。得点を変更するとチーム名だけを外し、仮トーナメントの組合せは保持します。",
    "muted",
  );
  const grouped = new Map<string, JsonObject[]>();
  for (const row of asObjectArray(standings.standings)) {
    const blockId = String(row.block_id ?? "-");
    grouped.set(blockId, [...(grouped.get(blockId) ?? []), row]);
  }
  const grid = window.document.createElement("div");
  grid.className = "block-grid compact-standings";
  for (const [blockId, rows] of grouped) {
    const card = window.document.createElement("section");
    card.className = "block-card";
    appendTextElement(card, "h4", `${blockId}ブロック`);
    const list = window.document.createElement("ol");
    for (const row of rows.sort((left, right) => Number(left.rank) - Number(right.rank))) {
      appendTextElement(
        list,
        "li",
        teamNames.get(String(row.team_id)) ?? "名称未設定",
      );
    }
    card.append(list);
    grid.append(card);
  }
  section.append(grid);
  content.append(section);
}

function tournamentEntryLabel(
  value: unknown,
  rankedTeams: Map<string, string>,
  teamNames: Map<string, string>,
  displayNumberByMatchId?: ReadonlyMap<string, string>,
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
    return `${displayNumberByMatchId?.get(entry.match_id) ?? entry.match_id}の勝者`;
  }
  if (entry?.type === "loser_of" && typeof entry.match_id === "string") {
    return `${displayNumberByMatchId?.get(entry.match_id) ?? entry.match_id}の敗者`;
  }
  return "対戦結果で決定";
}

function renderTournamentPlan(
  content: HTMLElement,
  plan: JsonObject,
  standings: JsonObject | undefined,
  teamNames: Map<string, string>,
  displayNumberByMatchId?: ReadonlyMap<string, string>,
): void {
  const provisional = tournamentParticipantResolution(plan) === "provisional";
  const section = window.document.createElement("section");
  section.id = "tournament-plan-view";
  appendTextElement(
    section,
    "h3",
    provisional ? "【仮】2日目トーナメント組合せ" : "2日目トーナメント組合せ",
  );
  if (provisional) {
    appendTextElement(
      section,
      "p",
      "この表はリーグ順位枠で作成した仮トーナメントです。順位確定後も組合せと試合番号は変わりません。",
      "notice",
    );
  }
  appendTextElement(
    section,
    "p",
    "不戦通過は試合数に含めず、各トーナメントの1位から最下位までを決める表です。",
    "muted",
  );
  const rankedTeams = new Map(
    asObjectArray(standings?.standings)
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
      const rankLabel = `${String(seed.block_id)}ブロック ${String(seed.block_rank)}位`;
      const teamName =
        typeof seed.team_id === "string" ? teamNames.get(seed.team_id) : undefined;
      appendTextElement(
        seedList,
        "li",
        teamName === undefined ? rankLabel : `${teamName}（${rankLabel}）`,
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
          `${tournamentEntryLabel(bye.entry, rankedTeams, teamNames, displayNumberByMatchId)} → ${displayNumberByMatchId?.get(String(bye.next_match_id)) ?? String(bye.next_match_id)}`,
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
      const matchId = String(match.id ?? "-");
      const overallRange = overallTournamentRankRange(plan, field, match.rank_range);
      const rankRange = overallRange === undefined
        ? "-"
        : `${String(overallRange[0])}〜${String(overallRange[1])}位`;
      const roundLabel =
        field === "lower" && overallRange !== undefined
          ? overallRange[1] - overallRange[0] === 1
            ? `${String(overallRange[0])}位決定戦`
            : `${String(overallRange[0])}〜${String(overallRange[1])}位 順位決定`
          : String(match.round ?? "-");
      const numberCell = window.document.createElement("td");
      const displayNumber = displayNumberByMatchId?.get(matchId);
      if (displayNumber === undefined) {
        numberCell.textContent = matchId;
      } else {
        appendMatchDisplayNumber(numberCell, matchId, displayNumber);
      }
      row.append(numberCell);
      appendTextElement(row, "td", roundLabel);
      appendTextElement(
        row,
        "td",
        `${tournamentEntryLabel(match.home, rankedTeams, teamNames, displayNumberByMatchId)} 対 ${tournamentEntryLabel(match.away, rankedTeams, teamNames, displayNumberByMatchId)}`,
      );
      appendTextElement(row, "td", rankRange);
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
        `${String(overallTournamentRank(plan, field, Number(placement.rank)))}位：${tournamentEntryLabel(placement.entry, rankedTeams, teamNames, displayNumberByMatchId)}`,
      );
    }
    poolSection.append(placements);
    section.append(poolSection);
  }

  for (const draw of asObjectArray(plan.seed_draws)) {
    const concreteOrder = Array.isArray(draw.decided_order) ? draw.decided_order : [];
    const rankOrder = asObjectArray(draw.decided_rank_refs);
    const order =
      concreteOrder.length > 0
        ? concreteOrder.map((team) => teamNames.get(String(team)) ?? String(team)).join("、")
        : rankOrder
            .map((entry) => `${String(entry.block_id)}ブロック ${String(entry.rank)}位`)
            .join("、");
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

function renderDay2Schedule(
  content: HTMLElement,
  schedule: JsonObject,
  _plan: JsonObject,
  standings: JsonObject | undefined,
  teamNames: Map<string, string>,
  courtNames: Map<string, string>,
): void {
  const provisional = day2ParticipantResolution(schedule) === "provisional";
  const section = window.document.createElement("section");
  section.id = "day2-schedule-view";
  appendTextElement(
    section,
    "h3",
    provisional ? "【仮】2日目の日程・審判" : "2日目の日程・審判",
  );
  if (provisional) {
    appendTextElement(
      section,
      "p",
      "この日程はリーグ順位枠で作成した仮日程です。順位確定後も時刻・コート・試合番号・審判供給元は変わりません。",
      "notice",
    );
  }
  const validation = asObject(schedule.integrated_validation);
  if (validation?.valid === true) {
    appendTextElement(
      section,
      "p",
      "1日目と2日目を通した大会規則の独立チェックに合格しています。",
      "validation-ok",
    );
  }
  const endTime = typeof schedule.expected_end_time === "string"
    ? schedule.expected_end_time.slice(0, 5)
    : "未確定";
  const metrics = asObject(schedule.metrics);
  appendTextElement(
    section,
    "p",
    `使用 ${String(metrics?.used_sections ?? 0)}セクション／終了予定 ${endTime}／主催者審判 ${String(metrics?.organizer_referee_count ?? 0)}試合`,
    "muted",
  );
  const auditList = window.document.createElement("ul");
  auditList.className = "audit-list";
  for (const [label, value] of [
    ["最大待ちセクション", metrics?.maximum_team_wait_sections],
    ["審判直後の試合", metrics?.referee_then_match_count],
    ["隣接セクションのコート移動", metrics?.adjacent_assignment_court_change_count],
    ["依存試合間のコート移動", metrics?.team_court_change_count],
    ["コート使用数の最大差", metrics?.court_usage_difference],
    ["主催者への切替", metrics?.tournament_referee_fallback_count],
    ["未使用スロット", metrics?.unused_slot_count],
  ] as Array<readonly [string, unknown]>) {
    appendTextElement(auditList, "li", `${label}：${String(value ?? 0)}`);
  }
  section.append(auditList);
  const unproven = asObjectArray(metrics?.objective_stages)
    .filter((stage) => stage.optimality_proven !== true)
    .map((stage) => String(stage.objective));
  appendTextElement(
    section,
    "p",
    unproven.length === 0
      ? "記録された最適化目的はすべて最適性を証明済みです。"
      : `未証明の下位目的：${unproven.join("、")}（証明済みの上位目的は維持しています）`,
    "muted",
  );
  const rankedTeams = new Map(
    asObjectArray(standings?.standings)
      .filter(
        (row) =>
          typeof row.block_id === "string" &&
          typeof row.rank === "number" &&
          typeof row.team_id === "string",
      )
      .map((row) => [`${String(row.block_id)}:${String(row.rank)}`, String(row.team_id)]),
  );
  const matches = new Map(
    asObjectArray(schedule.tournament_matches)
      .filter((match) => typeof match.id === "string")
      .map((match) => [String(match.id), match]),
  );
  const schedulePresentation = buildWebSchedulePresentation("day2", schedule);
  const fallbackLabels: Record<string, string> = {
    no_previous_match: "直前の試合なし",
    source_may_play_target: "直前試合の勝者が出場する可能性",
    source_may_have_same_section_role: "同じ時間帯の役割と重複する可能性",
    source_used_twice_in_section: "同じ勝者を同時に重複割当て",
    source_may_referee_twice_in_section: "異なる試合の勝者が同じ審判チームになる可能性",
  };
  const day2Details = (
    presentationRow: SchedulePresentationRow<WebScheduleSlot>,
  ): ScheduleRowDetails => {
    const slot = presentationRow.slot;
    const match = matches.get(presentationRow.matchId);
    const assignment = asObject(slot.referee_assignment);
    let referee = "確認中";
    if (assignment?.kind === "team" && typeof assignment.source_match_id === "string") {
      const sourceNumber =
        schedulePresentation.displayNumberByMatchId.get(assignment.source_match_id) ??
        assignment.source_match_id;
      referee = `${sourceNumber}の勝者（同じコートの直前実試合）`;
    } else if (assignment?.kind === "organizer") {
      referee = "主催者";
      const reasons = Array.isArray(assignment.fallback_reasons)
        ? assignment.fallback_reasons.map((reason) => fallbackLabels[String(reason)] ?? String(reason))
        : [];
      if (reasons.length > 0) referee += `（${reasons.join("、")}）`;
    }
    return {
      phase: match?.phase === "upper_tournament" ? "上位" : "下位",
      matchup: `${tournamentEntryLabel(match?.home, rankedTeams, teamNames, schedulePresentation.displayNumberByMatchId)} 対 ${tournamentEntryLabel(match?.away, rankedTeams, teamNames, schedulePresentation.displayNumberByMatchId)}`,
      referee,
    };
  };
  const scheduleContainer = window.document.createElement("div");
  scheduleContainer.className = "schedule-view-content";
  const renderCurrentSchedule = (): void => {
    renderScheduleView(scheduleContainer, schedulePresentation, day2ScheduleViewMode, {
      showPhase: true,
      details: day2Details,
    });
  };
  section.append(
    createScheduleViewToggle("day2", day2ScheduleViewMode, (mode) => {
      day2ScheduleViewMode = mode;
      saveScheduleViewMode("day2", mode);
      renderCurrentSchedule();
    }),
    scheduleContainer,
  );
  renderCurrentSchedule();

  appendTextElement(section, "h4", "チーム別の可能な経路");
  const routeGrid = window.document.createElement("div");
  routeGrid.className = "team-schedule-grid";
  const routesByTeam = new Map<string, { label: string; routes: JsonObject[] }>();
  for (const route of asObjectArray(schedule.team_schedules)) {
    const rankRef = asObject(route.rank_ref);
    const rankLabel =
      rankRef?.type === "league_rank" &&
      typeof rankRef.block_id === "string" &&
      typeof rankRef.rank === "number"
        ? `${rankRef.block_id}ブロック ${String(rankRef.rank)}位`
        : undefined;
    const teamId = typeof route.team_id === "string" ? route.team_id : undefined;
    const key = teamId ?? rankLabel;
    if (key === undefined) continue;
    const label = teamId === undefined
      ? rankLabel!
      : `${teamNames.get(teamId) ?? teamId}${rankLabel === undefined ? "" : `（${rankLabel}）`}`;
    const group = routesByTeam.get(key) ?? { label, routes: [] };
    group.routes.push(route);
    routesByTeam.set(key, group);
  }
  for (const { label, routes } of routesByTeam.values()) {
    const card = window.document.createElement("section");
    card.className = "team-card";
    appendTextElement(card, "h5", label);
    const list = window.document.createElement("ul");
    for (const route of routes) {
      const routeRow = schedulePresentation.timeRows.find(
        (row) =>
          row.sectionNo === Number(route.section_no) &&
          row.courtId === String(route.court_id) &&
          row.matchId === String(route.match_id),
      );
      const routeMatchNumber = schedulePresentation.displayNumberByMatchId.get(
        String(route.match_id),
      );
      appendTextElement(
        list,
        "li",
        `${routeRow?.timeLabel ?? day2SectionLabel(Number(route.section_no), schedule)}　${courtNames.get(String(route.court_id)) ?? String(route.court_id)}　${route.role === "referee" ? "審判候補" : `${routeMatchNumber ?? String(route.match_id)}出場候補`}`,
      );
    }
    card.append(list);
    routeGrid.append(card);
  }
  section.append(routeGrid);
  content.append(section);
  if (!provisional) {
    renderTournamentResultsInput(content, schedule, _plan, teamNames);
  }
}

function tournamentScoreInput(
  label: string,
  value: string,
  disabled: boolean,
): HTMLInputElement {
  const input = window.document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.inputMode = "numeric";
  input.className = "score-input";
  input.setAttribute("aria-label", label);
  input.value = value;
  input.disabled = disabled;
  return input;
}

function scoreValue(input: HTMLInputElement): number | null | undefined {
  if (input.value.trim() === "") return null;
  const value = Number(input.value);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function renderFinalStandings(
  content: HTMLElement,
  finalStandings: JsonObject,
  teamNames: Map<string, string>,
  displayNumberByMatchId: ReadonlyMap<string, string>,
): void {
  const section = window.document.createElement("section");
  section.id = "final-standings-view";
  appendTextElement(section, "h3", "総合最終順位");
  appendTextElement(
    section,
    "p",
    "2日目の全試合結果を検証し、1位から最下位までを確定しました。",
    "validation-ok",
  );
  const wrapper = window.document.createElement("div");
  wrapper.className = "table-wrap";
  const table = window.document.createElement("table");
  table.setAttribute("aria-label", "総合最終順位");
  const head = window.document.createElement("thead");
  const heading = window.document.createElement("tr");
  for (const label of ["総合順位", "区分", "チーム"]) {
    appendTextElement(heading, "th", label);
  }
  head.append(heading);
  table.append(head);
  const body = window.document.createElement("tbody");
  for (const standing of asObjectArray(finalStandings.standings).sort(
    (left, right) => Number(left.rank) - Number(right.rank),
  )) {
    const row = window.document.createElement("tr");
    appendTextElement(row, "td", `${String(standing.rank)}位`);
    appendTextElement(row, "td", standing.pool === "upper" ? "上位" : "下位");
    appendTextElement(
      row,
      "td",
      teamNames.get(String(standing.team_id)) ?? String(standing.team_id),
    );
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  section.append(wrapper);

  appendTextElement(section, "h4", "検証済み試合結果");
  const resultWrapper = window.document.createElement("div");
  resultWrapper.className = "table-wrap";
  const resultTable = window.document.createElement("table");
  resultTable.setAttribute("aria-label", "検証済みの2日目試合結果");
  const resultHead = window.document.createElement("thead");
  const resultHeading = window.document.createElement("tr");
  for (const label of ["試合", "結果"]) {
    appendTextElement(resultHeading, "th", label);
  }
  resultHead.append(resultHeading);
  resultTable.append(resultHead);
  const resultBody = window.document.createElement("tbody");
  for (const matchResult of asObjectArray(finalStandings.match_results)) {
    const matchId = String(matchResult.match_id);
    const homeName = teamNames.get(String(matchResult.home_team_id)) ?? String(matchResult.home_team_id);
    const awayName = teamNames.get(String(matchResult.away_team_id)) ?? String(matchResult.away_team_id);
    const regularHome = String(matchResult.regular_score_home);
    const regularAway = String(matchResult.regular_score_away);
    const penalty = matchResult.decision === "penalty_shootout"
      ? ` (PK ${String(matchResult.penalty_score_home)}-${String(matchResult.penalty_score_away)}) `
      : " - ";
    const row = window.document.createElement("tr");
    appendTextElement(row, "td", displayNumberByMatchId.get(matchId) ?? matchId);
    appendTextElement(
      row,
      "td",
      `${homeName} ${regularHome}${penalty}${regularAway} ${awayName}`,
    );
    resultBody.append(row);
  }
  resultTable.append(resultBody);
  resultWrapper.append(resultTable);
  section.append(resultWrapper);
  content.append(section);
}

function renderTournamentResultsInput(
  content: HTMLElement,
  schedule: JsonObject,
  plan: JsonObject,
  teamNames: Map<string, string>,
): void {
  const progress = resolveTournamentProgress(plan, tournamentResults());
  const presentation = buildWebSchedulePresentation("day2", schedule);
  const scheduleOrder = new Map(
    presentation.timeRows.map((row, index) => [row.matchId, index]),
  );
  const ordered = [...progress.orderedMatches].sort(
    (left, right) =>
      (scheduleOrder.get(left.matchId) ?? Number.MAX_SAFE_INTEGER) -
      (scheduleOrder.get(right.matchId) ?? Number.MAX_SAFE_INTEGER),
  );
  const section = window.document.createElement("section");
  section.id = "tournament-results-input";
  appendTextElement(section, "h3", "2日目結果入力");
  appendTextElement(
    section,
    "p",
    `入力済み ${String(ordered.filter((match) => match.result !== undefined).length)} / ${String(ordered.length)}試合。前の試合を確定すると、後続試合のチームを入力できます。`,
    "muted",
  );
  const wrapper = window.document.createElement("div");
  wrapper.className = "table-wrap";
  const table = window.document.createElement("table");
  table.className = "tournament-results-table";
  table.setAttribute("aria-label", "2日目の試合結果入力");
  const head = window.document.createElement("thead");
  const heading = window.document.createElement("tr");
  for (const label of ["時間", "試合", "区分", "対戦", "通常得点", "PK", "保存状態"]) {
    appendTextElement(heading, "th", label);
  }
  head.append(heading);
  table.append(head);
  const body = window.document.createElement("tbody");

  for (const match of ordered) {
    const row = window.document.createElement("tr");
    row.dataset.matchId = match.matchId;
    const presentationRow = presentation.timeRows.find((item) => item.matchId === match.matchId);
    appendTextElement(row, "td", presentationRow?.timeLabel ?? "未配置");
    const numberCell = window.document.createElement("td");
    appendMatchDisplayNumber(
      numberCell,
      match.matchId,
      presentation.displayNumberByMatchId.get(match.matchId) ?? match.matchId,
    );
    row.append(numberCell);
    appendTextElement(row, "td", match.pool === "upper" ? "上位" : "下位");
    const ready = match.homeTeamId !== undefined && match.awayTeamId !== undefined;
    const homeName = ready ? teamNames.get(match.homeTeamId!) ?? match.homeTeamId! : "前提試合待ち";
    const awayName = ready ? teamNames.get(match.awayTeamId!) ?? match.awayTeamId! : "前提試合待ち";
    appendTextElement(row, "td", ready ? `${homeName} 対 ${awayName}` : "前提試合の結果待ち");

    const draft = tournamentResultDrafts.get(match.matchId);
    const regularHome = tournamentScoreInput(
      `${homeName} 対 ${awayName}・${homeName}の通常得点`,
      draft?.regularHome ??
        (match.result === undefined ? "" : String(match.result.regular_score_home)),
      !ready,
    );
    const regularAway = tournamentScoreInput(
      `${homeName} 対 ${awayName}・${awayName}の通常得点`,
      draft?.regularAway ??
        (match.result === undefined ? "" : String(match.result.regular_score_away)),
      !ready,
    );
    const regularCell = window.document.createElement("td");
    regularCell.append(regularHome, window.document.createTextNode(" - "), regularAway);
    row.append(regularCell);

    const penaltyHome = tournamentScoreInput(
      `${homeName} 対 ${awayName}・${homeName}のPK得点`,
      draft?.penaltyHome ??
        (match.result?.penalty_score_home === undefined
          ? ""
          : String(match.result.penalty_score_home)),
      !ready,
    );
    const penaltyAway = tournamentScoreInput(
      `${homeName} 対 ${awayName}・${awayName}のPK得点`,
      draft?.penaltyAway ??
        (match.result?.penalty_score_away === undefined
          ? ""
          : String(match.result.penalty_score_away)),
      !ready,
    );
    const penaltyFields = window.document.createElement("span");
    penaltyFields.className = "penalty-score-fields";
    penaltyFields.append(penaltyHome, window.document.createTextNode(" - "), penaltyAway);
    const penaltyCell = window.document.createElement("td");
    penaltyCell.append(penaltyFields);
    row.append(penaltyCell);
    const saved = appendTextElement(
      row,
      "td",
      !ready ? "前提試合待ち" : match.result === undefined ? "未入力" : "保存済み",
      "muted",
    );

    const updatePenaltyVisibility = (): void => {
      const home = scoreValue(regularHome);
      const away = scoreValue(regularAway);
      const tied = typeof home === "number" && typeof away === "number" && home === away;
      penaltyFields.hidden = !tied;
      if (!tied) {
        penaltyHome.value = "";
        penaltyAway.value = "";
      }
    };
    updatePenaltyVisibility();
    const updateDraft = (): void => {
      tournamentResultDrafts.set(match.matchId, {
        regularHome: regularHome.value,
        regularAway: regularAway.value,
        penaltyHome: penaltyHome.value,
        penaltyAway: penaltyAway.value,
      });
      updatePenaltyVisibility();
    };
    for (const input of [regularHome, regularAway, penaltyHome, penaltyAway]) {
      input.addEventListener("input", updateDraft);
    }

    const removeSavedResult = (message: string): void => {
      if (match.result === undefined) {
        saved.textContent = message;
        saved.className = "field-error";
        return;
      }
      const changed = applyTournamentResultChange(
        plan,
        tournamentResults(),
        match.matchId,
      );
      for (const descendant of tournamentMatchDescendants(plan, match.matchId)) {
        tournamentResultDrafts.delete(descendant);
      }
      saveTournamentResults(changed.results);
      tournamentResultsStatus.textContent = changed.removedDescendantCount > 0
        ? `${message} 後続${String(changed.removedDescendantCount)}試合の結果も取り消しました。`
        : message;
      renderResult();
    };

    const save = (): void => {
      if (!ready) return;
      updateDraft();
      const home = scoreValue(regularHome);
      const away = scoreValue(regularAway);
      regularHome.toggleAttribute("aria-invalid", home === undefined);
      regularAway.toggleAttribute("aria-invalid", away === undefined);
      if (home === undefined || away === undefined) {
        removeSavedResult("通常得点は0以上の整数で入力してください。");
        return;
      }
      if (home === null || away === null) {
        removeSavedResult("通常得点を入力してください。");
        return;
      }
      const tied = home === away;
      const penaltyHomeValue = scoreValue(penaltyHome);
      const penaltyAwayValue = scoreValue(penaltyAway);
      penaltyHome.toggleAttribute("aria-invalid", tied && penaltyHomeValue === undefined);
      penaltyAway.toggleAttribute("aria-invalid", tied && penaltyAwayValue === undefined);
      if (
        tied &&
        (penaltyHomeValue === undefined || penaltyAwayValue === undefined)
      ) {
        removeSavedResult("PK得点は0以上の整数で入力してください。");
        return;
      }
      if (tied && (penaltyHomeValue === null || penaltyAwayValue === null)) {
        removeSavedResult("通常得点が同点のため、PK得点を入力してください。");
        return;
      }
      if (tied && penaltyHomeValue === penaltyAwayValue) {
        removeSavedResult("PK戦は勝敗が決まるまで入力してください。");
        return;
      }
      const next: JsonObject = {
        match_id: match.matchId,
        home_team_id: match.homeTeamId!,
        away_team_id: match.awayTeamId!,
        regular_score_home: home,
        regular_score_away: away,
        ...(tied
          ? {
              penalty_score_home: penaltyHomeValue,
              penalty_score_away: penaltyAwayValue,
            }
          : {}),
      };
      const changed = applyTournamentResultChange(
        plan,
        tournamentResults(),
        match.matchId,
        next,
      );
      tournamentResultDrafts.delete(match.matchId);
      if (changed.winnerChanged) {
        for (const descendant of tournamentMatchDescendants(plan, match.matchId)) {
          tournamentResultDrafts.delete(descendant);
        }
      }
      saveTournamentResults(changed.results);
      tournamentResultsStatus.textContent = changed.removedDescendantCount > 0
        ? `結果を保存し、勝者変更の影響を受ける後続${String(changed.removedDescendantCount)}試合を取り消しました。`
        : "2日目の試合結果をこの端末へ保存しました。";
      renderResult();
    };
    for (const input of [regularHome, regularAway, penaltyHome, penaltyAway]) {
      input.addEventListener("change", save);
    }
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  section.append(wrapper);
  content.append(section);

  tournamentResultsConfirmation.hidden = false;
  setupTournamentResultsTurnstile();
  refreshTournamentResultsEnabled();
  const finalStandings = asObject(documentState.tournament.result?.final_standings);
  if (finalStandings !== undefined) {
    renderFinalStandings(
      content,
      finalStandings,
      teamNames,
      presentation.displayNumberByMatchId,
    );
  }
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
  if (result === undefined || leaguePlan === undefined) return;
  if (tournamentTurnstileToken.length === 0) {
    tournamentStatus.textContent = "トーナメント作成の安全確認を完了してください。";
    return;
  }
  tournamentButton.disabled = true;
  tournamentStatusOwner = "generation";
  tournamentStatus.textContent =
    standings === undefined
      ? "仮トーナメントを作成しています…"
      : "2日目トーナメントを作成しています…";
  const league = asObject(documentState.tournament.input.league);
  const request: JsonObject = {
    request_kind: "tournament_plan",
    league_plan: leaguePlan,
    odd_split_policy: league?.odd_split_policy ?? "upper",
    random_seed: documentState.tournament.input.random_seed ?? 20260803,
  };
  if (standings !== undefined) request.league_standings = standings;
  void generateTournamentPlan(
    request,
    tournamentTurnstileToken,
  )
    .then((plan) => {
      saveTournamentPlan(plan);
      tournamentStatus.textContent =
        standings === undefined
          ? "仮トーナメントを作成し、この端末へ保存しました。"
          : "2日目トーナメントを作成し、この端末へ保存しました。";
      renderResult();
    })
    .catch((error: unknown) => {
      tournamentStatus.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "トーナメントを作成できませんでした。1日目の内容は保存されています。";
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

function requestDay2Schedule(): void {
  const result = asObject(documentState.tournament.result);
  const leaguePlan = resultLeaguePlan();
  const tournamentPlan = asObject(result?.tournament_plan);
  const day1 = asObject(documentState.tournament.input.day);
  const day2 = currentDay2Settings();
  if (
    result === undefined ||
    leaguePlan === undefined ||
    tournamentPlan === undefined ||
    day1 === undefined ||
    day2 === undefined
  ) {
    day2Status.textContent = "2日目日程の作成に必要な設定またはトーナメント表がありません。";
    return;
  }
  if (day2TurnstileToken.length === 0) {
    day2Status.textContent = "2日目日程作成の安全確認を完了してください。";
    return;
  }
  saveDay2Settings();
  day2Button.disabled = true;
  day2StatusOwner = "generation";
  const provisional = tournamentParticipantResolution(tournamentPlan) === "provisional";
  day2Status.textContent = provisional
    ? "仮の2日目時刻・コート・審判を配置しています…"
    : "2日目の時刻・コート・審判を配置しています…";
  const referees = asObject(documentState.tournament.input.referees) ?? {};
  void generateDay2Schedule(
    {
      schema_version: "0.1.0",
      request_kind: "day2_schedule",
      teams: documentState.tournament.input.teams,
      courts: documentState.tournament.input.courts,
      league_plan: leaguePlan,
      day1_schedule: { day: day1, slots: result.slots ?? [] },
      tournament_plan: tournamentPlan,
      day: day2,
      referees: {
        ...referees,
        tournament_fallback: day2FallbackInput.value,
      },
      random_seed: documentState.tournament.input.random_seed ?? 20260803,
      solver: { max_time_seconds: 30 },
    },
    day2TurnstileToken,
  )
    .then((schedule) => {
      saveDay2Schedule(schedule);
      day2Status.textContent = provisional
        ? "仮の2日目日程を作成し、この端末へ保存しました。"
        : "2日目日程を作成し、この端末へ保存しました。";
      renderResult();
    })
    .catch((error: unknown) => {
      day2Status.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "2日目日程を作成できませんでした。設定とトーナメント表は保存されています。";
      refreshDay2Enabled();
    })
    .finally(() => {
      day2TurnstileToken = "";
      refreshDay2Enabled();
      const api = turnstileApi();
      if (day2TurnstileWidgetId !== undefined && api !== undefined) {
        try {
          api.reset(day2TurnstileWidgetId);
        } catch {
          day2Status.textContent =
            "安全確認を再開できませんでした。画面を再読み込みしてください。";
        }
      }
    });
}

function requestTournamentStandings(): void {
  const result = asObject(documentState.tournament.result);
  const plan = asObject(result?.tournament_plan);
  if (result === undefined || plan === undefined) return;
  if (tournamentResultsTurnstileToken.length === 0) {
    tournamentResultsStatus.textContent = "最終順位確定の安全確認を完了してください。";
    return;
  }
  let progress;
  try {
    progress = resolveTournamentProgress(plan, tournamentResults());
  } catch (error) {
    tournamentResultsStatus.textContent =
      error instanceof Error ? error.message : "2日目の試合結果を確認できませんでした。";
    return;
  }
  if (!progress.complete) {
    tournamentResultsStatus.textContent =
      "すべての2日目試合の結果を入力してから最終順位を確定してください。";
    refreshTournamentResultsEnabled();
    return;
  }
  tournamentResultsButton.disabled = true;
  tournamentResultsStatusOwner = "calculation";
  tournamentResultsStatus.textContent = "2日目の全試合を検証し、総合最終順位を計算しています…";
  void calculateTournamentStandings(
    {
      schema_version: "0.1.0",
      request_kind: "tournament_results",
      tournament_plan: plan,
      results: tournamentResults(),
    },
    tournamentResultsTurnstileToken,
  )
    .then(async (standings) => {
      await saveFinalStandings(standings);
      tournamentResultsStatus.textContent =
        "総合最終順位を確定し、この端末へ保存しました。";
      renderResult();
    })
    .catch((error: unknown) => {
      tournamentResultsStatus.textContent =
        error instanceof ScheduleApiError
          ? error.message
          : "総合最終順位を確定できませんでした。入力した結果は保存されています。";
      refreshTournamentResultsEnabled();
    })
    .finally(() => {
      tournamentResultsTurnstileToken = "";
      refreshTournamentResultsEnabled();
      const api = turnstileApi();
      if (tournamentResultsTurnstileWidgetId !== undefined && api !== undefined) {
        try {
          api.reset(tournamentResultsTurnstileWidgetId);
        } catch {
          tournamentResultsStatus.textContent =
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
  if (currentStep === 4) document.body.dataset.printScope = "day1";
  if (currentStep === 5) document.body.dataset.printScope = "day2";
  if (currentStep === 3) setupTurnstile();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render(): void {
  const input = documentState.tournament.input;
  const league = asObject(input.league);
  const day = asObject(input.day);
  const day2 = asObject(input.day2);
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
  day2StartTimeInput.value = typeof day2?.start_time === "string" ? day2.start_time : "09:30";
  day2GameDurationInput.value = String(day2?.game_duration_minutes ?? 35);
  day2MarginInput.value = String(day2?.margin_minutes ?? 10);
  day2EndTimeInput.value = typeof day2?.end_time === "string" ? day2.end_time : "";
  day2MaxSectionsInput.value =
    typeof day2?.max_sections === "number" ? String(day2.max_sections) : "";
  day2FallbackInput.value = referees?.tournament_fallback === "strict" ? "strict" : "organizer";
  day2BreaksInput.value = asObjectArray(day2?.breaks)
    .map((item) => `${String(item.after_section)}:${String(item.duration_minutes)}`)
    .join("\n");
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
    const teams = namedInputsWithStableIds(previous.tournament.input.teams, teamNames, "team");
    const courts = namedInputsWithStableIds(previous.tournament.input.courts, courtNames, "court");
    const seeded = assignmentModeInput.value === "seeded_snake";
    documentState = {
      ...previous,
      updatedAt: now,
      tournament: {
        name: nameInput.value.trim(),
        input: {
          schema_version: "0.1.0",
          request_kind: "day1_league",
          teams: teams.map((team, index) => ({
            ...team,
            ...(seeded ? { seed: index + 1 } : {}),
          })),
          courts,
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
          day2: asObject(previous.tournament.input.day2) ?? {
            id: "day2",
            start_time: "09:30",
            game_duration_minutes: 35,
            margin_minutes: 10,
            max_sections: null,
            end_time: null,
            breaks: [],
          },
          referees: {
            organizer_capacity: inputNumber(organizerCapacityInput),
            team_referees_required_after_first: teamRefereesInput.checked,
            tournament_fallback:
              asObject(previous.tournament.input.referees)?.tournament_fallback ?? "organizer",
          },
          random_seed: inputNumber(randomSeedInput),
          solver: { max_time_seconds: 30 },
        },
        result: invalidateResult ? undefined : previous.tournament.result,
      },
    };
  }
  if (invalidateResult) tournamentResultDrafts.clear();
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

function renderDay2Preparation(
  result: JsonObject,
  day2Content: HTMLElement,
  day2Summary: HTMLElement,
  standings: JsonObject | undefined,
  tournamentPlan: JsonObject | undefined,
  teamNames: Map<string, string>,
  courtNames: Map<string, string>,
): void {
  day2Content.replaceChildren();
  tournamentResultsConfirmation.hidden = true;
  day2Content.classList.remove("empty");
  day2Summary.textContent =
    standings === undefined
      ? "順位枠から2日目の仮トーナメントを作成します。"
      : "1日目の確定順位から2日目を作成します。";
  if (standings !== undefined) {
    renderDay2StandingsSummary(day2Content, standings, teamNames);
  } else {
    appendTextElement(
      day2Content,
      "p",
      "リーグ順位の確定前に配布できる仮の組合せです。順位確定後はチーム名を自動で反映します。",
      "notice",
    );
  }
  tournamentConfirmation.hidden = false;
  const league = asObject(documentState.tournament.input.league);
  const splitLabels: Record<string, string> = {
    upper: "中央順位を上位へ入れる",
    lower: "中央順位を下位へ入れる",
    alternate: "ブロック順に上位・下位を交互にする",
  };
  const policy = String(league?.odd_split_policy ?? "upper");
  tournamentReview.textContent = `${standings === undefined ? "仮トーナメント／" : ""}上下振り分け：${splitLabels[policy] ?? splitLabels.upper}`;
  tournamentButton.textContent =
    standings === undefined ? "仮トーナメントを作成する" : "2日目トーナメントを作成する";
  setupTournamentTurnstile();
  refreshTournamentEnabled();
  day2Confirmation.hidden = true;
  day2PrintButton.disabled = tournamentPlan === undefined;
  if (tournamentPlan === undefined) return;
  const day2Schedule = asObject(result.day2_schedule);
  const displayNumberByMatchId =
    day2Schedule === undefined
      ? undefined
      : buildWebSchedulePresentation("day2", day2Schedule).displayNumberByMatchId;
  renderTournamentPlan(
    day2Content,
    tournamentPlan,
    standings,
    teamNames,
    displayNumberByMatchId,
  );
  day2Confirmation.hidden = false;
  setupDay2Turnstile();
  refreshDay2Enabled();
  if (day2Schedule !== undefined) {
    const finalStandings = asObject(result.final_standings);
    day2Summary.textContent = finalStandings !== undefined
      ? "2日目の全試合結果と総合最終順位を確定済みです。"
      : day2ParticipantResolution(day2Schedule) === "provisional"
        ? "2日目の仮トーナメントと仮日程を作成済みです。"
        : "2日目のトーナメントと日程を作成済みです。";
    renderDay2Schedule(
      day2Content,
      day2Schedule,
      tournamentPlan,
      standings,
      teamNames,
      courtNames,
    );
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
requiredElement<HTMLButtonElement>("#step5-back").addEventListener("click", () => goToStep(4, false));
requiredElement<HTMLButtonElement>("#go-day2").addEventListener("click", () => goToStep(5, false));

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
      tournamentResultDrafts.clear();
      legacyCompatibility = mode.legacyCompatibility;
      organizerCapacityTouched = inferOrganizerCapacityTouched();
      currentStep = restoredWizardStep(documentState);
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
    tournamentResultDrafts.clear();
    legacyCompatibility = mode.legacyCompatibility;
    organizerCapacityTouched = inferOrganizerCapacityTouched();
    currentStep = restoredWizardStep(documentState);
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
    tournamentResultDrafts.clear();
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
  void generateSchedule(buildDay1ScheduleRequest(documentState.tournament.input), turnstileToken)
    .then((result) => {
      documentState = {
        ...documentState,
        updatedAt: new Date().toISOString(),
        tournament: { ...documentState.tournament, result },
      };
      tournamentResultDrafts.clear();
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

printButton.addEventListener("click", () => {
  document.body.dataset.printScope = "day1";
  window.print();
});
day2PrintButton.addEventListener("click", () => {
  document.body.dataset.printScope = "day2";
  window.print();
});
standingsButton.addEventListener("click", requestLeagueStandings);
tournamentButton.addEventListener("click", requestTournamentPlan);
day2Button.addEventListener("click", requestDay2Schedule);
tournamentResultsButton.addEventListener("click", requestTournamentStandings);
for (const control of [
  day2StartTimeInput,
  day2GameDurationInput,
  day2MarginInput,
  day2EndTimeInput,
  day2MaxSectionsInput,
  day2FallbackInput,
  day2BreaksInput,
]) {
  control.addEventListener("change", saveDay2Settings);
}

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
  if (!day2Confirmation.hidden) refreshDay2Enabled();
  if (!tournamentResultsConfirmation.hidden) refreshTournamentResultsEnabled();
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

function setupDay2Turnstile(): void {
  if (day2TurnstileSetupStarted) return;
  day2TurnstileSetupStarted = true;
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#day2-turnstile-widget");
  if (!siteKey) {
    container.textContent = "安全確認の設定が完了していないため、2日目日程を作成できません。";
    day2Status.textContent = container.textContent;
    return;
  }
  void loadTurnstileApi()
    .then((api) => {
      try {
        container.replaceChildren();
        day2TurnstileWidgetId = api.render(container, {
          sitekey: siteKey,
          action: "generate_day2_schedule",
          callback: (token) => {
            day2TurnstileToken = token;
            refreshDay2Enabled();
            if (day2StatusOwner === "turnstile") {
              day2Status.textContent =
                token.length > 0
                  ? "安全確認が完了しました。"
                  : "安全確認を完了できませんでした。もう一度お試しください。";
            }
          },
          "expired-callback": () => {
            day2TurnstileToken = "";
            refreshDay2Enabled();
            if (day2StatusOwner === "turnstile") {
              day2Status.textContent =
                "安全確認の期限が切れました。もう一度確認してください。";
            }
          },
          "error-callback": () => {
            day2TurnstileToken = "";
            refreshDay2Enabled();
            if (day2StatusOwner === "turnstile") {
              day2Status.textContent =
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
      day2Status.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。トーナメント表はこの端末に保存されています。";
    });
}

function setupTournamentResultsTurnstile(): void {
  if (tournamentResultsTurnstileSetupStarted) return;
  tournamentResultsTurnstileSetupStarted = true;
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const container = requiredElement<HTMLElement>("#tournament-results-turnstile-widget");
  if (!siteKey) {
    container.textContent =
      "安全確認の設定が完了していないため、総合最終順位を確定できません。";
    tournamentResultsStatus.textContent = container.textContent;
    return;
  }
  void loadTurnstileApi()
    .then((api) => {
      try {
        container.replaceChildren();
        tournamentResultsTurnstileWidgetId = api.render(container, {
          sitekey: siteKey,
          action: "calculate_tournament_results",
          callback: (token) => {
            tournamentResultsTurnstileToken = token;
            refreshTournamentResultsEnabled();
            if (tournamentResultsStatusOwner === "turnstile") {
              tournamentResultsStatus.textContent = token.length > 0
                ? "安全確認が完了しました。"
                : "安全確認を完了できませんでした。もう一度お試しください。";
            }
          },
          "expired-callback": () => {
            tournamentResultsTurnstileToken = "";
            refreshTournamentResultsEnabled();
            if (tournamentResultsStatusOwner === "turnstile") {
              tournamentResultsStatus.textContent =
                "安全確認の期限が切れました。もう一度確認してください。";
            }
          },
          "error-callback": () => {
            tournamentResultsTurnstileToken = "";
            refreshTournamentResultsEnabled();
            if (tournamentResultsStatusOwner === "turnstile") {
              tournamentResultsStatus.textContent =
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
      tournamentResultsStatus.textContent = initialized
        ? "安全確認を初期化できませんでした。画面を再読み込みしてください。"
        : "安全確認を読み込めませんでした。入力結果はこの端末に保存されています。";
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
    currentStep = restoredWizardStep(documentState);
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
