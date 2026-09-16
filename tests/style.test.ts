/**
 * 표면(surface)마다 지금 어떤 스타일·접두·툴팁을 쓰는지 한 표에 모은다(0.7.4 준비).
 *
 * 렌더 골든도 cssText 를 그대로 비교하지만 트리 안에 흩어져 있어서, **"월간 막대와 모바일 칩이
 * 어디가 다른가"** 를 사람이 볼 수가 없다. 스타일 헬퍼로 합치려면 그 차이를 먼저 알아야 한다 —
 * 겉보기엔 같은데 실제로는 모서리 반경·최소 높이·`0.55`/`.55`·접두 조합이 갈린다.
 *
 * ⛔ 이 표는 **합치기 전의 사진**이다. 0.7.4 가 헬퍼를 만들 때 값이 달라지면 안 된다 —
 *    차이를 없애는 것은 구조 변경이 아니라 동작 변경이라 별도 릴리스로 미룬다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv(); // 2026-08-06(목) 12:00 로컬

import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { FakeEl, findAll } from "./helpers/fakeDom";
import { installDom, makeHarness, clickLabel, EventFix } from "./helpers/renderHarness";
import { Platform } from "./obsidian-stub";

installDom();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCalendar } = require("../src/calendar/createCalendar");

const NOTE = "0. Note/할일.md";
// 한 줄씩 성격이 다르다: 보통 · 지연 · 완료 · 취소 · 북마크+반복 · 시각 있음 · 🛫만 · 날짜 없음
const LINES = [
  "- [ ] #task #gcal/work 보통 📅 2026-08-06",
  "- [ ] #task #gcal/work 지연 📅 2026-08-03",
  "- [x] #task #gcal/work 완료 📅 2026-08-06 ✅ 2026-08-06",
  "- [-] #task #gcal/work 취소 📅 2026-08-06",
  "- [b] #task #gcal/work 북마크반복 🔁 every day 📅 2026-08-06",
  "- [ ] #task #gcal/work 시각 ⏰ 09:00-10:00 📅 2026-08-06",
  "- [ ] #task #gcal/work 시작만 🛫 2026-08-06",
  "- [ ] #task #gcal/work 날짜없음",
];
const EVENTS: EventFix[] = [
  { uid: "ev-all", title: "종일일정", startISO: "2026-08-06", endISO: "2026-08-06", tStart: null, tEnd: null, allDay: true, calendarId: "cal-work", calendarName: "Work", location: "회의실", recurring: true },
  { uid: "ev-timed", title: "시각일정", startISO: "2026-08-06", endISO: "2026-08-06", tStart: 600, tEnd: 660, allDay: false, calendarId: "cal-work", calendarName: "Work" },
];

function open() {
  const h = makeHarness({
    files: { [NOTE]: LINES.join("\n") },
    events: EVENTS,
    feed: "ready",
    calendars: [{ id: "cal-work", name: "Work" }],
  });
  createCalendar(h.args);
  return h;
}

/** 이 요소와 그 아래 모든 글자. 막대는 텍스트 노드, 칩은 자식 span 에 글자가 있다. */
function deepText(el: FakeEl): string {
  return (el.text || "") + el.children.map(deepText).join("");
}

/** cssText 로 표면을 고르고(구조), 글자로 그 중 하나를 고른다(내용). */
function surface(root: FakeEl, css: string, word?: string): FakeEl | undefined {
  const hits = findAll(root, (e) => e.style.cssText.includes(css));
  return word === undefined ? hits[0] : hits.find((e) => deepText(e).includes(word));
}

const shot = (el: FakeEl | undefined) =>
  el ? { css: el.style.cssText, text: deepText(el) || undefined, title: el.title || undefined } : null;

(async () => {
  const table: Record<string, any> = {};

  // ── 데스크탑 월간 ──
  (Platform as any).isPhone = false;
  {
    const h = open();
    const BAR = "position:absolute;left:calc(";
    table["month.bar.normal"] = shot(surface(h.container, BAR, "보통"));
    table["month.bar.overdue"] = shot(surface(h.container, BAR, "지연"));
    table["month.bar.done"] = shot(surface(h.container, BAR, "완료"));
    table["month.bar.cancelled"] = shot(surface(h.container, BAR, "취소"));
    table["month.bar.bookmark-recurring"] = shot(surface(h.container, BAR, "북마크반복"));
    table["month.bar.timed"] = shot(surface(h.container, BAR, "시각"));
    table["month.bar.event"] = shot(surface(h.container, BAR, "종일일정"));
    table["month.weekday-head.sun"] = shot(findAll(h.container, (e) => e.text === "일")[0]);
    table["month.weekday-head.sat"] = shot(findAll(h.container, (e) => e.text === "토")[0]);
    const CARD = "cursor:grab;";
    table["tray.card"] = shot(surface(h.container, CARD, "날짜없음"));
    table["tray.quick-button"] = shot(findAll(h.container, (e) => e.text === "내일")[0]);
    // 🛫 만 있는 줄은 **트레이에 온다**(막대는 📅 가 있어야 한다)
    table["tray.start-only"] = shot(surface(h.container, CARD, "시작만"));

    await clickLabel(h.container, "주간");
    table["week.bar.normal"] = shot(surface(h.container, BAR, "보통"));
    table["week.weekday-head.sun"] = shot(findAll(h.container, (e) => e.text.startsWith("일 "))[0]);

    await clickLabel(h.container, "일간");
    const CHIP = "border-radius:4px;padding:2px 7px";
    const BLOCK = "position:absolute;left:calc(52px";
    table["day.chip.allday-task"] = shot(surface(h.container, CHIP, "북마크반복"));
    table["day.chip.allday-event"] = shot(surface(h.container, CHIP, "종일일정"));
    table["day.block.timed-task"] = shot(surface(h.container, BLOCK, "09:00 시각"));
    table["day.block.timed-event"] = shot(surface(h.container, BLOCK, "시각일정"));
    table["day.hour-row"] = shot(findAll(h.container, (e) => e.text === "09:00")[0]?.parent ?? undefined);
    table["day.hour-label"] = shot(findAll(h.container, (e) => e.text === "09:00")[0]);
  }

  // ── 모바일 ──
  (Platform as any).isPhone = true;
  {
    const h = open();
    const ROW = "min-height:44px;padding:8px 10px";
    table["mobile.row.normal"] = shot(surface(h.container, ROW, "보통"));
    table["mobile.row.event"] = shot(surface(h.container, ROW, "종일일정"));
    table["mobile.month.cell-plain"] = shot(surface(h.container, "min-height:44px;padding:3px 2px"));
    // 고른 날(= 연 순간의 오늘)은 테두리로, 오늘 숫자는 굵은 강조색으로 — 다른 신호다
    table["mobile.month.cell-selected"] = shot(
      findAll(h.container, (e) =>
        e.style.cssText.includes("min-height:44px;padding:3px 2px") &&
        e.style.cssText.includes("border:1px solid var(--interactive-accent)")
      )[0]
    );
    table["mobile.filter.chip"] = shot(findAll(h.container, (e) => e.tag === "button" && e.style.cssText.includes("border-radius:16px"))[1]);

    await clickLabel(h.container, "일간");
    table["mobile.day.chip-allday"] = shot(surface(h.container, "min-height:32px;padding:0 10px", "북마크반복"));
    table["mobile.day.block-timed"] = shot(surface(h.container, "position:absolute;left:calc(44px", "시각"));
    table["mobile.day.hour-label"] = shot(findAll(h.container, (e) => e.text === "09:00")[0]);
  }
  (Platform as any).isPhone = false;

  golden("style.surfaces", table);
  done();
})();
