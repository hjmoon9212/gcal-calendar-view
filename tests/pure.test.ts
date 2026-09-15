/**
 * 모듈 레벨 순수 함수의 **현재 동작**을 고정한다(0.7.0 — 코드를 옮기기 전의 안전망).
 *
 * 0.7.x 는 main.js 한 파일(2557줄)을 src/ 모듈로 나누는 동작 보존 리팩토링이다. 옮기면서
 * 결과가 한 글자라도 달라지면 여기서 걸린다. 지금은 main.js 가 내보내는 `__test` 로 꺼내 쓰고,
 * 함수가 모듈로 옮겨 가면 import 경로만 바꾼다 — 단언은 그대로 둔다.
 */
import { eq, done } from "./helpers/assert";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require("../src/main.js").__test;

// ── parseOptions: 코드블록 본문 ──
eq(T.parseOptions(""), { note: [] }, "빈 블록 → note 만");
eq(T.parseOptions(undefined), { note: [] }, "undefined 도 빈 블록");
eq(
  T.parseOptions("scope: vault\nSource: \"0. Note\" and !\"X\"\n# 주석: 무시\nnote: - 첫 줄\nnote:\nnote: - 둘째 줄\n쌍점 없음\n gcal : Growth, Work "),
  { note: ["- 첫 줄", "- 둘째 줄"], scope: "vault", source: "\"0. Note\" and !\"X\"", gcal: "Growth, Work" },
  "키는 소문자 · # 줄 무시 · note 는 여러 줄(빈 값 버림) · 쌍점 없는 줄 무시 · 앞뒤 공백 제거"
);
eq(T.parseOptions("source: a: b"), { note: [], source: "a: b" }, "값 안의 쌍점은 첫 쌍점만 가른다");

// ── parseList ──
eq(T.parseList("Growth,  Work , ,Event"), ["Growth", "Work", "Event"], "쉼표 목록 · 빈 항목 버림");
eq(T.parseList(undefined), [], "undefined → []");
eq(T.parseList(""), [], "빈 문자열 → []");

// ── resolveSource: 스코프 ──
eq(T.resolveSource({ scope: "vault" }, "0. Note/a.md"), "!\"Template\"", "scope: vault → 볼트 전체(Template 제외)");
eq(T.resolveSource({ scope: "VAULT" }, "a.md"), "!\"Template\"", "scope 는 대소문자 무시");
eq(T.resolveSource({}, "0. Note/1. Project/x.md"), "\"0. Note/1. Project\" and !\"Template\"", "기본 = 노트가 놓인 폴더 이하");
eq(T.resolveSource({}, "root.md"), "!\"Template\"", "볼트 루트의 노트 → 볼트 전체");
eq(T.resolveSource({}, undefined), "!\"Template\"", "경로를 모르면 볼트 전체");
eq(T.resolveSource({ source: "\"A\" and !\"B\"", scope: "vault" }, "z/y.md"), "\"A\" and !\"B\"", "source 가 scope 보다 이긴다(Template 을 덧붙이지 않는다)");

// ── resolveCalFilter: 블록별 GCal 캘린더 필터 ──
for (const v of ["off", "OFF", " none ", "-"]) {
  eq(T.resolveCalFilter({ gcal: v }), { off: true, include: [], exclude: [] }, `gcal: ${JSON.stringify(v)} → 끔`);
}
eq(T.resolveCalFilter({ gcal: "Growth, work " }), { off: false, include: ["growth", "work"], exclude: [] }, "화이트리스트 · 소문자·공백 정규화");
eq(T.resolveCalFilter({ "gcal-exclude": "Event" }), { off: false, include: [], exclude: ["event"] }, "블랙리스트만");
eq(T.resolveCalFilter({ calendars: "A", "gcal-exclude": "B" }), { off: false, include: ["a"], exclude: ["b"] }, "옛 이름 calendars: 별칭");
eq(T.resolveCalFilter({ "include-calendars": "X", "exclude-calendars": "Y" }), { off: false, include: ["x"], exclude: ["y"] }, "옛 이름 include-/exclude-calendars: 별칭");
eq(T.resolveCalFilter({ gcal: "New", calendars: "Old" }), { off: false, include: ["new"], exclude: [] }, "새 이름이 옛 이름을 이긴다");
eq(T.resolveCalFilter({ gcal: "", calendars: "Old" }), { off: false, include: [], exclude: [] }, "빈 gcal: 도 '정의됨' 이라 옛 이름을 가린다(현재 동작)");
eq(T.resolveCalFilter({ exclude: "Event" }), { off: false, include: [], exclude: [] }, "exclude: 단독은 받지 않는다");
eq(T.resolveCalFilter({}), { off: false, include: [], exclude: [] }, "옵션 없음");

// ── 색: categoryColorMap · resolveEventColorInfo ──
const S = {
  ...T.DEFAULT_SETTINGS,
  categories: [
    { key: "Growth", label: "Growth", color: "#0B8043" },
    { key: "work", label: "Work", color: "#3f51b5" },
    { key: "", label: "빈 키", color: "#000000" },
    null,
  ],
  eventColors: { "cal-own": "#AABBCC", "cal-bad": "red" },
  eventColor: "#123456",
};
const cats = T.categoryColorMap(S);
eq(cats, { growth: "#0B8043", work: "#3f51b5" }, "카테고리 키는 소문자 · 빈 키/null 버림 · 색은 그대로");
eq(T.categoryColorMap({}), {}, "categories 없음 → {}");
eq(T.resolveEventColorInfo(S, cats, "cal-own", "Growth"), { color: "#aabbcc", source: "직접 지정", cat: null }, "① 직접 지정이 먼저 · hex 소문자화");
eq(
  T.resolveEventColorInfo(S, cats, "cal-bad", " GROWTH "),
  { color: "#0b8043", source: "카테고리 «growth» 따름", cat: "growth" },
  "② 잘못된 직접 지정은 건너뛰고 같은 이름 카테고리"
);
eq(
  T.resolveEventColorInfo(S, cats, "x", "Holidays in South Korea"),
  { color: "#123456", source: "기본 색 따름 (같은 이름의 카테고리 없음)", cat: null },
  "③ 카테고리 없으면 eventColor"
);
eq(
  T.resolveEventColorInfo({ ...S, eventColor: "nope" }, cats, "x", "Z").color,
  "#7f8c8d",
  "eventColor 도 잘못됐으면 코드 기본 회색"
);

// ── dayRank · byDayOrder: 하루 안의 정렬 ──
const ev0 = { kind: "event", due: "2026-08-07", tStart: null, tEnd: null, n: "종일 일정" };
const tk2 = { kind: "task", due: "2026-08-06", tStart: null, tEnd: null, n: "종일 task" };
const tk1a = { kind: "task", due: "2026-08-07", tStart: 600, tEnd: 660, n: "10시 task" };
const ev1 = { kind: "event", due: "2026-08-07", tStart: 540, tEnd: 600, n: "9시 일정" };
const tk1b = { kind: "task", due: "2026-08-07", tStart: 600, tEnd: 630, n: "10시 짧은 task" };
eq([T.dayRank(ev0), T.dayRank(ev1), T.dayRank(tk2)], [0, 1, 2], "종일 일정 0 · 시각 있음 1 · 종일 task 2");
eq(
  [tk2, tk1a, ev1, ev0, tk1b].sort(T.byDayOrder).map((x) => x.n),
  ["종일 일정", "9시 일정", "10시 짧은 task", "10시 task", "종일 task"],
  "순위 → 시작 시각 → 종료 시각"
);
eq(
  [
    { kind: "task", due: "2026-08-09", tStart: null },
    { kind: "task", due: "", tStart: null },
    { kind: "task", due: "2026-08-01", tStart: null },
  ].sort(T.byDayOrder).map((x) => x.due),
  ["", "2026-08-01", "2026-08-09"],
  "같은 순위면 마감일순(없는 것이 먼저)"
);

// ── layoutTimeLanes: 겹침 레인 ──
const lanes = (arr: { n: string; tStart: number; tEnd: number }[]) =>
  T.layoutTimeLanes(arr).map((p: any) => `${p.t.n}:${p.lane}/${p.lanes}×${p.span}`);
eq(
  lanes([
    { n: "A", tStart: 540, tEnd: 600 },
    { n: "B", tStart: 600, tEnd: 660 },
  ]),
  ["A:0/1×1", "B:0/1×1"],
  "맞닿음(09-10 / 10-11)은 겹침이 아니다 — 둘 다 전폭"
);
eq(
  lanes([
    { n: "A", tStart: 540, tEnd: 600 },
    { n: "B", tStart: 570, tEnd: 660 },
    { n: "C", tStart: 630, tEnd: 690 },
  ]),
  ["A:0/2×1", "B:1/2×1", "C:0/2×1"],
  "연쇄(A–B–C 를 B 가 잇는다)는 한 무리"
);
eq(
  lanes([
    { n: "M1", tStart: 540, tEnd: 600 },
    { n: "M2", tStart: 540, tEnd: 600 },
    { n: "M3", tStart: 540, tEnd: 600 },
    { n: "저녁", tStart: 1200, tEnd: 1260 },
  ]),
  ["M1:0/3×1", "M2:1/3×1", "M3:2/3×1", "저녁:0/1×1"],
  "오전 3중 겹침이 저녁 단독 일정 폭을 줄이지 않는다"
);
eq(
  lanes([
    { n: "긴", tStart: 540, tEnd: 720 },
    { n: "짧1", tStart: 540, tEnd: 570 },
    { n: "짧2", tStart: 600, tEnd: 630 },
    { n: "넓힐", tStart: 660, tEnd: 690 },
  ]),
  ["짧1:0/2×1", "긴:1/2×1", "짧2:0/2×1", "넓힐:0/2×1"],
  "정렬은 시작 → 종료 · first-fit 레인"
);
eq(T.layoutTimeLanes([]), [], "빈 입력");

// ── DEFAULT_SETTINGS ──
eq(
  T.DEFAULT_SETTINGS,
  {
    categories: [
      { key: "work", label: "Work", color: "#3f51b5" },
      { key: "growth", label: "Growth", color: "#0b8043" },
      { key: "routine", label: "Routine", color: "#9e69af" },
      { key: "personal", label: "Personal", color: "#e67c73" },
      { key: "hobby", label: "Hobby", color: "#e4c441" },
      { key: "event", label: "Event", color: "#a2845e" },
      { key: "non-core", label: "Non-core", color: "#a79b8e" },
    ],
    defaultCategory: "personal",
    eventColors: {},
    eventColor: "#7f8c8d",
    mobileUi: "auto",
  },
  "기본 설정(키 순서 포함)"
);

done();
