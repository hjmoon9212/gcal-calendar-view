/**
 * 캘린더를 **조작했을 때** 일어나는 일을 고정한다(0.7.2 — 클로저를 쪼개기 전의 안전망).
 *
 * 화면은 render.golden 이 본다. 여기서는 기록된 리스너를 실제로 실행해서
 * **노트에 무엇을 썼는지 · 사용자에게 무엇을 말했는지 · 피드를 어떻게 불렀는지**를 본다.
 * 노트 쓰기 규칙(⏰ 삽입 위치 · 📅/🛫 치환)은 틀리면 Tasks 파싱이 깨지는 자리다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv(); // 2026-08-06(목) 12:00 로컬

import { eq, ok, done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { FakeEl, findAll } from "./helpers/fakeDom";
import { installDom, makeHarness, byText, clickLabel as click, EventFix, HarnessOptions } from "./helpers/renderHarness";
import { noticeLog, Platform } from "./obsidian-stub";

installDom();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCalendar } = require("../src/calendar/createCalendar");

const NOTE = "0. Note/할일.md";
const LINES = [
  "# 할 일",
  "- [ ] #task #gcal/work 보고서 🛫 2026-08-03 📅 2026-08-10 🆔 aaa111",
  "- [ ] #task #gcal/growth 장보기 📅 2026-08-07",
  "- [ ] #task #gcal/work 겹침 ⏰ 09:00-10:00 📅 2026-08-06",
  "- [ ] #task #gcal/work 겹침 ⏰ 09:30-11:00 📅 2026-08-06",
  "- [ ] #task #gcal/growth 날짜 없음",
  "- [ ] #task #gcal/routine 반복 🔁 every day 📅 2026-08-06",
];
const EVENTS: EventFix[] = [
  { uid: "ev-timed", title: "주간 회의", startISO: "2026-08-06", endISO: "2026-08-06", tStart: 600, tEnd: 660, allDay: false, calendarId: "cal-work", calendarName: "Work" },
];

const tick = () => new Promise((r) => setTimeout(r, 0));
/** 대기표 키 구분자 — 코드가 String.fromCharCode(0) 를 쓴다. */
const SEP = String.fromCharCode(0);

function open(over: Partial<HarnessOptions> = {}) {
  noticeLog.length = 0;
  const h = makeHarness({ files: { [NOTE]: LINES.join("\n") }, events: EVENTS, feed: "ready", calendars: [{ id: "cal-work", name: "Work" }], ...over });
  const cal = createCalendar(h.args);
  return { ...h, cal, root: h.container };
}

/** 노트에서 `#task` 줄만 — 쓰기 결과를 한눈에 비교한다. */
const taskLines = (h: { files: Record<string, string> }) => h.files[NOTE].split("\n").filter((l) => l.includes("#task"));

/** 기간 막대 — 제목으로 고른다. 드래그가 걸린 것만(= 일정은 안 걸린다). */
const bars = (root: FakeEl) => findAll(root, (e) => !!e.listeners.dragstart);
const barByText = (root: FakeEl, t: string) => bars(root).find((b) => b.children.some((c) => c.text.includes(t)));
/** 월간 날짜 칸 — 칸 안의 날짜 숫자로 고른다. */
const monthCell = (root: FakeEl, day: number) =>
  findAll(root, (e) => !!e.listeners.drop && e.children.some((c) => c.text === String(day)))[0];

async function drag(from: FakeEl, to: FakeEl, ev: any = {}) {
  from.fire("dragstart", { dataTransfer: {} });
  await Promise.all(to.fire("drop", { clientX: 0, clientY: 0, ...ev }));
  await tick();
}

(async () => {
  (Platform as any).isPhone = false;

  // ── 월간: 막대를 다른 날 칸으로 ──
  {
    const h = open();
    // 기본 드래그 = 기간째 이동(놓은 칸이 🛫 시작일, 길이 7일 유지)
    await drag(barByText(h.root, "보고서")!, monthCell(h.root, 12)!);
    golden("interaction.month.drag-span", { lines: taskLines(h), notices: [...noticeLog], writes: h.calls.writes.length });
  }
  {
    const h = open();
    // Shift 드래그 = 마감일만 조정(🛫 고정)
    await drag(barByText(h.root, "보고서")!, monthCell(h.root, 12)!, { shiftKey: true });
    golden("interaction.month.drag-shift", { lines: taskLines(h), notices: [...noticeLog] });
  }
  {
    const h = open();
    // 시작일보다 앞으로는 못 민다 — 아무것도 쓰지 않고 이유를 말한다
    await drag(barByText(h.root, "보고서")!, monthCell(h.root, 1)!, { shiftKey: true });
    eq(h.calls.writes.length, 0, "시작일 앞으로 Shift 드롭 → 쓰기 없음");
    golden("interaction.month.drag-shift-rejected", { notices: [...noticeLog] });
  }
  {
    const h = open();
    // 🛫 가 없던 task 를 Shift 드롭하면 원래 마감일이 🛫 로 굳는다
    await drag(barByText(h.root, "장보기")!, monthCell(h.root, 12)!, { shiftKey: true });
    golden("interaction.month.shift-creates-start", { lines: taskLines(h), notices: [...noticeLog] });
  }

  // ── 같은 제목 두 줄: 옮긴 줄만 바뀐다 ──
  {
    const h = open();
    const dup = bars(h.root).filter((b) => b.children.some((c) => c.text.includes("겹침")));
    eq(dup.length, 2, "같은 제목 막대가 둘");
    await drag(dup[1], monthCell(h.root, 13)!);
    golden("interaction.duplicate-title", { lines: taskLines(h) });
  }

  // ── 대기표(낙관적 갱신): 인덱스가 아직 옛 줄을 줄 때 ──
  {
    const h = open({ indexLag: true });
    const dup = bars(h.root).filter((b) => b.children.some((c) => c.text.includes("겹침")));
    await drag(dup[1], monthCell(h.root, 13)!);
    // 키는 **경로 · 줄 번호 · 제목** 셋이다. 줄 번호가 빠지면 제목이 같은 다른 줄까지 덮인다.
    golden("interaction.pending-key", {
      keys: [...h.plugin.store.pending.keys()].map((k: string) => k.split(SEP)),
      values: [...h.plugin.store.pending.values()],
    });
    // 인덱스가 늦어도 화면은 이미 옮겨진 자리로 그린다
    const moved = bars(h.root).filter((b) => b.children.some((c) => c.text.includes("겹침")));
    eq(moved.length, 2, "막대 수는 그대로");
  }

  // ── 트레이: 빠른 버튼 · 날짜 선택기 ──
  {
    const h = open();
    await click(h.root, "내일");
    golden("interaction.tray.tomorrow", { lines: taskLines(h), notices: [...noticeLog] });
  }
  {
    const h = open();
    const dp = findAll(h.root, (e) => e.type === "date")[0];
    dp.value = "2026-09-01";
    await dp.onchange!({ target: { value: "2026-09-01" }, stopPropagation() {} });
    await tick();
    golden("interaction.tray.datepicker", { lines: taskLines(h), notices: [...noticeLog] });
  }

  // ── 일간: 종일 ↔ 시간 그리드 ──
  {
    const h = open();
    await click(h.root, "일간");
    // 종일 칩(장보기는 8/7 이라 오늘엔 없다 → 반복 task 를 쓴다)을 10:00 자리에 떨군다
    // 시간 그리드는 종일 줄과 달리 dragend 까지 듣는다(착지 그림자를 지우려고)
    const grid = findAll(h.root, (e) => !!e.listeners.drop && !!e.listeners.dragend)[0];
    const chip = bars(h.root).find((b) => b.children.some((c) => c.text.includes("반복")))!;
    await drag(chip, grid, { clientY: 640 });
    golden("interaction.day.drop-on-grid", { lines: taskLines(h), notices: [...noticeLog] });
  }
  {
    const h = open();
    await click(h.root, "일간");
    // 시각 있는 블록을 종일 줄로 → ⏰ 제거
    const ad = findAll(h.root, (e) => e.children.some((c) => c.text.startsWith("종일 (")))[0];
    const blk = bars(h.root).find((b) => b.children.some((c) => c.text.includes("09:00 겹침")))!;
    await drag(blk, ad);
    golden("interaction.day.drop-on-allday", { lines: taskLines(h), notices: [...noticeLog] });
  }
  {
    const h = open();
    await click(h.root, "일간");
    // 아래끝 레일을 끌면 종료 시각만 바뀐다(한 시간 = 64px)
    const rz = findAll(h.root, (e) => !!e.listeners.pointerdown)[0];
    rz.fire("pointerdown", { clientY: 0, pointerId: 1 });
    rz.fire("pointermove", { clientY: 64 });
    await Promise.all(rz.fire("pointerup", {}));
    await tick();
    golden("interaction.day.resize", { lines: taskLines(h), notices: [...noticeLog] });
  }

  // ── 우클릭 편집 ──
  {
    const h = open({ tasksPluginEdit: (line) => line.replace("보고서", "보고서(고침)") });
    await barByText(h.root, "보고서")!.fire("contextmenu", {})[0];
    await tick();
    golden("interaction.edit-modal", {
      sent: h.calls.editModal,
      lines: taskLines(h),
      pending: [...h.plugin.store.pending.values()],
    });
  }
  {
    // 반복(🔁) task 를 완료하면 Tasks 가 **두 줄**을 돌려준다 → 대기표에 넣지 않는다
    const h = open({ tasksPluginEdit: (line) => `- [x] ${line.slice(6)} ✅ 2026-08-06\n${line}` });
    await barByText(h.root, "반복")!.fire("contextmenu", {})[0];
    await tick();
    eq(h.plugin.store.pending.size, 0, "여러 줄이 돌아오면 낙관적 갱신을 하지 않는다");
    golden("interaction.edit-modal-recurring", { lines: taskLines(h) });
  }

  // ── 📆 GCal 일정은 읽기 전용 ──
  {
    const h = open();
    await click(h.root, "일간");
    const evBlocks = findAll(h.root, (e) => e.children.some((c) => c.text.includes("📆")));
    ok(evBlocks.length > 0, "일정 블록이 그려진다");
    for (const b of evBlocks) {
      ok(!b.draggable, "일정에는 draggable 이 없다");
      ok(!b.listeners.dragstart, "일정에는 dragstart 가 없다");
      ok(!b.children.some((c) => !!c.listeners.pointerdown), "일정에는 리사이즈 레일이 없다");
      ok(!b.listeners.contextmenu, "일정에는 우클릭 편집이 없다");
    }
    eq(h.calls.writes.length, 0, "일정 경로로는 노트를 쓰지 않는다");
  }

  // ── 피드 호출 규약 ──
  {
    const h = open();
    const before = h.calls.requestEvents.length;
    await click(h.root, "완료 ✓"); // 데이터가 그대로인 재렌더 = 캐시 적중
    ok(h.calls.requestEvents.length > before, "캐시가 맞아도 requestEvents 를 먼저 부른다(0.2.7)");
    eq(h.calls.peekEvents.length, 1, "peek 은 캐시가 막는다");
    golden("interaction.feed.windows", { request: h.calls.requestEvents, peek: h.calls.peekEvents });
  }
  {
    // 인증 전(준비 안 됨)에도 구독은 건다 — 나중에 캘린더를 고르면 알려 온다(0.2.2)
    const h = open({ feed: "not-ready" });
    const n0 = findAll(h.root, () => true).length;
    h.notifyFeed();
    await tick();
    ok(findAll(h.root, () => true).length === n0, "알림만으로는 트리 구조가 달라지지 않는다");
    ok(h.calls.subscribed > 0, "준비 전에도 구독은 건다(0.2.2)");
    eq(h.calls.requestEvents.length, 0, "준비 전에는 구간을 요청하지 않는다");
    eq(h.calls.peekEvents.length, 0, "준비 전에는 일정을 꺼내지 않는다");
  }

  // ── 카테고리를 연속 두 번 끈다(knownCats) ──
  {
    const h = open();
    await click(h.root, "Work");
    await click(h.root, "Growth");
    const cats = [...h.plugin.store.state[h.args.source].cats].sort();
    eq(cats, ["event", "hobby", "non-core", "personal", "routine"], "두 번째를 끄는 순간 첫 번째가 되살아나지 않는다");
  }

  // ── 재렌더는 보던 곳을 지킨다 · 새로 열면 이번 달 ──
  {
    const h = open();
    await click(h.root, "▶");
    await click(h.root, "▶");
    eq(byText(h.root, "2026년 10월").length, 1, "달을 두 번 넘겼다");
    h.cal.refresh(); // 인덱스 변경으로 다시 그려도
    eq(byText(h.root, "2026년 10월").length, 1, "보던 달을 지킨다");
    const again = createCalendar(h.args); // 노트를 다시 열면
    eq(byText(h.container.children[1], "2026년 8월").length, 1, "이번 달로 시작한다");
    ok(!!again.isAlive(), "새 캘린더가 살아 있다");
  }

  done();
})();
