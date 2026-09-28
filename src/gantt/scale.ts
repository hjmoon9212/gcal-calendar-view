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
/** 하루의 폭(px). 주 = 날짜 숫자가 들어가는 폭, 분기 = 1년이 한 화면에 가까운 폭 */
export const DAY_PX: Record<Zoom, number> = { week: 28, month: 10, quarter: 4 };

/** 전체 구간 앞뒤 여유(일) — 막대가 가장자리에 붙어 잘려 보이지 않게 */
export const PAD_DAYS = 7;
/** 이보다 긴 구간은 오늘 기준으로 자른다 — 몇 년짜리 옛 노트 하나가 축을 끝없이 늘리지 않게 */
export const MAX_DAYS = 1096;
export const CLIP_HALF = 548;

export const isZoom = (z: any): z is Zoom => ZOOMS.includes(z);

/**
 * 그릴 구간 [from, to]. 모든 막대 + 오늘을 덮고 앞뒤로 PAD_DAYS 를 붙인다.
 * MAX_DAYS 를 넘으면 오늘 ±CLIP_HALF 로 자른다(잘린 막대는 가장자리에서 끊겨 보인다).
 */
export function timelineRange(spans: [string, string][], today: string): [string, string] {
  let from = today;
  let to = today;
  for (const [a, b] of spans) {
    if (a < from) from = a;
    if (b > to) to = b;
  }
  from = addDays(from, -PAD_DAYS);
  to = addDays(to, PAD_DAYS);
  if (diffDays(to, from) + 1 > MAX_DAYS) {
    const lo = addDays(today, -CLIP_HALF);
    const hi = addDays(today, CLIP_HALF);
    if (from < lo) from = lo;
    if (to > hi) to = hi;
  }
  return [from, to];
}

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

export function makeScale(from: string, to: string, zoom: Zoom): Scale {
  const dayPx = DAY_PX[zoom];
  const days = diffDays(to, from) + 1;
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
