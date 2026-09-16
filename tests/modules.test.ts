/**
 * 0.7.2 에서 클로저 밖으로 꺼낸 순수 모듈의 단위 테스트.
 *
 * 렌더 골든은 "전체가 그대로인가" 를 보고, 여기서는 **경계값**을 직접 찌른다 —
 * 클로저 안에 있을 때는 닿을 수 없어 한 번도 확인해 본 적 없던 자리들이다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { eq, ok, done } from "./helpers/assert";
import { addDays, coversDay, diffDays, onDay, overlapsRange, spanOf } from "../src/core/dates";
import { DEFAULT_MIN, parseTimeField, snapMin, timeText, toHHMM, toMin } from "../src/core/time";
import { findTaskLine, patchLine } from "../src/write/linePatch";
import { planDropOnDate, planDropOnTime, planWriteBack } from "../src/write/dropRules";
import { mkTitle, parseTaskItem, gatherTasks } from "../src/data/gather";
import { pkey, sweepPending, UID } from "../src/data/pending";
import { eventCacheKey, passesCalFilter, toEventItem } from "../src/feed/events";
import { layoutWeekBars } from "../src/ui/lanes";
import { mobileHourRange } from "../src/ui/mobileHours";
import { syncCategories } from "../src/calendar/categories";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";

// ── core/dates ──
eq(addDays("2026-08-31", 1), "2026-09-01", "달을 넘긴다");
eq(addDays("2026-03-01", -1), "2026-02-28", "윤년 아닌 2월");
eq(diffDays("2026-08-10", "2026-08-03"), 7, "기간 길이");
eq(spanOf({ start: "2026-08-10", due: "2026-08-03" }), ["2026-08-03", "2026-08-10"], "뒤집힌 기간도 바로 세운다");
eq(spanOf({ start: null, due: null }), null, "날짜가 없으면 null");
eq(spanOf({ start: "2026-08-05", due: null }), ["2026-08-05", "2026-08-05"], "🛫 만 있으면 하루");
ok(coversDay({ start: "2026-08-05", due: null }, "2026-08-05"), "coversDay 는 🛫 만 있어도 센다");
ok(!onDay({ start: "2026-08-05", due: null }, "2026-08-05"), "onDay 는 📅 가 있어야 한다(달력의 기준)");
ok(overlapsRange({ start: "2026-08-01", due: "2026-08-20" }, "2026-08-10", "2026-08-16"), "구간을 통째로 덮는 막대");
ok(!overlapsRange({ start: "2026-08-01", due: "2026-08-09" }, "2026-08-10", "2026-08-16"), "하루 차이로 빗나감");

// ── core/time ──
eq(parseTimeField("할일 ⏰ 09:00-10:30 📅 2026-08-06"), { tStart: 540, tEnd: 630 }, "시작-종료");
eq(parseTimeField("할일 ⏰ 09:00"), { tStart: 540, tEnd: 540 + DEFAULT_MIN }, "종료가 없으면 기본 길이");
eq(parseTimeField("할일 ⏰ 10:00-09:00"), { tStart: 600, tEnd: 660 }, "역전이면 기본 길이로 고친다");
eq(parseTimeField("할일 ⏰ 23:30"), { tStart: 1410, tEnd: 1440 }, "자정을 넘지 않는다");
eq(parseTimeField("시각 없음"), { tStart: null, tEnd: null }, "없으면 null");
eq(toHHMM(-30), "00:00", "아래로 클램프");
eq(toHHMM(2000), "23:59", "위로 클램프");
eq(toMin("09:05"), 545, "분으로");
eq(snapMin(7), 0, "15분 스냅 — 내림");
eq(snapMin(8), 15, "15분 스냅 — 올림");
eq(timeText(540, 600), "09:00-10:00", "표시 문자열");

// ── write/linePatch ──
const LINE = "- [ ] #task 할일 📅 2026-08-06";
eq(patchLine(LINE, { due: "2026-08-09" }), "- [ ] #task 할일 📅 2026-08-09", "📅 치환");
eq(patchLine("- [ ] #task 할일", { due: "2026-08-09" }), "- [ ] #task 할일 📅 2026-08-09", "없으면 뒤에 붙인다");
eq(patchLine(LINE, { start: "2026-08-01" }), "- [ ] #task 할일 📅 2026-08-06 🛫 2026-08-01", "🛫 도 뒤에 붙는다(현재 동작)");
eq(
  patchLine(LINE, { time: "09:00-10:00" }),
  "- [ ] #task 할일 ⏰ 09:00-10:00 📅 2026-08-06",
  "⛔ ⏰ 는 첫 필드 이모지 **앞** — 줄 끝에 붙이면 Tasks 가 📅 까지 못 읽는다"
);
eq(
  patchLine("- [ ] #task 할일 🔁 every day 📅 2026-08-06", { time: "09:00-10:00" }),
  "- [ ] #task 할일 ⏰ 09:00-10:00 🔁 every day 📅 2026-08-06",
  "🔁 도 필드 이모지라 그 앞에 들어간다"
);
eq(patchLine("- [ ] #task 할일", { time: "09:00-10:00" }), "- [ ] #task 할일 ⏰ 09:00-10:00", "필드가 하나도 없으면 끝에");
eq(patchLine("- [ ] #task 할일 ⏰ 09:00-10:00 📅 2026-08-06", { time: null }), "- [ ] #task 할일 📅 2026-08-06", "null 이면 제거");
eq(
  patchLine("- [ ] #task 할일 ⏰ 09:00 ⏰ 11:00", { time: null }),
  "- [ ] #task 할일",
  "⏰ 가 둘이면 둘 다 지운다(전역 — sync 의 TaskLine 과 다르다 → 0.7.6 D2)"
);
eq(
  patchLine("- [ ] #task 할일", { start: "2026-08-01", due: "2026-08-05", time: "09:00-10:00" }),
  "- [ ] #task 할일 ⏰ 09:00-10:00 🛫 2026-08-01 📅 2026-08-05",
  "셋을 한 번에 — 새로 붙인 🛫 앞에 ⏰ 가 온다"
);
const LINES = ["# 제목", "- [ ] #task A", "- [ ] #task B"];
eq(findTaskLine(LINES, { line: 2, text: "#task B" }), 2, "줄 번호가 맞으면 그대로");
eq(findTaskLine(LINES, { line: 9, text: "#task B" }), 2, "밀렸으면 본문으로 다시 찾는다");
eq(findTaskLine(LINES, { line: 1, text: "#task 없음" }), -1, "없으면 -1 — 호출부가 반드시 처리한다");

// ── write/dropRules ──
const SPAN = { start: "2026-08-03", due: "2026-08-10", tStart: null, tEnd: null };
eq(planDropOnDate(SPAN, "2026-08-12", false), { changes: { start: "2026-08-12", due: "2026-08-19" }, notice: "🛫 2026-08-12 → 📅 2026-08-19" }, "기간째 이동 — 길이 7일 보존");
eq(planDropOnDate(SPAN, "2026-08-12", true), { changes: { due: "2026-08-12" }, notice: "📅 2026-08-12" }, "Shift = 마감일만");
eq(planDropOnDate(SPAN, "2026-08-01", true).changes, null, "시작일보다 앞이면 거절");
eq(
  planDropOnDate({ start: null, due: "2026-08-06", tStart: null, tEnd: null }, "2026-08-12", true),
  { changes: { start: "2026-08-06", due: "2026-08-12" }, notice: "📅 2026-08-12  (🛫 2026-08-06 생성)" },
  "🛫 가 없으면 원래 마감일이 시작일이 된다"
);
eq(planDropOnDate({ start: null, due: null, tStart: null, tEnd: null }, "2026-08-12", false).changes, { due: "2026-08-12" }, "날짜 없던 task");
eq(
  planDropOnTime({ start: null, due: "2026-08-06", tStart: 540, tEnd: 600 }, "2026-08-06", 607),
  { changes: { time: "10:00-11:00" }, notice: "⏰ 10:00-11:00" },
  "15분 스냅 · 길이 보존 · 같은 날이면 📅 를 건드리지 않는다"
);
eq(
  planDropOnTime({ start: null, due: "2026-08-05", tStart: null, tEnd: null }, "2026-08-06", 600),
  { changes: { time: "10:00-11:00", due: "2026-08-06" }, notice: "⏰ 10:00-11:00  📅 2026-08-06" },
  "다른 날에서 끌어오면 마감일도 맞춘다(길이는 기본 60분)"
);
eq(
  planDropOnTime(SPAN, "2026-08-06", 600).changes,
  { time: "10:00-11:00" },
  "기간이 있는 task 는 날짜를 건드리지 않는다"
);
eq(
  planDropOnTime({ start: null, due: "2026-08-06", tStart: 1380, tEnd: 1440 }, "2026-08-06", 1439).changes,
  { time: "23:45-23:59" },
  "끝자락 클램프 — 시작은 23:45 로 잘리고, 자정(1440)은 23:59 로 적힌다(toHHMM 의 상한)"
);
eq(planWriteBack(SPAN, "2026-08-01").changes, null, "빠른 버튼도 시작일보다 앞서면 거절");
eq(planWriteBack(SPAN, "2026-08-20"), { changes: { due: "2026-08-20" }, notice: "📅 2026-08-20" }, "마감일만 바꾼다");

// ── data/gather · pending ──
eq(mkTitle("#task #gcal/work 보고서 🔁 every week on Monday 🛫 2026-08-03 📅 2026-08-10 🆔 aaa"), "보고서", "제목만 남는다");
eq(mkTitle("#task ⏰ 09:00-10:00 회의 준비 ⏫"), "회의 준비", "⏰ 와 우선순위도 지운다");
{
  const pending = new Map();
  const item = parseTaskItem("a.md", { text: "#task #gcal/growth 할일 📅 2026-08-06", line: 3 }, { catDefault: "personal", pending })!;
  eq(item.uid, UID("a.md", 3), "uid = 경로+줄");
  eq([item.cat, item.due, item.tStart], ["growth", "2026-08-06", null], "태그·날짜·시각");
  eq(parseTaskItem("a.md", { text: "그냥 줄", line: 1 }, { catDefault: "personal", pending }), null, "#task 없으면 버린다");
  eq(parseTaskItem("a.md", { text: "#taskforce 회의", line: 1 }, { catDefault: "personal", pending }), null, "#taskforce 는 #task 가 아니다(\\b 경계)");
  eq(parseTaskItem("a.md", { text: "#task/minor 심부름", line: 1 }, { catDefault: "personal", pending })!.title, "심부름", "#task/하위 는 통과한다");
}
{
  // 대기표: 인덱스가 아직 옛 줄을 줄 때는 새 줄로 그리고, 따라오면 스스로 지운다
  const pending = new Map([[pkey("a.md", 1, "할일"), { text: "#task 할일 📅 2026-08-09", ts: Date.now() }]]);
  const opts = { catDefault: "personal", pending, now: Date.now() };
  const pages = [{ file: { path: "a.md", tasks: [{ text: "#task 할일 📅 2026-08-06", line: 1 }] } }];
  eq(gatherTasks(pages, opts)[0].due, "2026-08-09", "대기표가 이긴다");
  eq(pending.size, 1, "아직 안 따라왔으므로 남는다");
  const caught = [{ file: { path: "a.md", tasks: [{ text: "#task 할일 📅 2026-08-09", line: 1 }] } }];
  eq(gatherTasks(caught, opts)[0].due, "2026-08-09", "인덱스가 따라왔다");
  eq(pending.size, 0, "따라온 대기표는 해제된다");
}
{
  const pending = new Map([
    ["old", { text: "x", ts: Date.now() - 20001 }],
    ["new", { text: "y", ts: Date.now() }],
  ]);
  sweepPending(pending, Date.now());
  eq([...pending.keys()], ["new"], "만료된 대기표만 치운다");
}

// ── feed/events ──
const EV = { calendarName: "Work", calendarId: "cal-work" };
ok(passesCalFilter(EV, { off: false, include: [], exclude: [] }), "필터가 없으면 전부 통과");
ok(passesCalFilter(EV, { off: false, include: ["work"], exclude: [] }), "이름으로 화이트리스트");
ok(passesCalFilter(EV, { off: false, include: ["cal-work"], exclude: [] }), "id 로도 맞는다");
ok(!passesCalFilter(EV, { off: false, include: ["growth"], exclude: [] }), "목록에 없으면 뺀다");
ok(!passesCalFilter(EV, { off: false, include: [], exclude: ["work"] }), "블랙리스트");
eq(
  toEventItem({ uid: "u1", title: "회의", startISO: "2026-08-06", endISO: "2026-08-06", tStart: 600, tEnd: 660, allDay: false, calendarName: "Work" }, "#3f51b5"),
  {
    kind: "event", uid: "u1", path: null, line: null, text: "", title: "회의",
    start: "2026-08-06", due: "2026-08-06", tStart: 600, tEnd: 660, cat: null,
    color: "#3f51b5", calendarName: "Work", location: "", allDay: false,
    recurring: false, done: false, cancelled: false, bookmark: false,
  },
  "task 와 같은 오리 모양 · path/line 은 일부러 null"
);
{
  const base = eventCacheKey("2026-08-01", "2026-08-31", 0, ["work"], { work: "#111111" }, DEFAULT_SETTINGS);
  ok(base !== eventCacheKey("2026-08-01", "2026-08-31", 1, ["work"], { work: "#111111" }, DEFAULT_SETTINGS), "피드 버전이 바뀌면 다른 키");
  ok(base !== eventCacheKey("2026-08-01", "2026-08-31", 0, ["work"], { work: "#222222" }, DEFAULT_SETTINGS), "카테고리 색이 바뀌면 다시 칠한다");
  ok(
    base !== eventCacheKey("2026-08-01", "2026-08-31", 0, ["work"], { work: "#111111" }, { ...DEFAULT_SETTINGS, eventColor: "#000000" }),
    "기본 일정 색이 바뀌어도 다시 칠한다"
  );
}

// ── ui/lanes ──
const bar = (uid: string, start: string, due: string, extra: any = {}) => ({ uid, start, due, kind: "task", tStart: null, tEnd: null, ...extra });
{
  const { placed, lanes } = layoutWeekBars(
    [bar("a", "2026-08-03", "2026-08-04"), bar("b", "2026-08-05", "2026-08-06"), bar("c", "2026-08-03", "2026-08-07")],
    "2026-08-02"
  );
  eq(placed.map((p) => `${p.t.uid}:${p.lane}@${p.sCol}-${p.eCol}`), ["a:0@1-2", "c:1@1-5", "b:0@3-4"], "안 겹치면 같은 레인을 다시 쓴다");
  eq(lanes, 2, "레인 수");
}
{
  // 주 경계를 넘는 막대는 지난주 레인을 이어받는다
  const memo = new Map();
  const long = bar("long", "2026-08-05", "2026-08-20");
  layoutWeekBars([bar("x", "2026-08-02", "2026-08-06"), long], "2026-08-02", memo);
  eq(memo.get("long"), 1, "첫 주에는 1번 레인");
  const second = layoutWeekBars([long, bar("y", "2026-08-09", "2026-08-10")], "2026-08-09", memo);
  eq(second.placed.find((p) => p.t.uid === "long")!.lane, 1, "다음 주에도 같은 높이를 지킨다");
}
{
  const { placed } = layoutWeekBars([bar("clip", "2026-07-30", "2026-08-20")], "2026-08-02");
  eq([placed[0].clipL, placed[0].clipR, placed[0].sCol, placed[0].eCol], [true, true, 0, 6], "양쪽으로 잘린 막대");
}
eq(layoutWeekBars([bar("no-due", "2026-08-03", null as any)], "2026-08-02").placed.length, 0, "📅 없는 항목은 막대가 없다");

// ── ui/mobileHours ──
eq(mobileHourRange([], { fullDay: false, nowHour: null }), [8, 20], "아무것도 없으면 08~20");
eq(mobileHourRange([], { fullDay: true, nowHour: null }), [0, 24], "전부 보기");
eq(mobileHourRange([{ tStart: 360, tEnd: 420 }], { fullDay: false, nowHour: null }), [6, 20], "이른 일정만큼 넓힌다");
eq(mobileHourRange([{ tStart: 1290, tEnd: 1380 }], { fullDay: false, nowHour: null }), [8, 23], "늦은 일정만큼 넓힌다");
eq(mobileHourRange([], { fullDay: false, nowHour: 23 }), [8, 24], "오늘이면 현재 시각도 넣는다");

// ── calendar/categories ──
{
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const state: any = {};
  const active = new Set<string>();
  const v = syncCategories(settings, state, active);
  eq(v.CATS.length, 7, "설정의 카테고리 수");
  eq(v.CAT_DEFAULT, "personal", "기본 카테고리");
  eq(active.size, 7, "첫 실행은 전부 켠다");
  eq(state.knownCats.length, 7, "본 목록을 기억한다");

  // 하나를 끄고 다시 그려도 되살아나지 않는다(0.1.12 의 「한 번에 하나만 꺼진다」)
  active.delete("work");
  syncCategories(settings, state, active);
  ok(!active.has("work"), "꺼 둔 카테고리는 그대로");

  // 설정에서 사라지면 필터에서도 빠지고, 새로 생기면 켠 채로 시작한다
  settings.categories = settings.categories.filter((c: any) => c.key !== "hobby");
  settings.categories.push({ key: "study", label: "Study", color: "#123456" });
  syncCategories(settings, state, active);
  ok(!active.has("hobby"), "사라진 카테고리는 필터에서도 뺀다");
  ok(active.has("study"), "새 카테고리는 켜진 채로");
  ok(!active.has("work"), "그 와중에도 꺼 둔 것은 지킨다");
}

done();
