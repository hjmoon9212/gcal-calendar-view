/*
 * Dataview 페이지 → 캘린더가 그리는 항목 — createCalendar 에서 그대로 옮겼다(0.7.2).
 *
 * 여기서 만든 모양(kind·uid·start·due·tStart·tEnd)을 GCal 일정도 그대로 흉내낸다(feed/events.ts).
 * 그래서 레인 배치·종일/시간 분리 코드가 둘을 구분하지 않는다.
 */
import { parseTimeField, timeReStrip } from "../core/time";
import { pkey, sweepPending, UID, PendingEntry } from "./pending";

export interface TaskItem {
  kind: "task";
  uid: string;
  path: string;
  line: number;
  text: string;
  title: string;
  due: string | null;
  start: string | null;
  tStart: number | null;
  tEnd: number | null;
  cat: string;
  done: boolean;
  cancelled: boolean;
  bookmark: boolean;
  recurring: boolean;
}

/** 제목 = 날짜·태그를 지운 값 → 날짜를 바꿔도 변하지 않으므로 대기표 키로 안전 */
export const mkTitle = (s: string): string =>
  s
    // 🔁 뒤에는 날짜가 아니라 문장이 온다(예: 🔁 every week on Monday) → 다음 필드/태그 전까지 제거
    .replace(/🔁[^📅🛫⏳✅➕❌🆔⛔🔺⏫🔼🔽⏬#]*/gu, "")
    .replace(/(?:📅|🛫|⏳|✅|➕|❌)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(timeReStrip(), "") // ⏰ 시각 필드 제거 (제목에 섞이면 GCal 이벤트 제목이 더러워진다)
    .replace(/(?:🆔|⛔)\s*\S+/gu, "") // 🆔 id · ⛔ 의존성 제거 (u 플래그로 이모지 정확 매칭)
    .replace(/[🔺⏫🔼🔽⏬📅🛫⏳✅➕❌🔁]/gu, "") // 우선순위 표시 · 남은 필드 마커 제거
    .replace(/#\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Dataview 태스크 한 개 → 항목. 대기표에 최신 줄이 있으면 그것으로 그린다. */
export function parseTaskItem(
  path: string,
  t: { text?: string; line: number; status?: string; completed?: boolean },
  opts: { catDefault: string; pending: Map<string, PendingEntry> }
): TaskItem | null {
  let text = String(t.text || "");
  if (!/#task\b/.test(text)) return null;
  let title = mkTitle(text);
  // 낙관적 갱신: 방금 쓴 줄이 아직 인덱스에 안 반영됐으면 그 줄로 대체해서 그린다
  const key = pkey(path, t.line, title);
  const ov = opts.pending.get(key);
  if (ov) {
    if (ov.text === text) opts.pending.delete(key); // 인덱스가 따라옴 → 해제
    else {
      text = ov.text;
      title = mkTitle(text); // 편집 모달로 제목이 바뀐 경우까지 반영
    }
  }
  const dm = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const sm = text.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
  const gm = text.match(/#gcal\/([\w-]+)/);
  const { tStart, tEnd } = parseTimeField(text);
  return {
    kind: "task",
    uid: UID(path, t.line),
    path,
    line: t.line,
    text,
    title,
    due: dm ? dm[1] : null,
    start: sm ? sm[1] : null,
    tStart,
    tEnd,
    cat: gm ? gm[1].toLowerCase() : opts.catDefault,
    done: !!t.completed,
    cancelled: t.status === "-", // - [-] = Tasks 취소 상태
    bookmark: t.status === "b", // - [b] = 북마크 상태
    // 🔁 반복 task. mkTitle 이 제목에서 지우므로 여기서 원문을 보고 잡아둔다.
    recurring: /🔁/u.test(text),
  };
}

/** 스코프 안의 모든 `#task` 줄을 모은다. 만료된 대기표는 이때 함께 청소한다. */
export function gatherTasks(
  pages: Iterable<{ file: { path: string; tasks: any[] } }>,
  opts: { catDefault: string; pending: Map<string, PendingEntry>; now: number }
): TaskItem[] {
  const out: TaskItem[] = [];
  sweepPending(opts.pending, opts.now);
  for (const p of pages) {
    for (const t of p.file.tasks) {
      const item = parseTaskItem(p.file.path, t, opts);
      if (item) out.push(item);
    }
  }
  return out;
}
