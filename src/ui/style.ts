/*
 * 표면이 공유하는 스타일 조각과 글자 조합 — createCalendar 에서 그대로 옮겼다(0.7.4).
 *
 * ⚠️ **겉보기엔 같은데 실제로 다른 것들이 있다.** 막대는 흐림이 `0.55`, 칩·블록은 `.55` 고,
 *    모바일 행은 배경·테두리 순서 자체가 다르다. 데스크탑 요일 머리는 일·토에 색을 주는데
 *    모바일은 일요일만 준다. 그래서 헬퍼는 **차이를 파라미터로 재현**한다 —
 *    차이를 없애는 것은 구조 변경이 아니라 동작 변경이라 별도 릴리스로 미룬다.
 *    (지금 값은 tests/golden/style.surfaces.json 에 표로 박혀 있다.)
 */
import { timeText } from "../core/time";

/** 지연 · 일요일에 쓰는 붉은색. 같은 값이지만 뜻이 달라 이름을 둘로 둔다. */
export const OVERDUE_RED = "#e05a7a";
export const SUNDAY_RED = "#e05a7a";
export const SATURDAY_BLUE = "#4f7cff";
/** "N일 지남" 경고 노랑 */
export const WARN_YELLOW = "#eab308";

/** 📆 GCal 일정은 **옅은 배경 · 점선 · 좌측 레일 없음**으로 "잡을 수 없는 것" 임을 알린다. */
export const fillCss = (c: string, ro: boolean): string => `background:${c}${ro ? "14" : "2b"};`;
export const strokeCss = (c: string, ro: boolean, overdue = false): string =>
  `border:1px ${ro ? "dashed" : "solid"} ${overdue ? OVERDUE_RED : c};`;
/** 굵은 좌측 레일은 **task 막대의 서명**이다 — 일정에는 주지 않는다. */
export const railCss = (c: string, ro: boolean): string => (ro ? "" : `border-left:4px solid ${c};`);
/** 배경 · 테두리 · 레일을 이 순서로 — 막대·칩·블록이 모두 이 순서를 쓴다. */
export const skinCss = (c: string, ro: boolean, overdue = false): string =>
  fillCss(c, ro) + strokeCss(c, ro, overdue) + railCss(c, ro);
/** 완료·취소는 흐리고 취소선. ⚠️ 막대만 `0.55`, 나머지는 `.55` 다. */
export const dimCss = (dim: boolean, opacity = ".55"): string =>
  dim ? `opacity:${opacity};text-decoration:line-through;` : "";
export const grabCss = (ro: boolean): string => `cursor:${ro ? "default" : "grab"};`;

/**
 * 모바일 행만 **다른 공식**을 쓴다: 읽기 전용은 배경만, 보통은 레일만 — 테두리도 한쪽은
 * 항목 색, 다른 쪽은 테마 경계색이다.
 */
export const mobileRowSkinCss = (c: string, ro: boolean): string =>
  "border:1px " + (ro ? "dashed " + c : "solid var(--background-modifier-border)") + ";" +
  (ro ? "background:" + c + "14;" : "border-left:4px solid " + c + ";");

/** 데스크탑 요일 머리 — 일요일 붉게, 토요일 푸르게. (모바일은 일요일만 준다) */
export const weekdayColor = (i: number): string =>
  i === 0 ? SUNDAY_RED : i === 6 ? SATURDAY_BLUE : "inherit";

export interface Item {
  title: string;
  done: boolean;
  cancelled: boolean;
  recurring: boolean;
  bookmark: boolean;
  tStart: number | null;
  tEnd: number | null;
  start?: string | null;
  due?: string | null;
  calendarName?: string;
  location?: string;
  color?: string;
}

export const titleOf = (t: Item): string => t.title || "(제목 없음)";
/**
 * 상태 접두. 📆 = Google Calendar 에서 온 항목(툴팁의 `📆 <캘린더명>` 과 같은 글자),
 * ✗ = 취소[-], ✓ = 완료. task 가 쓰는 글자와 겹치지 않는다.
 */
export const statusMark = (t: Item, ro: boolean): string =>
  ro ? "📆 " : t.cancelled ? "✗ " : t.done ? "✓ " : "";

/** 기간 막대. 잘린 쪽 화살표와 시작 시각이 붙고, **북마크도 붙는 유일한 표면**이다. */
export const barLabel = (t: Item, ro: boolean, clipL: boolean, clipR: boolean, hhmm: (m: number) => string): string =>
  statusMark(t, ro) +
  (t.recurring ? "🔁 " : "") +
  (t.bookmark ? "🔖 " : "") +
  (clipL ? "◀ " : "") +
  (t.tStart !== null && !clipL ? hhmm(t.tStart) + " " : "") +
  titleOf(t) +
  (clipR ? " ▶" : "");

/** 일간 종일 칩. ⚠️ 완료·취소 표시(✓/✗)가 **없다** — 흐림과 취소선으로만 말한다. */
export const dayChipLabel = (t: Item, ro: boolean): string =>
  (ro ? "📆 " : "") + (t.recurring ? "🔁 " : "") + (t.bookmark ? "🔖 " : "") + titleOf(t);

/** 시간 블록. 앞에 시각이 오고 ⚠️ **북마크는 안 붙는다**. */
export const timeBlockLabel = (t: Item, ro: boolean, timePart: string): string =>
  `${timePart} ${statusMark(t, ro)}${t.recurring ? "🔁 " : ""}${titleOf(t)}`;

/** 읽기 전용 항목의 툴팁 꼬리 — 반복 · 장소 · "고칠 수 없다" 한 줄. */
const roTail = (t: Item): string =>
  (t.recurring ? "\n🔁 반복 일정" : "") +
  (t.location ? `\n📍 ${t.location}` : "") +
  "\n(읽기 전용 — Google Calendar 일정)";

/** 기간 막대 툴팁. 일정은 캘린더·시각·기간을, task 는 날짜와 조작법을 말한다. */
export const barTooltip = (t: Item, ro: boolean, dim: boolean): string =>
  ro
    ? `${t.title}\n📆 ${t.calendarName}` +
      (t.tStart !== null ? `\n⏰ ${timeText(t.tStart, t.tEnd!)}` : `\n종일`) +
      (t.start !== t.due ? `\n${t.start} ~ ${t.due}` : `\n${t.due}`) +
      roTail(t)
    : `${t.title}\n🛫 ${t.start || "-"}  📅 ${t.due}` +
      (t.tStart !== null ? `  ⏰ ${timeText(t.tStart, t.tEnd!)}` : "") +
      (t.recurring ? "\n🔁 반복" : "") +
      (dim
        ? t.cancelled
          ? "\n(취소됨)"
          : "\n(완료됨)"
        : "\n드래그=기간째 이동(놓은 칸=시작일) · Shift+드래그=마감일만 조정 · 클릭=열기 · Ctrl+클릭=새 탭");

/** 일간 종일 칩 툴팁. */
export const dayChipTooltip = (t: Item, ro: boolean): string =>
  ro
    ? `${t.title}\n📆 ${t.calendarName}\n종일` + roTail(t)
    : t.title + (t.recurring ? "\n🔁 반복" : "") + "\n시간 그리드로 드래그하면 시각이 지정됩니다";

/** 시간 블록 툴팁. */
export const timeBlockTooltip = (t: Item, ro: boolean): string =>
  ro
    ? `${t.title}\n📆 ${t.calendarName}\n⏰ ${timeText(t.tStart!, t.tEnd!)}` + roTail(t)
    : `${t.title}\n⏰ ${timeText(t.tStart!, t.tEnd!)}` +
      (t.recurring ? "\n🔁 반복" : "") +
      `\n드래그=시각 이동 · 아래끝 드래그=종료 시각 · 종일 줄로 드래그=시각 제거 · 클릭=열기`;
