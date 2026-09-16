/*
 * 드롭·빠른 버튼이 "무엇을 쓸지" 를 정하는 규칙 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 판단만 한다. 실제 쓰기는 호출부(applyDates)가 하고, 여기서는 **바꿀 필드와 사용자에게 할 말**을
 * 돌려준다. `changes` 가 null 이면 아무것도 쓰지 않고 `notice` 만 띄운다(거절).
 */
import { addDays, diffDays } from "../core/dates";
import { DEFAULT_MIN, SNAP_MIN, snapMin, timeText } from "../core/time";
import { LineChanges } from "./linePatch";

export interface DropPlan {
  changes: LineChanges | null;
  notice: string;
}

interface Dated {
  start: string | null;
  due: string | null;
  tStart: number | null;
  tEnd: number | null;
}

/**
 * 날짜 칸에 드롭. 드롭한 칸(iso)이 무엇이 되는지가 두 동작의 차이다.
 *   일반   = 기간 이동 : iso 가 🛫 시작일(없으면 📅 마감일)이 되고 기간 길이는 그대로 유지.
 *   Shift  = 마감 조정 : iso 가 📅 마감일이 되고 🛫 시작일은 고정 — 없으면 원래 마감일 자리에 새로 생김.
 * 어느 쪽이든 start > due 상태는 만들지 않는다 (막대 폭이 음수가 되어 CSS 가 무효화된다).
 */
export function planDropOnDate(task: Dated, iso: string, shift: boolean): DropPlan {
  if (shift) {
    const base = task.start || task.due; // 고정될 왼쪽 끝
    if (!base) return { changes: { due: iso }, notice: "📅 " + iso };
    if (iso < base) return { changes: null, notice: "마감일은 시작일(🛫 " + base + ")보다 앞설 수 없어요" };
    // 시작일이 없던 태스크는 원래 마감일을 시작일로 굳혀서 기간이 생기게 한다
    return {
      changes: task.start ? { due: iso } : { start: base, due: iso },
      notice: "📅 " + iso + (task.start ? "" : "  (🛫 " + base + " 생성)"),
    };
  }
  if (!task.due) return { changes: { due: iso }, notice: "📅 " + iso };
  if (!task.start) return { changes: { due: iso }, notice: "📅 " + iso };
  const span = diffDays(task.due, task.start); // 기간 길이(일) 보존
  const newDue = addDays(iso, span);
  return { changes: { start: iso, due: newDue }, notice: "🛫 " + iso + " → 📅 " + newDue };
}

/**
 * 일간 보기 시간 그리드에 드롭 → 시각 지정/이동. 길이는 보존(없던 태스크는 DEFAULT_MIN).
 * 다른 날짜(트레이 포함)에서 끌어온 단일일 태스크는 마감일도 이 날짜로 맞춘다.
 * 기간(🛫~📅)이 있는 태스크는 날짜를 건드리지 않는다 — 기간 이동은 월/주간 보기의 역할이다.
 */
export function planDropOnTime(task: Dated, iso: string, startMin: number): DropPlan {
  const len = task.tStart !== null ? task.tEnd! - task.tStart : DEFAULT_MIN;
  const s = Math.max(0, Math.min(1440 - SNAP_MIN, snapMin(startMin)));
  const e = Math.min(1440, s + len);
  const changes: LineChanges = { time: timeText(s, e) };
  const spans = task.start && task.due && task.start !== task.due;
  if (!spans && task.due !== iso) changes.due = iso;
  return { changes, notice: "⏰ " + timeText(s, e) + (changes.due ? "  📅 " + iso : "") };
}

/** 트레이 빠른버튼/날짜선택기 → 마감일만 지정 (버튼 라벨이 곧 마감일이므로 기간 이동이 아니다) */
export function planWriteBack(task: Dated, newDue: string): DropPlan {
  if (task.start && newDue < task.start) {
    return { changes: null, notice: "마감일은 시작일(🛫 " + task.start + ")보다 앞설 수 없어요" };
  }
  return { changes: { due: newDue }, notice: "📅 " + newDue };
}
