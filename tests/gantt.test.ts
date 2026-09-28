/**
 * Gantt(gcal-gantt, 0.8.0) — 순수 계산 3종 + 화면 골든 + 클릭 → 편집 모달.
 *
 * 데이터 모양은 두 볼트의 실제 프로퍼티를 흉내낸다: 시작 = StartDate, 끝 = EndDate(Hub·Book)
 * 또는 DueDate(Module·Issue), 빈 값이 흔하다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv(); // 2026-08-06(목) 12:00 로컬

import { eq, ok, done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { serializeEl, FakeEl } from "./helpers/fakeDom";
import { installDom, makeHarness } from "./helpers/renderHarness";
import { toISODate, getProp, firstDate, noteSpan } from "../src/gantt/noteDates";
import { viewWindow, stepAnchor, addMonths, windowLabel, makeScale, monthTicks, dayTicks } from "../src/gantt/scale";
import { buildGantt, filterToWindow, reachEnd, isOverrunRow } from "../src/gantt/rows";
import { statusInfo } from "../src/gantt/status";
import { resolveSource, normalizePath } from "../src/core/blockOptions";

installDom();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createGantt } = require("../src/gantt/createGantt");

const TODAY = "2026-08-06";

// ── toISODate ──
eq(toISODate("2026-08-12"), "2026-08-12", "문자열 날짜");
eq(toISODate(" 2026-08-12T09:00 "), "2026-08-12", "날짜시간 → 날짜 부분");
eq(toISODate({ toISODate: () => "2026-09-01" }), "2026-09-01", "Dataview/luxon DateTime");
eq(toISODate(new Date(2026, 0, 5)), "2026-01-05", "JS Date(로컬)");
eq(toISODate(""), null, "빈 문자열");
eq(toISODate(null), null, "null");
eq(toISODate("[[다른 노트]]"), null, "링크는 날짜가 아니다");
eq(toISODate("2026-02-30"), null, "넘치는 날짜는 거른다");
eq(toISODate(20260812), null, "숫자는 날짜가 아니다");

// ── getProp / firstDate ──
eq(getProp({ StartDate: "a" }, "startdate"), "a", "대소문자 무시");
eq(getProp({ startdate: "b" }, "StartDate"), "b", "반대로도");
eq(getProp(undefined, "x"), undefined, "객체 없음");
eq(firstDate({ EndDate: "", DueDate: "2026-09-04" }, ["EndDate", "DueDate"]), "2026-09-04", "빈 EndDate 는 건너뛰고 DueDate");
eq(firstDate({ EndDate: "2026-12-09", DueDate: "2026-09-04" }, ["EndDate", "DueDate"]), "2026-12-09", "앞의 것이 이긴다");
eq(firstDate({}, ["EndDate", "DueDate"]), null, "둘 다 없음");

// ── noteSpan ──
eq(noteSpan("2026-08-12", "2026-09-04", [], TODAY), { start: "2026-08-12", end: "2026-09-04", open: false }, "프로퍼티 둘 다");
eq(noteSpan("2026-08-01", null, [["2026-08-03", "2026-08-20"]], TODAY), { start: "2026-08-01", end: "2026-08-20", open: false }, "끝 없음 → 가장 늦은 task 📅");
eq(noteSpan("2026-07-21", null, [], TODAY), { start: "2026-07-21", end: TODAY, open: true }, "끝 없음 + task 없음 → 오늘까지 열린 기간");
eq(noteSpan("2026-08-01", null, [["2026-07-01", "2026-07-10"]], TODAY), { start: "2026-08-01", end: TODAY, open: true }, "시작 전에 끝난 task 로는 닫지 않는다");
eq(noteSpan("2026-09-10", null, [], TODAY), { start: "2026-09-10", end: "2026-09-10", open: false }, "미래 시작 + 끝 없음 → 하루짜리(거꾸로 그리지 않음)");
eq(noteSpan(null, "2026-09-30", [["2026-09-01", "2026-09-05"]], TODAY), { start: "2026-09-01", end: "2026-09-30", open: false }, "시작 없음 → 가장 이른 task");
eq(noteSpan(null, "2026-09-30", [], TODAY), { start: "2026-09-30", end: "2026-09-30", open: false }, "시작 없음 + task 없음 → 끝과 같은 날");
eq(noteSpan(null, null, [["2026-08-02", "2026-08-04"], ["2026-08-10", "2026-08-11"]], TODAY), { start: "2026-08-02", end: "2026-08-11", open: false }, "프로퍼티 없음 → task 최소~최대");
eq(noteSpan(null, null, [], TODAY), null, "아무 날짜도 없음 → null");
eq(noteSpan("2026-09-30", "2026-09-10", [], TODAY), { start: "2026-09-10", end: "2026-09-30", open: false }, "시작 > 끝이면 뒤집는다");

// ── scale ──
// 창: 주 = 5주(지난주 일요일부터) · 월 = 3개월(지난달~다음 달) · 분기 = 이번 분기부터 12개월
eq(viewWindow("week", TODAY), ["2026-07-26", "2026-08-29"], "주 창 — 오늘(목)이 든 주의 일요일 -1주 ~ +3주");
eq(viewWindow("week", "2026-08-09"), ["2026-08-02", "2026-09-05"], "일요일이면 그 주가 둘째 주");
eq(viewWindow("month", TODAY), ["2026-07-01", "2026-09-30"], "월 창 — 지난달 1일 ~ 다음 달 말");
eq(viewWindow("month", "2026-01-15"), ["2025-12-01", "2026-02-28"], "월 창 — 연도 경계 · 2월 말");
eq(viewWindow("month", "2028-02-10"), ["2028-01-01", "2028-03-31"], "윤년");
eq(viewWindow("quarter", TODAY), ["2026-07-01", "2027-06-30"], "분기 창 — 이번 분기 1일 ~ 12개월");
eq(viewWindow("quarter", "2026-12-31"), ["2026-10-01", "2027-09-30"], "분기 창 — 4분기");
eq(stepAnchor("week", TODAY, 1), "2026-08-13", "◀▶ 주 = 7일");
eq(stepAnchor("month", "2026-01-31", 1), "2026-02-01", "◀▶ 월 = 다음 달 1일(월말 넘침 없음)");
eq(stepAnchor("month", "2026-01-15", -1), "2025-12-01", "◀ 월 = 연도 경계");
eq(stepAnchor("quarter", TODAY, -1), "2026-05-01", "◀▶ 분기 = 3개월");
eq(addMonths("2026-11-01", 3), "2027-02-01", "addMonths 연도 넘김");
eq(windowLabel("month", ["2026-07-01", "2026-09-30"]), "2026.07 ~ 2026.09", "창 제목 — 월");
eq(windowLabel("week", ["2026-07-26", "2026-08-29"]), "07.26 ~ 08.29", "창 제목 — 주");

// ── statusInfo ──
eq(statusInfo("InProgress"), { label: "진행", color: "var(--interactive-accent)", bar: "active" }, "InProgress");
eq(statusInfo("planning").bar, "planned", "대소문자 무시");
eq(statusInfo("In Progress").label, "진행", "공백·하이픈 무시");
eq(statusInfo("Hold").bar, "hold", "Hold");
eq(statusInfo("Done"), { label: "완료", color: "#2e9d5b", bar: "done" }, "Done");
eq(statusInfo(""), { label: "", color: "inherit", bar: "active" }, "없음 → 빈 칸");
eq(statusInfo("Review").label, "Re", "모르는 값 → 앞 2글자");
eq(statusInfo("검토중").label, "검토", "한글도 2글자");
{
  const sc = makeScale("2026-07-25", "2026-08-27", "month");
  eq(sc.width, 34 * 10, "폭 = 일수 × 10px");
  eq(sc.x("2026-08-01"), 70, "x = 경과일 × 10px");
  eq(sc.bar("2026-08-01", "2026-08-03"), { left: 70, width: 30, clipL: false, clipR: false }, "막대 = 포함 구간");
  eq(sc.bar("2026-07-01", "2026-07-26"), { left: 0, width: 20, clipL: true, clipR: false }, "왼쪽으로 나가면 자른다");
  eq(sc.bar("2026-09-01", "2026-09-03"), null, "완전히 밖");
  eq(monthTicks(sc).map((t) => [t.label, t.x, t.width]), [["2026년 7월", 0, 70], ["8월", 70, 270]], "월 눈금 — 첫 칸만 연도");
}
{
  const sc = makeScale("2026-12-30", "2027-01-02", "week");
  eq(monthTicks(sc).map((t) => t.label), ["2026년 12월", "2027년 1월"], "1월엔 연도");
  eq(dayTicks(sc).map((t) => [t.label, t.weekday]), [["30", 3], ["31", 4], ["1", 5], ["2", 6]], "날짜 눈금 · 요일");
}

// ── resolveSource: Gantt 기본은 볼트 전체, path: 로 좁힌다 ──
eq(resolveSource({}, "0. Note/1. Project/대시보드.md", "vault"), "!\"Template\"", "Gantt 기본 = 볼트 전체");
eq(resolveSource({ scope: "folder" }, "0. Note/1. Project/대시보드.md", "vault"), "\"0. Note/1. Project\" and !\"Template\"", "scope: folder → 이 노트 폴더");
eq(resolveSource({ path: "0. Note/1. Project/저작위 고도화 2026" }, "x.md", "vault"), "\"0. Note/1. Project/저작위 고도화 2026\" and !\"Template\"", "path: → 그 경로 이하");
eq(resolveSource({ path: "a", source: "\"b\"" }, "x.md", "vault"), "\"b\"", "source 가 path 보다 이긴다");
eq(resolveSource({ path: "a" }, "z/y.md"), "\"a\" and !\"Template\"", "캘린더도 path: 를 받는다");
eq(resolveSource({}, "0. Note/x.md"), "\"0. Note\" and !\"Template\"", "캘린더 기본은 그대로 폴더");
eq(normalizePath(" \"/0. Note\\1. Project/\" "), "0. Note/1. Project", "따옴표·역슬래시·앞뒤 / 정리");
eq(normalizePath("0. Note/노트.md"), "0. Note/노트", "파일도 .md 없이");
eq(normalizePath("  "), null, "빈 값");

// ── buildGantt ──
const FM: Record<string, Record<string, any>> = {
  "P/모듈/알림톡.md": { Type: "Module", Status: "", StartDate: "2026-07-20", DueDate: "2026-08-20" },
  "P/모듈/매장음악.md": { Type: "Module", Status: "Planning", StartDate: "2026-08-10", DueDate: "2026-09-10" },
  "P/Hub.md": { Type: "Project-Hub", StartDate: "2026-04-01", EndDate: "2026-12-09" },
  "P/책/오리엔트.md": { Type: "Book", Status: "InProgress", StartDate: "2026-07-28", EndDate: "" },
  "P/이슈/미정.md": { Type: "Issue", DueDate: "" },
  "P/이슈/보류.md": { Type: "Issue", Status: "Hold", StartDate: "2026-07-01", DueDate: "2026-07-31" },
  "P/메모.md": {},
  "P/옛날.md": { Type: "Module", Status: "Done", StartDate: "2025-01-01", DueDate: "2025-02-01" },
  "P/지난모듈.md": { Type: "Module", Status: "InProgress", StartDate: "2026-05-01", DueDate: "2026-06-15" },
};
const FILES: Record<string, string> = {
  "P/모듈/알림톡.md": [
    "# 알림톡",
    "- [ ] #task #gcal/work 템플릿 API 🛫 2026-07-22 📅 2026-08-05",
    "- [x] #task #gcal/work 발송 이력 🛫 2026-07-27 📅 2026-07-30 ✅ 2026-07-30",
    "- [ ] #task #gcal/work 리뷰 📅 2026-08-18",
    "- [ ] #task #gcal/work 날짜 미정",
  ].join("\n"),
  "P/모듈/매장음악.md": [
    "- [ ] #task #gcal/growth 요건 확인 📅 2026-08-12",
    "- [ ] #task #gcal/growth 추가 검수 🛫 2026-09-05 📅 2026-09-20",
    "- [x] #task #gcal/growth 끝난 검수 📅 2026-09-25 ✅ 2026-09-25",
  ].join("\n"),
  "P/Hub.md": "",
  "P/책/오리엔트.md": "",
  "P/이슈/미정.md": "- [ ] #task 논의 필요",
  "P/이슈/보류.md": "",
  "P/메모.md": "그냥 메모",
  "P/옛날.md": "",
  "P/지난모듈.md": "- [ ] #task #gcal/work 밀린 연동 📅 2026-07-10",
};

{
  const pages = Object.keys(FILES).map((path) => ({ file: { path, frontmatter: FM[path] } }));
  const t = (path: string, line: number, title: string, start: string | null, due: string | null, done = false): any => ({
    kind: "task", uid: path + line, path, line, text: title, title, due, start, tStart: null, tEnd: null, cat: "work", done, cancelled: false, bookmark: false, recurring: false,
  });
  const tasks = [
    t("P/모듈/알림톡.md", 1, "템플릿 API", "2026-07-22", "2026-08-05"),
    t("P/모듈/알림톡.md", 2, "발송 이력", "2026-07-27", "2026-07-30", true),
    t("P/모듈/알림톡.md", 3, "리뷰", null, "2026-08-18"),
    t("P/모듈/알림톡.md", 4, "날짜 미정", null, null),
    t("P/모듈/매장음악.md", 0, "요건 확인", null, "2026-08-12"),
    t("P/모듈/매장음악.md", 1, "추가 검수", "2026-09-05", "2026-09-20"),
    t("P/모듈/매장음악.md", 2, "끝난 검수", null, "2026-09-25", true),
    t("P/지난모듈.md", 0, "밀린 연동", null, "2026-07-10"),
    t("P/이슈/미정.md", 0, "논의 필요", null, null),
  ];
  const O = { startProp: "StartDate", endProps: ["EndDate", "DueDate"], excludeTypes: [], today: TODAY, showDone: true };
  const m = buildGantt(pages as any, tasks, O);
  eq(m.groups.map((g) => g.name), ["옛날", "Hub", "지난모듈", "보류", "알림톡", "오리엔트", "매장음악"], "시작일순 정렬 · 메모(날짜도 task도 없음)는 빠진다");
  eq(m.undated.map((g) => g.name), ["미정"], "날짜 없는 노트는 따로");
  const al = m.groups.find((g) => g.name === "알림톡")!;
  eq(al.rows.map((r) => [r.task.title, r.milestone]), [["템플릿 API", false], ["발송 이력", false], ["리뷰", true]], "task 행: 시작일순 · 📅만 = 마일스톤");
  eq(al.undated, 1, "날짜 없는 task 는 개수로만");
  eq(m.groups.find((g) => g.name === "오리엔트")!.span, { start: "2026-07-28", end: TODAY, open: true }, "읽는 중인 책 = 열린 기간");
  eq(m.groups.find((g) => g.name === "보류")!.status, "Hold", "Status 원문");

  const m2 = buildGantt(pages as any, tasks, { ...O, showDone: false, excludeTypes: ["project-hub"] });
  eq(m2.groups.map((g) => g.name), ["옛날", "지난모듈", "보류", "알림톡", "오리엔트", "매장음악"], "exclude-type 은 대소문자 무시");
  eq(m2.groups.find((g) => g.name === "알림톡")!.rows.map((r) => r.task.title), ["템플릿 API", "리뷰"], "완료 숨김은 행에서만");
  eq(m2.groups.find((g) => g.name === "알림톡")!.span, { start: "2026-07-20", end: "2026-08-20", open: false }, "구간은 프로퍼티 그대로");

  // ── 종료일 초과 ──
  const ms = m.groups.find((g) => g.name === "매장음악")!;
  eq(ms.overrun, { until: "2026-09-20", count: 1 }, "종료일(09-10)보다 늦은 미완료 task 만 — 완료된 09-25 는 제외");
  eq(ms.rows.map((r) => isOverrunRow(ms, r)), [false, true, false], "초과 행 표시는 미완료 + 📅 > 종료일");
  eq(reachEnd(ms), "2026-09-20", "차지하는 끝 = 초과분까지");
  eq(al.overrun, null, "초과 없음");
  eq(m.groups.find((g) => g.name === "오리엔트")!.overrun, null, "열린 기간은 초과가 없다");
  {
    const pg = [{ file: { path: "X.md", frontmatter: { StartDate: "2026-08-01" } } }];
    const m3 = buildGantt(pg as any, [t("X.md", 0, "a", null, "2026-08-20"), t("X.md", 1, "b", null, "2026-08-25")], O);
    eq(m3.groups[0].overrun, null, "끝을 task 로 메웠으면 초과가 없다");
  }

  // ── 창 필터 ──
  const w = filterToWindow(m, "2026-07-01", "2026-09-30", true);
  eq(w.groups.map((v) => v.group.name), ["Hub", "지난모듈", "보류", "알림톡", "오리엔트", "매장음악"], "창 밖(옛날)은 빠진다 · 지난모듈은 초과분(07-10)으로 창에 걸려 남는다");
  eq(w.total, 7, "전체 수는 필터 전");
  const w2 = filterToWindow(m, "2026-08-01", "2026-08-31", true);
  const al2 = w2.groups.find((v) => v.group.name === "알림톡")!;
  eq([al2.rows.map((r) => r.task.title), al2.outside], [["템플릿 API", "리뷰"], 1], "창 밖 task 행은 숨기고 수를 센다");
  eq(filterToWindow(m, "2024-01-01", "2027-12-31", false).groups.map((v) => v.group.name).includes("옛날"), false, "완료 노트 숨김");
}

// ── 화면 · 조작 ──
const tick = () => new Promise((r) => setTimeout(r, 0));

function open(extra: { excludeTypes?: string[]; notes?: string[]; tasksPluginEdit?: (l: string) => string } = {}) {
  const h = makeHarness({ files: FILES, tasksPluginEdit: extra.tasksPluginEdit });
  const base = h.args.api.pages;
  const api = {
    ...h.args.api,
    pages: (src: string) => base(src).map((p: any) => ({ ...p, file: { ...p.file, frontmatter: FM[p.file.path] } })),
  };
  const g = createGantt({
    plugin: h.plugin, api, container: h.container, source: "!\"Template\"", notes: extra.notes ?? [],
    sourcePath: "P/대시보드.md", component: h.args.component,
    startProp: "StartDate", endProps: ["EndDate", "DueDate"], excludeTypes: extra.excludeTypes ?? [],
  });
  return { ...h, g, tree: () => serializeEl(h.container) };
}

function find(root: FakeEl, pred: (e: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (e: FakeEl) => {
    if (pred(e)) out.push(e);
    e.children.forEach(walk);
  };
  walk(root);
  return out;
}

(async () => {
  {
    const c = open();
    golden("render.gantt.month", c.tree());
    await find(c.container, (e) => e.tag === "button" && e.text === "주")[0].onclick!();
    await tick();
    golden("render.gantt.week", c.tree());
  }

  // 접기 — 행이 사라지고 개수가 붙는다
  {
    const c = open({ excludeTypes: ["Project-Hub"] });
    const tog = find(c.container, (e) => e.text === "▾" && !!e.parent?.children.some((x) => x.text === "📄 알림톡"))[0];
    tog.onclick!();
    await tick();
    ok(find(c.container, (e) => e.text === "템플릿 API").length === 0, "접으면 task 행이 사라진다");
    ok(find(c.container, (e) => e.text === "(3)").length === 1, "접힌 그룹에 행 개수");
    eq(c.plugin.store.state["gantt:!\"Template\""].collapsed, ["P/모듈/알림톡.md"], "접힘은 블록 상태에 남는다");
  }

  // 클릭 → Tasks 편집 모달 → 줄 갱신(쓰기는 TaskWriteService 한 곳)
  {
    const c = open({ tasksPluginEdit: (l) => l.replace("📅 2026-08-05", "📅 2026-08-07") });
    const lab = find(c.container, (e) => e.tag === "span" && e.text === "템플릿 API")[0];
    await lab.onclick!({});
    await tick();
    eq(c.calls.editModal, ["- [ ] #task #gcal/work 템플릿 API 🛫 2026-07-22 📅 2026-08-05"], "클릭 = 편집 모달");
    eq(c.calls.writes.length, 1, "모달 결과를 한 번 쓴다");
    ok(c.files["P/모듈/알림톡.md"].includes("📅 2026-08-07"), "노트 줄이 바뀐다");
    ok(find(c.container, (e) => e.title?.includes("📅 2026-08-07")).length > 0, "다시 그린 막대가 새 날짜(낙관적 갱신)");
  }

  // Ctrl+클릭 → 원본 줄 열기 · 노트 이름 클릭 → 노트 열기
  {
    const c = open();
    await find(c.container, (e) => e.tag === "span" && e.text === "리뷰")[0].onclick!({ ctrlKey: true });
    eq(c.calls.opened.map((o) => [o.path, o.line]), [["P/모듈/알림톡.md", 3]], "Ctrl+클릭 = 원본 줄");
    eq(c.calls.editModal.length, 0, "모달은 안 뜬다");
    await find(c.container, (e) => e.text === "📄 매장음악")[0].onclick!({});
    await tick();
    eq(c.calls.opened[1].path, "P/모듈/매장음악.md", "노트 이름 = 노트 열기");
  }

  // 상태 칸 · 종료일 초과 표시
  {
    const c = open();
    ok(find(c.container, (e) => e.text === "계획").length === 1, "Planning → 상태 칸 「계획」");
    ok(find(c.container, (e) => e.text === "진행").length === 2, "InProgress 노트 둘");
    const name = find(c.container, (e) => e.text === "📄 매장음악")[0];
    ok(name.style.cssText.includes("color:#e05a7a"), "초과 노트 이름은 붉게");
    ok(find(c.container, (e) => (e.title || "").startsWith("⚠ 종료일(2026-09-10)보다 늦은 task 1개")).length === 1, "붉은 점선 연장 + 툴팁");
    ok(!find(c.container, (e) => e.text === "📄 알림톡")[0].style.cssText.includes("#e05a7a"), "초과 없는 노트는 그대로");
    ok(find(c.container, (e) => e.text === "📄 옛날").length === 0, "창 밖 노트는 안 보인다");
    ok(find(c.container, (e) => e.text === "노트 6/7개").length === 1, "보이는 수/전체");
  }

  // ◀ ▶ · 오늘 · 완료 노트
  {
    const c = open();
    const btn = (t: string) => find(c.container, (e) => e.tag === "button" && e.text === t)[0];
    ok(find(c.container, (e) => e.text === "2026.07 ~ 2026.09").length === 1, "월 창 제목");
    for (let i = 0; i < 18; i++) {
      await btn("◀").onclick!();
      await tick();
    }
    ok(find(c.container, (e) => e.text === "2025.01 ~ 2025.03").length === 1, "◀ 18번 = 18개월 전");
    ok(find(c.container, (e) => e.text === "📄 옛날").length === 1, "그 창에서는 옛 노트가 보인다");
    await btn("완료 노트 ✓").onclick!();
    await tick();
    ok(find(c.container, (e) => e.text === "📄 옛날").length === 0, "완료 노트 숨김");
    eq(c.plugin.store.state["gantt:!\"Template\""].showDoneNotes, false, "완료 노트 토글은 기억한다");
    await btn("오늘").onclick!();
    await tick();
    ok(find(c.container, (e) => e.text === "2026.07 ~ 2026.09").length === 1, "오늘 = 창을 되돌린다");
  }

  // 날짜 없는 노트 줄 · note:
  {
    const c = open({ notes: ["- 설명"] });
    ok(find(c.container, (e) => e.text === "📭 날짜 없음: ").length === 1, "날짜 없음 줄");
    ok(find(c.container, (e) => e.tag === "a" && e.text === "미정").length === 1, "날짜 없는 노트 링크");
  }

  done();
})();
