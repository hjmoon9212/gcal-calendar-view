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
import { MarkdownRenderer } from "obsidian";
import { gatherTasks } from "../data/gather";
import { syncCategories } from "../calendar/categories";
import { createWriteService } from "../write/TaskWriteService";
import { buildGantt, GanttModel, GanttPage } from "./rows";
import { renderGantt, GanttViewState } from "./GanttView";
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
    zoom: isZoom(saved.zoom) ? saved.zoom : "month",
    showDone: saved.showDone !== false,
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed : [],
    scrollLeft: undefined, // 열 때마다 오늘로 — 캘린더(0.6.0~)와 같은 원칙
  };
  const save = () => {
    saved.zoom = state.zoom;
    saved.showDone = state.showDone;
    saved.collapsed = state.collapsed;
  };

  let model: GanttModel | null = null;
  let catColor: Record<string, string> = {};
  let catDefault = "";

  const build = (): GanttModel => {
    // 캘린더의 필터 상태를 건드리지 않도록 버리는 상태를 넘긴다 — 여기선 색만 필요하다.
    const cats = syncCategories(plugin.settings, {}, new Set());
    catColor = cats.CATCOLOR;
    catDefault = cats.CAT_DEFAULT;
    const pages = Array.from(api.pages(a.source) as Iterable<GanttPage>);
    const tasks = gatherTasks(pages as any, { catDefault, pending: plugin.store.pending, now: Date.now() });
    return buildGantt(pages, tasks, {
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
      editTask: (t) => writer.editTask(t),
      openAtLine: (t, e) => writer.openAtLine(t, e),
      openNote: (path, e) => {
        const f = app.vault.getAbstractFileByPath(path);
        if (f) writer.openFile(path, f, writer.openMode(e));
      },
      isMod: (e) => !!(e && (e.ctrlKey || e.metaKey)),
      noteHeader,
    });
  }

  function refresh() {
    model = null;
    renderNow();
  }

  renderNow(); // 첫 페인트는 동기로
  return { refresh, isAlive: () => root.isConnected };
}
