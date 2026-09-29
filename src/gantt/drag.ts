/*
 * Gantt 막대 드래그 — "무엇을 쓸지" 를 정하는 규칙(0.10.0~). 순수 계산이라 DOM 도 설정도 안 본다.
 *
 * 캘린더의 write/dropRules.ts 와 같은 자리다: 판단만 하고 쓰기는 호출부가 한다.
 *   · 노트 막대 → 프로퍼티 패치 `{ 키: 날짜 }`   (write/TaskWriteService.setNoteProps)
 *   · task 막대 → 줄 변경 `{ start?, due? }`     (write/TaskWriteService.applyDates)
 * 어느 쪽도 시작 > 끝을 만들지 않는다(막대 폭이 음수가 되면 CSS 가 무효가 된다).
 */
import { addDays } from "../core/dates";
import type { LineChanges } from "../write/linePatch";
import type { GanttGroup, GanttRow } from "./rows";

/** 가운데 = 기간째 이동, 왼쪽 끝 = 시작만, 오른쪽 끝 = 끝만 */
export type DragMode = "move" | "start" | "end";

/** 이만큼 움직이기 전에는 드래그가 아니라 클릭이다(px) */
export const DRAG_THRESHOLD = 4;

/** 포인터 이동(px) → 날짜 이동(일). 반 칸을 넘으면 한 칸 */
export const daysFor = (dx: number, dayPx: number): number => (dayPx > 0 ? Math.round(dx / dayPx) : 0);

/** 드래그 중 미리보기 구간 */
export function previewSpan([a, b]: [string, string], mode: DragMode, d: number): [string, string] {
  if (mode === "move") return [addDays(a, d), addDays(b, d)];
  if (mode === "start") {
    const s = addDays(a, d);
    return [s > b ? b : s, b];
  }
  const e = addDays(b, d);
  return [a, e < a ? a : e];
}

/**
 * 노트 막대 → 프로퍼티 패치. 바뀌는 게 없으면 null.
 *
 * 기간째 이동에서 **프로퍼티가 아닌 끝은 쓰지 않는다** — 끝이 task 로 메워졌거나 열린 기간(오늘까지)
 * 이면 그 끝은 노트가 정한 값이 아니다. 시작은 늘 쓴다(막대를 옮긴 것이 곧 시작을 정한 것이다).
 * 끝만 끌면 그 키가 없던 노트에도 새로 쓴다(`props.endKey` — 빈 키가 있으면 그 이름).
 */
export function notePatch(g: GanttGroup, mode: DragMode, d: number): Record<string, string> | null {
  if (!d || !g.span) return null;
  const [s, e] = previewSpan([g.span.start, g.span.end], mode, d);
  const p = g.props;
  const out: Record<string, string> = {};
  if (mode === "move") {
    out[p.startKey] = s;
    if (p.hasEnd) out[p.endKey] = e;
  } else if (mode === "start") {
    if (s === g.span.start) return null;
    out[p.startKey] = s;
  } else {
    if (e === g.span.end) return null;
    out[p.endKey] = e;
  }
  return out;
}

/**
 * task 막대 → 줄 변경. 바뀌는 게 없으면 null. 요약 막대(자기 날짜 없음)는 끌 수 없다.
 * 📅 만 있는 task(◆)는 📅 하나만 움직인다 — 이동과 끝 조정이 같고 시작 조정은 없다.
 */
export function taskChanges(r: GanttRow, mode: DragMode, d: number): LineChanges | null {
  const t = r.task;
  if (!d || r.summary || !t.due) return null;
  // 🛫 없는 task 는 📅 하나뿐 — 이동과 끝 조정이 같다(초과 점선을 끌 때 "end" 로 온다)
  if (!t.start) return mode === "start" ? null : { due: addDays(t.due, d) };
  const [s, e] = previewSpan([t.start, t.due], mode, d);
  if (mode === "move") return { start: s, due: e };
  if (mode === "start") return s === t.start ? null : { start: s };
  return e === t.due ? null : { due: e };
}

/** 알림 한 줄 */
export const spanText = ([a, b]: [string, string]): string => (a === b ? a : `${a} ~ ${b}`);
