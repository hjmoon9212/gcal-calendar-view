/*
 * Gantt 한 개의 **배선**. createCalendar 와 같은 부품을 쓴다 — 그리는 건 GanttView, 모델은 rows.
 *
 *   · 수집      data/gather.ts `gatherTasks` (대기표 = 낙관적 갱신까지 캘린더와 공유)
 *   · 쓰기      write/TaskWriteService.ts `editTask`/`openAtLine` (`vault.process` 는 거기서만)
 *   · 색        calendar/categories.ts `syncCategories` (캘린더와 같은 설정)
 *
 * 캘린더와 다른 점: 상태는 `gantt:` 접두 키로 따로 둔다(같은 source 의 캘린더와 섞이지 않게),
 * "오늘" 은 **매 렌더** 다시 계산한다(캘린더는 연 시점에 굳는 알려진 버그가 있다).
 */
import { MarkdownRenderer, Notice, Platform } from "obsidian";
import { TaskSheetModal } from "../ui/TaskSheetModal";
import { isRO } from "../core/order";
import { timeText, toMin, toHHMM } from "../core/time";
import { addDays } from "../core/dates";
import { gatherTasks } from "../data/gather";
import { syncCategories } from "../calendar/categories";
import { createWriteService } from "../write/TaskWriteService";
import { buildGantt, GanttModel, GanttPage } from "./rows";
import { renderGantt, GanttViewState, LABEL_W } from "./GanttView";
import { taskParents } from "./tree";
import { notePatch, taskChanges, DragMode, spanText, previewSpan } from "./drag";
import { toISODate } from "./noteDates";
import type { GanttGroup, GanttRow } from "./rows";
import { isZoom } from "./scale";

export interface GanttArgs {
  plugin: any;
  /** Dataview API — 페이지 수집과 luxon 을 빌려 쓴다 */
  api: any;
  container: any;
  source: string;
  notes: string[];
  sourcePath: string;
  component: any;
  startProp: string;
  endProps: string[];
  excludeTypes: string[];
}

export function createGantt(a: GanttArgs) {
  const { plugin, api, container } = a;
  const app = plugin.app;
  const L = api.luxon.DateTime;
  const root = container.createEl("div");
  root.style.width = "100%";
  root.classList.add("gcal-gantt");

  const key = "gantt:" + a.source;
  const saved = (plugin.store.state[key] = plugin.store.state[key] || {});
  const state: GanttViewState = {
    // 기본 = 주(0.10.1~). 막대·글자가 가장 크게 보이는 단위라 정렬이 한눈에 들어온다.
    // 바꾼 줌은 이 세션 동안 블록별로 기억한다(store 는 메모리 — 재시작하면 다시 주).
    zoom: isZoom(saved.zoom) ? saved.zoom : "week",
    // 창의 기준일은 **저장하지 않는다** — 열 때마다 오늘 기준(캘린더 0.6.0~ 과 같은 원칙).
    // 줌·필터는 "무엇을 보는가" 라 기억한다.
    anchor: L.now().toISODate(),
    showDone: saved.showDone !== false,
    showDoneNotes: saved.showDoneNotes !== false,
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed : [],
    // 하위 task 는 **기본 접힘** — 펼친 것만 기억한다(1단계만 보이게)
    expanded: Array.isArray(saved.expanded) ? saved.expanded : [],
    scrollLeft: undefined,
    avail: 0,
  };
  const save = () => {
    saved.zoom = state.zoom;
    saved.showDone = state.showDone;
    saved.showDoneNotes = state.showDoneNotes;
    saved.collapsed = state.collapsed;
    saved.expanded = state.expanded;
  };

  let model: GanttModel | null = null;

  /**
   * 노트 프로퍼티의 **낙관적 갱신**(0.10.0~). task 줄의 대기표(pending)와 같은 이유다 — processFrontMatter
   * 로 쓴 직후 Dataview 가 따라오기까지 몇 초 걸리고, 그 사이 옛 값으로 그리면 막대가 제자리로 튀었다가
   * 돌아온다. 쓴 값을 여기 두고 수집한 frontmatter 위에 덮는다. 인덱스가 같은 값을 주거나 15초가
   * 지나면 버린다.
   */
  const noteOverlay = new Map<string, { patch: Record<string, string>; ts: number }>();
  const OVERLAY_TTL = 15000;
  const withOverlay = (pages: GanttPage[]): GanttPage[] => {
    if (!noteOverlay.size) return pages;
    const now = Date.now();
    return pages.map((p) => {
      const ov = noteOverlay.get(p.file.path);
      if (!ov) return p;
      const fm = p.file.frontmatter ?? {};
      const caught = Object.entries(ov.patch).every(([k, v]) => toISODate(fm[k]) === v);
      if (caught || now - ov.ts > OVERLAY_TTL) {
        noteOverlay.delete(p.file.path);
        return p;
      }
      return { ...p, file: { ...p.file, frontmatter: { ...fm, ...ov.patch } } };
    });
  };
  let catColor: Record<string, string> = {};
  let catDefault = "";

  const build = (): GanttModel => {
    // 캘린더의 필터 상태를 건드리지 않도록 버리는 상태를 넘긴다 — 여기선 색만 필요하다.
    const cats = syncCategories(plugin.settings, {}, new Set());
    catColor = cats.CATCOLOR;
    catDefault = cats.CAT_DEFAULT;
    const pages = withOverlay(Array.from(api.pages(a.source) as Iterable<GanttPage>));
    const tasks = gatherTasks(pages as any, { catDefault, pending: plugin.store.pending, now: Date.now() });
    // 탭 들여쓰기 = 상하위. Dataview 가 목록 항목마다 부모 줄을 준다(file.lists, 없으면 file.tasks).
    const parents = new Map<string, Map<number, number | null>>();
    const linesByPath = new Map<string, Set<number>>();
    for (const t of tasks) {
      let set = linesByPath.get(t.path);
      if (!set) linesByPath.set(t.path, (set = new Set()));
      set.add(t.line);
    }
    for (const p of pages as any[]) {
      const set = linesByPath.get(p.file.path);
      if (!set) continue;
      const lists = p.file.lists ?? p.file.tasks ?? [];
      parents.set(p.file.path, taskParents(Array.from(lists as Iterable<any>), set));
    }
    return buildGantt(pages, tasks, {
      parents,
      startProp: a.startProp,
      endProps: a.endProps,
      excludeTypes: a.excludeTypes,
      today: L.now().toISODate(),
      showDone: state.showDone,
    });
  };

  const writer = createWriteService({
    app,
    pending: plugin.store.pending,
    rememberScroll: () => {},
    afterWrite: () => refresh(),
  });

  let queued = false;
  const render = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      renderNow();
    }, 0);
  };

  function noteHeader() {
    if (!a.notes || !a.notes.length) return null;
    const d = document.createElement("div") as any;
    d.style.cssText =
      "margin-bottom:8px;padding:6px 10px;border-left:3px solid var(--interactive-accent);" +
      "background:var(--background-secondary);border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;opacity:.9;";
    const md = a.notes.join("\n");
    try {
      if (typeof MarkdownRenderer.render === "function") MarkdownRenderer.render(app, md, d, a.sourcePath, a.component);
      else (MarkdownRenderer as any).renderMarkdown(md, d, a.sourcePath, a.component);
    } catch (e) {
      d.setText(md);
    }
    return d;
  }

  function renderNow() {
    if (!model) model = build();
    save();
    renderGantt(model, {
      root,
      state,
      today: L.now().toISODate(),
      catColor: (c) => catColor[c] || catColor[catDefault] || "#7f8c8d",
      render,
      rebuild: () => {
        model = null;
        render();
      },
      // ★ 클릭은 **캘린더와 같다**(0.9.1~) — 데스크탑: 클릭 = 원본 줄(Ctrl=새 탭 · Ctrl+Shift=분할),
      //   우클릭 = Tasks 편집 모달 / 폰: 탭 = 액션시트(📅·🛫·⏰·편집·원본 열기). 두 화면에서 같은
      //   손버릇이 같은 결과를 내야 한다 — 0.8.x~0.9.0 은 클릭 = 편집 모달이라 캘린더와 반대였다.
      taskClick: (t, e) => (mobileUi() ? openSheet(t) : writer.openAtLine(t, e)),
      taskMenu: (t) => {
        if (!mobileUi()) writer.editTask(t);
      },
      hint: mobileUi()
        ? "탭=날짜·시각 편집"
        : "드래그=기간 이동 · 양 끝=🛫/📅만\n클릭=열기 · Ctrl+클릭=새 탭 · 우클릭=편집",
      // 막대 드래그(0.10.0~) — 데스크탑만. 폰은 탭 = 액션시트라 드래그가 설 자리가 없다
      canDrag: !mobileUi(),
      dragNote,
      dragTask,
      openNote: (path, e) => {
        const f = app.vault.getAbstractFileByPath(path);
        if (f) writer.openFile(path, f, writer.openMode(e));
      },
      noteHeader,
    });
  }

  /** 노트 막대를 놓았다 → 프로퍼티(StartDate · EndDate/DueDate) */
  async function dragNote(g: GanttGroup, mode: DragMode, days: number) {
    const patch = notePatch(g, mode, days);
    if (!patch || !g.span) return;
    noteOverlay.set(g.path, { patch, ts: Date.now() });
    const ok = await writer.setNoteProps(g.path, patch);
    if (!ok) {
      noteOverlay.delete(g.path);
      refresh();
      return;
    }
    new Notice(`📄 ${g.name}: ` + Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(" · "));
  }

  /** task 막대를 놓았다 → 🛫/📅 (캘린더 드롭과 같은 applyDates — 낙관적 갱신·GCal 반영까지 같다) */
  async function dragTask(r: GanttRow, mode: DragMode, days: number) {
    const changes = taskChanges(r, mode, days);
    if (!changes) return;
    await writer.applyDates(r.task, changes);
    const t = r.task;
    const pv = t.start ? previewSpan([t.start, t.due!], mode, days) : null;
    new Notice(pv ? (mode === "move" ? "🛫~📅 " + spanText(pv) : mode === "start" ? "🛫 " + pv[0] : "📅 " + pv[1]) : "📅 " + changes.due);
  }

  /**
   * 폰 화면인가 — 캘린더의 CalendarController.isMobileUi 와 **같은 규칙**(설정 mobileUi · Platform.isPhone).
   * 매 렌더 다시 본다(설정을 바꾸면 열린 Gantt 도 따라가게).
   */
  function mobileUi(): boolean {
    const m = plugin.settings.mobileUi;
    if (m === "always") return true;
    if (m === "off") return false;
    try {
      return !!Platform.isPhone;
    } catch (e) {
      return false;
    }
  }

  /** 폰: 캘린더와 같은 액션시트. 쓰기 함수는 같은 writer 것을 넘긴다 — 모달은 노트를 직접 고치지 않는다 */
  function openSheet(t: any) {
    const today = L.now().toISODate();
    new TaskSheetModal(app, t, {
      applyDates: (x: any, c: any) => writer.applyDates(x, c),
      dropOnDate: (x: any, iso: string, shift: boolean) => writer.dropOnDate(x, iso, shift),
      writeBack: (x: any, due: string) => writer.writeBack(x, due),
      editTask: (x: any) => writer.editTask(x),
      openAtLine: (x: any, e?: any) => writer.openAtLine(x, e),
      isRO,
      colorOf: (x: any) => catColor[x.cat] || catColor[catDefault] || "#7f8c8d",
      metaLine: (x: any) => [x.cat || "-", x.path ? "📄 " + x.path.split("/").pop().replace(/\.md$/, "") : ""].filter(Boolean).join("  ·  "),
      timeText, toMin, toHHMM, addDays, todayISO: today,
      notice: (m: any) => new Notice(m),
    }).open();
  }

  function refresh() {
    model = null;
    renderNow();
  }

  // ── 화면 폭에 맞추기 ──
  // 창(주·월·분기)을 실제 블록 폭에 펼친다. 폭은 붙은 뒤에야 잴 수 있고 창 크기·사이드바에 따라
  // 바뀌므로 관찰한다. 하루 폭이 바뀔 만큼(8px 이상) 달라졌을 때만 다시 그린다.
  const measure = () => {
    const w = Math.max(0, (root.clientWidth || 0) - LABEL_W - 2);
    if (Math.abs(w - (state.avail ?? 0)) >= 8) {
      state.avail = w;
      state.scrollLeft = undefined;
      render();
    }
  };
  const RO = (globalThis as any).ResizeObserver;
  if (typeof RO === "function") {
    const ro = new RO(() => measure());
    ro.observe(root);
    a.component?.register?.(() => ro.disconnect());
  }

  renderNow(); // 첫 페인트는 동기로
  return { refresh, isAlive: () => root.isConnected };
}
