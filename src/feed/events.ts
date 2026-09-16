/*
 * tasks-gcal-sync 피드가 준 일정 → 캘린더 항목 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 색은 **전부 이 플러그인 설정이 정한다** — 피드가 실어 보내는 `e.color` 는 일부러 보지 않는다.
 * 색이 두 군데 있으면 어느 쪽이 이기는지를 매번 되짚어야 하고, 실제로 그렇게 헷갈렸다.
 */
import { calKey } from "../core/blockOptions";
import { addDays, sundayStart } from "../core/dates";
import { Settings } from "../settings/defaults";

export interface CalFilter {
  off: boolean;
  include: string[];
  exclude: string[];
}

export interface EventItem {
  kind: "event";
  uid: string;
  path: null;
  line: null;
  text: string;
  title: string;
  start: string;
  due: string;
  tStart: number | null;
  tEnd: number | null;
  cat: null;
  color: string;
  calendarName: string;
  location: string;
  allDay: boolean;
  recurring: boolean;
  done: boolean;
  cancelled: boolean;
  bookmark: boolean;
}

/**
 * 이 블록이 이 캘린더를 그리는가. 이름(대소문자·공백 무시)이나 id 로 맞춘다 —
 * 사람이 손으로 적는 값이므로 이름이 주 경로이고, id 는 이름이 겹칠 때의 탈출구다.
 */
export function passesCalFilter(e: { calendarName?: string; calendarId?: string }, calf: CalFilter): boolean {
  const name = calKey(e.calendarName);
  const id = calKey(e.calendarId);
  const hit = (list: string[]) => list.includes(name) || list.includes(id);
  if (calf.include.length && !hit(calf.include)) return false;
  if (calf.exclude.length && hit(calf.exclude)) return false;
  return true;
}

/**
 * 피드가 준 일정 → 캘린더가 그릴 수 있는 항목.
 *
 * **task 항목과 같은 오리 모양으로 만든다** — start/due/tStart/tEnd 를 그대로 쓰므로
 * placeBars 의 레인 배치도, renderDay 의 종일/시간 분리도, 일간 클러스터 계산도 손댈 게 없다.
 *
 * path·line 은 **일부러 null** 이다. isRO 가드를 하나 빠뜨려도 파일 경로가 해석되지 않아
 * 아무것도 못 고친다(이중 안전장치).
 */
export const toEventItem = (e: any, color: string): EventItem => ({
  kind: "event",
  uid: e.uid,
  path: null,
  line: null,
  text: "",
  title: e.title,
  start: e.startISO,
  due: e.endISO,
  tStart: e.tStart,
  tEnd: e.tEnd,
  cat: null, // 카테고리가 아니다 — 필터도 별도 토글로 건다
  color,
  calendarName: e.calendarName || "",
  location: e.location || "",
  allDay: e.allDay,
  recurring: !!e.recurring,
  done: false,
  cancelled: false,
  bookmark: false,
});

/**
 * 일정 메모의 키. 구간·피드 버전만으로는 모자라다 — **색 설정이 바뀌면 캐시된 항목도 다시
 * 칠해야** 하므로 색 서명을 함께 넣는다.
 */
export const eventCacheKey = (
  fromISO: string,
  toISO: string,
  feedVersion: number,
  cats: string[],
  catColor: Record<string, string>,
  settings: Settings
): string =>
  fromISO + "|" + toISO + "|" + feedVersion + "|" +
  cats.map((c) => catColor[c]).join(",") + "|" +
  settings.eventColor + "|" + JSON.stringify(settings.eventColors || {});

/** 지금 보기가 실제로 그리는 날짜 범위. 조회 창이자 peek 필터다. */
export function rangeForView(mode: string, view: any): [string, string] {
  if (mode === "day") {
    const d = view.toISODate();
    return [d, d];
  }
  if (mode === "week") {
    const s = view.toISODate();
    return [s, addDays(s, 6)];
  }
  const first = sundayStart(view.startOf("month")).toISODate();
  const last = sundayStart(view.endOf("month")).toISODate();
  return [first, addDays(last, 6)];
}
