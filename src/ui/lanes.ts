/*
 * 한 주에 걸치는 기간 막대의 레인 배치 — createCalendar 에서 그대로 옮겼다(0.7.2).
 * (하루 안에서 겹치는 시간 블록의 좌우 배치는 core/timeLanes.ts 가 따로 한다.)
 */
import { diffDays, overlapsRange } from "../core/dates";
import { byDayOrder } from "../core/order";

export interface PlacedBar<T> {
  t: T;
  sCol: number;
  eCol: number;
  lane: number;
  /** 주 왼쪽/오른쪽으로 잘렸나 — 모서리를 각지게 하고 ◀ ▶ 를 붙인다. */
  clipL: boolean;
  clipR: boolean;
}

type Spanning = { start?: string | null; due?: string | null; uid: string };

/**
 * 주(weekStartISO ~ +6)에 걸치는 항목을 레인에 배치한다.
 *
 * 주 경계를 넘는 막대는 지난주에 쓰던 레인을 그대로 이어받는다(비어 있을 때만). 주마다 독립
 * 배치하면 연속된 막대가 다음 줄에서 다른 높이로 그려져 끊겨 보인다. 키는 `uid` 다 — 일정은
 * path·line 이 null 이라 예전 키로는 전부 한 값으로 뭉쳐 여러 주에 걸친 일정 막대가 주마다
 * 레인을 갈아탄다.
 */
export function layoutWeekBars<T extends Spanning>(
  tasks: T[],
  weekStartISO: string,
  laneMemo?: Map<string, number>
): { placed: PlacedBar<T>[]; lanes: number } {
  const clampCol = (c: number) => Math.max(0, Math.min(6, c));
  const weekEndISO = (() => {
    const d = new Date(weekStartISO + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const vis = tasks.filter((t) => overlapsRange(t, weekStartISO, weekEndISO));
  // **시작일이 먼저다** — 주 경계를 넘는 막대가 레인을 이어받으려면 그래야 한다.
  // 같은 날 안에서는 공통 규칙(📆 종일 → 시각순 → 종일 task) → byDayOrder
  vis.sort((a, b) => {
    const sa = a.start || a.due;
    const sb = b.start || b.due;
    if (sa !== sb) return sa! < sb! ? -1 : 1;
    return byDayOrder(a, b);
  });
  const laneEnd: number[] = [];
  const placed: PlacedBar<T>[] = [];
  const occupy = (lane: number, eCol: number) => {
    while (laneEnd.length <= lane) laneEnd.push(-1);
    laneEnd[lane] = eCol;
  };
  for (const t of vis) {
    const sISO = (t.start || t.due)!;
    const rawS = diffDays(sISO, weekStartISO);
    const rawE = diffDays(t.due!, weekStartISO);
    const sCol = clampCol(rawS);
    const eCol = clampCol(rawE);
    const prev = laneMemo ? laneMemo.get(t.uid) : undefined;
    let lane =
      prev !== undefined && (laneEnd[prev] === undefined || laneEnd[prev] < sCol)
        ? prev
        : laneEnd.findIndex((le) => le < sCol);
    if (lane === -1) lane = laneEnd.length;
    occupy(lane, eCol);
    if (laneMemo) laneMemo.set(t.uid, lane);
    placed.push({ t, sCol, eCol, lane, clipL: rawS < 0, clipR: rawE > 6 });
  }
  return { placed, lanes: Math.max(laneEnd.length, 1) };
}
