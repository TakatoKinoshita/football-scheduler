export type ScheduleViewMode = "time" | "court";
export type ScheduleDayId = "day1" | "day2";

export const SCHEDULE_VIEW_STORAGE_KEYS: Readonly<Record<ScheduleDayId, string>> = {
  day1: "football-scheduler:schedule-view:v1:day1",
  day2: "football-scheduler:schedule-view:v1:day2",
};

export interface ScheduleViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ScheduleCourtInput {
  id: string;
  name: string;
}

export interface ScheduleSlotInput {
  section_no: number;
  court_id: string;
  match_id: string | null;
}

export interface ScheduleSectionTimingInput {
  section_no: number;
  start_time?: string | null;
  match_end?: string | null;
}

export interface ScheduleBreakInput {
  after_section: number;
  duration_minutes: number;
}

export interface ScheduleDaySettingsInput {
  start_time?: string | null;
  game_duration_minutes?: number | null;
  margin_minutes?: number | null;
  breaks?: readonly ScheduleBreakInput[] | null;
}

export interface SchedulePresentationInput<TSlot extends ScheduleSlotInput> {
  dayId: ScheduleDayId;
  courts: readonly ScheduleCourtInput[];
  slots: readonly TSlot[];
  sectionTimings: readonly ScheduleSectionTimingInput[];
  daySettings: ScheduleDaySettingsInput;
}

export interface SchedulePresentationRow<TSlot extends ScheduleSlotInput> {
  slot: TSlot;
  matchId: string;
  sectionNo: number;
  courtId: string;
  courtCode: string;
  courtName: string;
  displayNumber: string;
  startTime?: string;
  matchEnd?: string;
  timeLabel: string;
}

export interface ScheduleCourtGroup<TSlot extends ScheduleSlotInput> {
  court: ScheduleCourtInput;
  courtCode: string;
  rows: readonly SchedulePresentationRow<TSlot>[];
}

export interface SchedulePresentation<TSlot extends ScheduleSlotInput> {
  timeRows: readonly SchedulePresentationRow<TSlot>[];
  courtGroups: readonly ScheduleCourtGroup<TSlot>[];
  displayNumberByMatchId: ReadonlyMap<string, string>;
}

const CIRCLED_NUMBERS = [
  ...Array.from({ length: 20 }, (_value, index) => String.fromCodePoint(0x2460 + index)),
  ...Array.from({ length: 15 }, (_value, index) => String.fromCodePoint(0x3251 + index)),
  ...Array.from({ length: 15 }, (_value, index) => String.fromCodePoint(0x32b1 + index)),
] as const;

export function defaultScheduleViewMode(dayId: ScheduleDayId): ScheduleViewMode {
  return dayId === "day1" ? "time" : "court";
}

export function loadScheduleViewMode(
  dayId: ScheduleDayId,
  storage?: ScheduleViewStorage | null,
): ScheduleViewMode {
  const fallback = defaultScheduleViewMode(dayId);
  try {
    const saved = resolveStorage(storage)?.getItem(SCHEDULE_VIEW_STORAGE_KEYS[dayId]);
    return saved === "time" || saved === "court" ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function saveScheduleViewMode(
  dayId: ScheduleDayId,
  mode: ScheduleViewMode,
  storage?: ScheduleViewStorage | null,
): boolean {
  const normalized = mode === "time" || mode === "court"
    ? mode
    : defaultScheduleViewMode(dayId);
  try {
    const target = resolveStorage(storage);
    if (target === undefined) return false;
    target.setItem(SCHEDULE_VIEW_STORAGE_KEYS[dayId], normalized);
    return true;
  } catch {
    return false;
  }
}

export function buildSchedulePresentation<TSlot extends ScheduleSlotInput>(
  input: SchedulePresentationInput<TSlot>,
): SchedulePresentation<TSlot> {
  const timingBySection = new Map(
    input.sectionTimings.map((timing) => [timing.section_no, timing] as const),
  );
  const courtById = new Map(
    input.courts.map((court, index) => [court.id, { court, index }] as const),
  );
  const realSlots = input.slots
    .map((slot, inputIndex) => ({ slot, inputIndex }))
    .filter(
      (entry): entry is { slot: TSlot & { match_id: string }; inputIndex: number } =>
        typeof entry.slot.match_id === "string" && entry.slot.match_id.length > 0,
    );
  const realSlotsByCourt = new Map<string, typeof realSlots>();
  for (const court of input.courts) realSlotsByCourt.set(court.id, []);
  for (const entry of realSlots) {
    const courtSlots = realSlotsByCourt.get(entry.slot.court_id);
    if (courtSlots === undefined) {
      throw new Error(`未登録のコート「${entry.slot.court_id}」が日程に含まれています`);
    }
    courtSlots.push(entry);
  }

  const displayNumberByMatchId = new Map<string, string>();
  const rowsByMatchId = new Map<string, SchedulePresentationRow<TSlot>>();
  for (const [courtIndex, court] of input.courts.entries()) {
    const courtCode = courtCodeForIndex(courtIndex);
    const entries = realSlotsByCourt.get(court.id) ?? [];
    entries.sort(compareSlotEntries);
    entries.forEach((entry, matchIndex) => {
      const matchId = entry.slot.match_id;
      if (displayNumberByMatchId.has(matchId)) {
        throw new Error(`試合ID「${matchId}」が日程内で重複しています`);
      }
      const displayNumber = `${courtCode}${numberMarker(matchIndex + 1)}`;
      const timing = resolveSectionTiming(
        entry.slot.section_no,
        timingBySection.get(entry.slot.section_no),
        input.daySettings,
      );
      const row: SchedulePresentationRow<TSlot> = {
        slot: entry.slot,
        matchId,
        sectionNo: entry.slot.section_no,
        courtId: court.id,
        courtCode,
        courtName: court.name,
        displayNumber,
        startTime: timing.startTime,
        matchEnd: timing.matchEnd,
        timeLabel: timing.timeLabel,
      };
      displayNumberByMatchId.set(matchId, displayNumber);
      rowsByMatchId.set(matchId, row);
    });
  }

  const courtGroups = input.courts.map((court, index) => ({
    court,
    courtCode: courtCodeForIndex(index),
    rows: (realSlotsByCourt.get(court.id) ?? []).map((entry) =>
      rowsByMatchId.get(entry.slot.match_id)
    ).filter((row): row is SchedulePresentationRow<TSlot> => row !== undefined),
  }));
  const timeRows = realSlots
    .slice()
    .sort((left, right) => compareTimeEntries(left, right, courtById))
    .map((entry) => rowsByMatchId.get(entry.slot.match_id))
    .filter((row): row is SchedulePresentationRow<TSlot> => row !== undefined);

  return { timeRows, courtGroups, displayNumberByMatchId };
}

function resolveStorage(
  supplied: ScheduleViewStorage | null | undefined,
): ScheduleViewStorage | undefined {
  if (supplied === null) return undefined;
  if (supplied !== undefined) return supplied;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function courtCodeForIndex(index: number): string {
  if (index < 0 || index >= 16) {
    throw new Error("表示できるコート数は16面までです");
  }
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function numberMarker(number: number): string {
  return CIRCLED_NUMBERS[number - 1] ?? `(${String(number)})`;
}

function compareSlotEntries<TSlot extends ScheduleSlotInput>(
  left: { slot: TSlot; inputIndex: number },
  right: { slot: TSlot; inputIndex: number },
): number {
  return left.slot.section_no - right.slot.section_no || left.inputIndex - right.inputIndex;
}

function compareTimeEntries<TSlot extends ScheduleSlotInput>(
  left: { slot: TSlot; inputIndex: number },
  right: { slot: TSlot; inputIndex: number },
  courtById: ReadonlyMap<string, { court: ScheduleCourtInput; index: number }>,
): number {
  return left.slot.section_no - right.slot.section_no ||
    (courtById.get(left.slot.court_id)?.index ?? Number.MAX_SAFE_INTEGER) -
      (courtById.get(right.slot.court_id)?.index ?? Number.MAX_SAFE_INTEGER) ||
    left.inputIndex - right.inputIndex;
}

function resolveSectionTiming(
  sectionNo: number,
  explicit: ScheduleSectionTimingInput | undefined,
  day: ScheduleDaySettingsInput,
): { startTime?: string; matchEnd?: string; timeLabel: string } {
  const calculated = calculateSectionTiming(sectionNo, day);
  const startTime = normalizeTime(explicit?.start_time) ?? calculated?.startTime;
  const matchEnd = normalizeTime(explicit?.match_end) ?? calculated?.matchEnd;
  return {
    startTime,
    matchEnd,
    timeLabel: startTime !== undefined && matchEnd !== undefined
      ? `${startTime}〜${matchEnd}`
      : `第${String(sectionNo)}セクション`,
  };
}

function calculateSectionTiming(
  sectionNo: number,
  day: ScheduleDaySettingsInput,
): { startTime: string; matchEnd: string } | undefined {
  const startMinutes = parseTime(day.start_time);
  const duration = day.game_duration_minutes;
  const margin = day.margin_minutes ?? 0;
  if (
    startMinutes === undefined ||
    !Number.isInteger(sectionNo) ||
    sectionNo < 1 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(margin) ||
    margin < 0
  ) {
    return undefined;
  }
  const breakMinutes = (day.breaks ?? []).reduce((total, item) => {
    if (
      Number.isInteger(item.after_section) &&
      item.after_section >= 1 &&
      item.after_section < sectionNo &&
      Number.isFinite(item.duration_minutes) &&
      item.duration_minutes >= 0
    ) {
      return total + item.duration_minutes;
    }
    return total;
  }, 0);
  const sectionStart = startMinutes + (sectionNo - 1) * (duration + margin) + breakMinutes;
  return {
    startTime: formatTime(sectionStart),
    matchEnd: formatTime(sectionStart + duration),
  };
}

function normalizeTime(value: string | null | undefined): string | undefined {
  const minutes = parseTime(value);
  return minutes === undefined ? undefined : formatTime(minutes);
}

function parseTime(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : undefined;
}

function formatTime(minutes: number): string {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
