/**
 * 캘린더가 실제로 그리는 화면을 통째로 고정한다(0.7.2 — 클로저를 쪼개기 전의 안전망).
 *
 * `createCalendar` 는 1730줄짜리 클로저 하나다. 0.7.3~0.7.4 에서 상태·쓰기·렌더러로 나눌 때
 * **여기 스냅샷이 한 글자라도 달라지면 동작이 달라진 것이다.** 인라인 cssText 까지 그대로 비교한다
 * (스타일이 곧 레이아웃이고, 이 플러그인은 스타일을 전부 인라인으로 적는다).
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv(); // 2026-08-06(목) 12:00 로컬

import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { serializeEl, FakeEl } from "./helpers/fakeDom";
import { installDom, makeHarness, clickLabel as click, EventFix, HarnessOptions } from "./helpers/renderHarness";
import { Platform } from "./obsidian-stub";

installDom();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCalendar } = require("../src/calendar/createCalendar");

const FILES: Record<string, string> = {
  // 8월 6일(목)이 오늘. 주 경계(8/3 월 ~ 8/10 월)를 넘는 막대 · 지연 · 완료 · 취소 · 북마크 ·
  // 반복 · 같은 제목 둘(겹치는 시각) · 🛫만 · 날짜 없음 을 한 파일에 모은다.
  "0. Note/할일.md": [
    "# 할 일",
    "- [ ] #task #gcal/work 보고서 🛫 2026-08-03 📅 2026-08-10 🆔 aaa111",
    "- [ ] #task #gcal/growth 장보기 📅 2026-08-07",
    "- [ ] #task #gcal/personal 지난주 마감 📅 2026-08-03",
    "- [x] #task #gcal/work 끝난일 📅 2026-08-06 ✅ 2026-08-06",
    "- [-] #task #gcal/work 취소된일 📅 2026-08-06",
    "- [b] #task #gcal/hobby 북마크 📅 2026-08-06",
    "- [ ] #task #gcal/routine 반복 🔁 every day 📅 2026-08-06",
    "- [ ] #task #gcal/work 겹침 ⏰ 09:00-10:00 📅 2026-08-06",
    "- [ ] #task #gcal/work 겹침 ⏰ 09:30-11:00 📅 2026-08-06",
    "- [ ] #task #gcal/growth 시작만 🛫 2026-08-05",
    "- [ ] #task #gcal/growth 날짜 없음",
  ].join("\n"),
  "0. Note/2. Area/기타.md": ["- [ ] #task #gcal/non-core 다른 파일 날짜 없음", "- [ ] 그냥 줄"].join("\n"),
};

const EVENTS: EventFix[] = [
  { uid: "ev-timed", title: "주간 회의", startISO: "2026-08-06", endISO: "2026-08-06", tStart: 600, tEnd: 660, allDay: false, calendarId: "cal-work", calendarName: "Work", location: "3층 회의실", recurring: true },
  { uid: "ev-span", title: "워크숍", startISO: "2026-08-05", endISO: "2026-08-07", tStart: null, tEnd: null, allDay: true, calendarId: "cal-growth", calendarName: "Growth" },
  { uid: "ev-holiday", title: "광복절", startISO: "2026-08-15", endISO: "2026-08-15", tStart: null, tEnd: null, allDay: true, calendarId: "cal-holiday", calendarName: "Holidays in South Korea" },
];

const tick = () => new Promise((r) => setTimeout(r, 0));

function open(over: Partial<HarnessOptions> = {}) {
  const h = makeHarness({ files: FILES, events: EVENTS, feed: "ready", calendars: [{ id: "cal-work", name: "Work" }, { id: "cal-growth", name: "Growth" }], ...over });
  const cal = createCalendar(h.args);
  return { ...h, cal, tree: () => serializeEl(h.container) };
}

(async () => {
  (Platform as any).isPhone = false;

  // ── 데스크탑: 월 · 주 · 일 ──
  {
    const c = open();
    golden("render.desktop.month", c.tree());
    await click(c.container, "주간");
    golden("render.desktop.week", c.tree());
    await click(c.container, "일간");
    golden("render.desktop.day", c.tree());
  }

  // ── 피드 3상태 ──
  golden("render.desktop.no-feed", open({ feed: "none" }).tree());
  golden("render.desktop.feed-not-ready", open({ feed: "not-ready" }).tree());

  // ── 블록 옵션 ──
  golden("render.desktop.gcal-off", open({ calFilter: { off: true, include: [], exclude: [] } }).tree());
  golden("render.desktop.gcal-include", open({ calFilter: { off: false, include: ["growth"], exclude: [] } }).tree());
  golden("render.desktop.note", open({ notes: ["- **굵게** 한 줄", "- 둘째 줄"] }).tree());

  // ── 완료 표시 토글(이어받은 상태) ──
  golden("render.desktop.show-done-off", open({ state: { showDone: false } }).tree());

  // ── 카테고리 필터를 이어받았을 때 ──
  golden("render.desktop.cats-partial", open({ state: { cats: ["work"], knownCats: ["work", "growth", "routine", "personal", "hobby", "event", "non-core"] } }).tree());

  // ── 모바일 ──
  (Platform as any).isPhone = true;
  {
    const c = open();
    golden("render.mobile.month", c.tree());
    await click(c.container, "일간");
    golden("render.mobile.day", c.tree());
    await click(c.container, "0~24시 전부 보기");
    golden("render.mobile.day-full", c.tree());
  }
  {
    // 월간 그리드에서 다른 날 칸을 탭하면 아래 목록이 그 날 카드만 남는다.
    // (여는 순간 S.mDay 는 늘 오늘이라, "다른 날" 은 탭으로만 만들 수 있다)
    const c = open();
    await click(c.container, "7");
    golden("render.mobile.day-selected", c.tree());
  }
  (Platform as any).isPhone = false;

  done();
})();
