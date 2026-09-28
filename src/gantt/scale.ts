/*
 * Gantt 가로축 — 날짜 ↔ px. 순수 계산이라 DOM 도 설정도 안 본다.
 *
 * 날짜 계산은 core/dates.ts(UTC 자정 기준)를 쓴다. 로컬 시각으로 더하면 서머타임이 있는
 * 지역에서 하루가 밀린다.
 */
import { addDays, diffDays } from "../core/dates";

export type Zoom = "week" | "month" | "quarter";
export const ZOOMS: Zoom[] = ["week", "month", "quarter"];
export const ZOOM_LABEL: Record<Zoom, string> = { week: "주", month: "월", quarter: "분기" };
/**
 * 하루의 **최소** 폭(px). 실제 폭은 창을 화면 폭에 맞춰 늘린다(0.9.0~, `makeScale` 의 `avail`) —
 * 이보다 좁아지면 늘리지 않고 가로 스크롤한다. 주 = 날짜 숫자가 들어가는 폭.
 */
export const DAY_PX: Record<Zoom, number> = { week: 28, month: 10, quarter: 4 };

export const isZoom = (z: any): z is Zoom => ZOOMS.includes(z);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 그 달 1일에서 n 개월 옮긴 달의 1일. */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad2(mm + 1)}-01`;
}

const monthStart = (iso: string) => iso.slice(0, 8) + "01";

/**
 * 보기 기간(창). **줌이 곧 창의 크기**다 — 캘린더의 월간·주간과 같은 감각.
 *   주   = 기준 주 일요일 -1주 ~ +3주 (5주)
 *   월   = 지난달 1일 ~ 다음 달 말 (3개월)
 *   분기 = 기준 분기 1일 ~ 12개월
 */
export function viewWindow(zoom: Zoom, anchor: string): [string, string] {
  if (zoom === "week") {
    const wd = new Date(anchor + "T00:00:00Z").getUTCDay();
    const from = addDays(anchor, -wd - 7);
    return [from, addDays(from, 34)];
  }
  if (zoom === "month") {
    const m0 = monthStart(anchor);
    return [addMonths(m0, -1), addDays(addMonths(m0, 2), -1)];
  }
  const m = Number(anchor.slice(5, 7));
  const q0 = `${anchor.slice(0, 4)}-${pad2(m - ((m - 1) % 3))}-01`;
  return [q0, addDays(addMonths(q0, 12), -1)];
}

/** ◀ ▶ 한 번 — 주 = 1주, 월 = 1개월, 분기 = 3개월. */
export function stepAnchor(zoom: Zoom, anchor: string, dir: 1 | -1): string {
  if (zoom === "week") return addDays(anchor, 7 * dir);
  return addMonths(monthStart(anchor), (zoom === "month" ? 1 : 3) * dir);
}

/** 창 제목 — `2026.08 ~ 2026.10`, 주 줌은 `08.02 ~ 09.05` */
export function windowLabel(zoom: Zoom, [from, to]: [string, string]): string {
  if (zoom === "week") return `${from.slice(5).replace("-", ".")} ~ ${to.slice(5).replace("-", ".")}`;
  return `${from.slice(0, 7).replace("-", ".")} ~ ${to.slice(0, 7).replace("-", ".")}`;
}

/** [a, b] 가 [from, to] 와 겹치는가 */
export const overlaps = (a: string, b: string, from: string, to: string): boolean => a <= to && b >= from;

export interface Scale {
  from: string;
  to: string;
  dayPx: number;
  /** 전체 폭(px) */
  width: number;
  /** 그 날 **왼쪽 끝**의 x */
  x: (iso: string) => number;
  /** [a, b] (포함) 막대의 left·width. 구간 밖으로 나간 쪽은 잘린다. 완전히 밖이면 null */
  bar: (a: string, b: string) => { left: number; width: number; clipL: boolean; clipR: boolean } | null;
}

/**
 * @param avail 타임라인에 쓸 수 있는 폭(px). 주면 창을 그 폭에 맞춰 하루 폭을 늘린다 —
 *              넓은 화면에서 3개월 창이 900px 에 갇혀 막대가 안 보이던 것(0.8.x). 0/없음이면 최소 폭.
 */
export function makeScale(from: string, to: string, zoom: Zoom, avail = 0): Scale {
  const days = diffDays(to, from) + 1;
  const dayPx = Math.max(DAY_PX[zoom], avail > 0 ? Math.floor(avail / days) : 0);
  const x = (iso: string) => diffDays(iso, from) * dayPx;
  return {
    from,
    to,
    dayPx,
    width: days * dayPx,
    x,
    bar: (a, b) => {
      if (b < from || a > to) return null;
      const clipL = a < from;
      const clipR = b > to;
      const s = clipL ? from : a;
      const e = clipR ? to : b;
      return { left: x(s), width: (diffDays(e, s) + 1) * dayPx, clipL, clipR };
    },
  };
}

export interface Tick {
  iso: string;
  x: number;
  width: number;
  label: string;
}

/** 월 눈금 — 구간 첫날부터 월마다. 첫 칸과 1월에만 연도를 붙인다. */
export function monthTicks(sc: Scale): Tick[] {
  const out: Tick[] = [];
  let cur = sc.from;
  let first = true;
  while (cur <= sc.to) {
    const y = cur.slice(0, 4);
    const m = Number(cur.slice(5, 7));
    const nextY = m === 12 ? Number(y) + 1 : Number(y);
    const nextM = m === 12 ? 1 : m + 1;
    const next = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
    const end = next > sc.to ? addDays(sc.to, 1) : next;
    out.push({
      iso: cur,
      x: sc.x(cur),
      width: diffDays(end, cur) * sc.dayPx,
      label: first || m === 1 ? `${y}년 ${m}월` : `${m}월`,
    });
    first = false;
    cur = next;
  }
  return out;
}

/** 날짜 눈금 — 주 줌에서만 그린다(그보다 좁으면 숫자가 겹친다). */
export function dayTicks(sc: Scale): (Tick & { weekday: number })[] {
  const out: (Tick & { weekday: number })[] = [];
  for (let cur = sc.from; cur <= sc.to; cur = addDays(cur, 1)) {
    out.push({
      iso: cur,
      x: sc.x(cur),
      width: sc.dayPx,
      label: String(Number(cur.slice(8, 10))),
      weekday: new Date(cur + "T00:00:00Z").getUTCDay(),
    });
  }
  return out;
}
