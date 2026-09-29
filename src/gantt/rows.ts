/*
 * 페이지 + task → Gantt 그룹/행 모델. 순수 계산이라 DOM 도 설정도 안 본다.
 *
 * **노트 1개 = 그룹 1개.** 그룹 막대는 노트 프로퍼티(noteDates.ts), 행은 그 노트의 `#task`.
 * task 막대 규칙은 캘린더와 같다 — 📅 가 있어야 그린다(🛫 만 있는 줄은 달력에도 안 나온다).
 */
import type { TaskItem } from "../data/gather";
import { spanOf } from "../core/dates";
import { firstDate, getProp, noteSpan, NoteSpan, writeKey } from "./noteDates";
import { overlaps } from "./scale";
import { isDoneStatus } from "./status";
import { buildTaskTree, TreeRow } from "./tree";

export interface GanttPage {
  file: { path: string; name?: string; frontmatter?: Record<string, any> };
  [key: string]: any;
}

export type GanttRow = TreeRow;

export interface GanttGroup {
  path: string;
  name: string;
  /** null 이면 날짜 없음 */
  span: NoteSpan | null;
  /** 프로퍼티에서 왔는가(아니면 task 로 메운 구간) */
  fromProps: boolean;
  status: string;
  rows: GanttRow[];
  /** 날짜가 없어 행으로 못 그린 task 수 */
  undated: number;
  /**
   * 종료일 초과 — 프로퍼티 종료일보다 📅 가 늦은 **미완료** task. 없으면 null.
   * 끝을 task 로 메웠거나 열린 기간이면 정의상 초과가 없다.
   */
  overrun: { until: string; count: number } | null;
  /**
   * 막대를 끌어 고칠 때 쓸 프로퍼티(0.10.0~). 키는 노트에 있는 이름 그대로.
   * `hasStart`/`hasEnd` = 그 끝이 프로퍼티 값에서 왔는가 — 아니면(task 로 메움·열린 기간)
   * 기간째 이동에서 그 끝은 쓰지 않는다.
   */
  props: { startKey: string; endKey: string; hasStart: boolean; hasEnd: boolean };
}

export interface GanttOptions {
  startProp: string;
  endProps: string[];
  /** 이 Type 인 노트는 뺀다(소문자 비교) */
  excludeTypes: string[];
  today: string;
  /** 완료·취소 task 행을 그릴 것인가(노트 구간 계산에는 항상 넣는다) */
  showDone: boolean;
  /** 경로 → (줄 → 가장 가까운 task 조상 줄). 없으면 전부 최상위 */
  parents?: Map<string, Map<number, number | null>>;
}

export interface GanttModel {
  groups: GanttGroup[];
  /** 날짜가 하나도 없어 막대를 못 그린 노트 */
  undated: GanttGroup[];
}

const nameOf = (p: GanttPage) => p.file.name || p.file.path.split("/").pop()!.replace(/\.md$/i, "");

/**
 * 프로퍼티는 frontmatter **원문**에서 먼저 찾는다 — Dataview 의 정규화 사본(`page[키]`)은
 * 인라인 필드까지 섞이고 키를 소문자로도 복제한다. 원문에 없을 때만 그쪽을 본다.
 */
function propDate(p: GanttPage, names: string[]): string | null {
  return firstDate(p.file.frontmatter, names) ?? firstDate(p, names);
}

function propText(p: GanttPage, name: string): string {
  const v = getProp(p.file.frontmatter, name) ?? getProp(p, name);
  return v === null || v === undefined ? "" : String(v).trim();
}

const byGroup = (a: GanttGroup, b: GanttGroup) => {
  const sa = a.span!, sb = b.span!;
  if (sa.start !== sb.start) return sa.start < sb.start ? -1 : 1;
  if (sa.end !== sb.end) return sa.end < sb.end ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

export function buildGantt(pages: GanttPage[], tasks: TaskItem[], o: GanttOptions): GanttModel {
  const byPath = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    const l = byPath.get(t.path);
    if (l) l.push(t);
    else byPath.set(t.path, [t]);
  }
  const excluded = new Set(o.excludeTypes.map((s) => s.toLowerCase()));

  const groups: GanttGroup[] = [];
  const undated: GanttGroup[] = [];
  for (const p of pages) {
    const path = p.file.path;
    if (excluded.size && excluded.has(propText(p, "Type").toLowerCase())) continue;
    const pts = byPath.get(path) ?? [];
    const pStart = propDate(p, [o.startProp]);
    const pEnd = propDate(p, o.endProps);
    // 프로퍼티도 task 도 없는 노트는 아예 안 나온다 — 볼트 전체 범위에서 모든 노트가
    // 「날짜 없음」에 쏟아지지 않게.
    if (!pStart && !pEnd && !pts.length) continue;

    // 노트 구간·초과는 트리와 무관하게 **날짜 있는 task 전부**로 계산한다
    const all: { task: TaskItem; span: [string, string] }[] = [];
    for (const t of pts) {
      const s = t.due ? spanOf(t) : null;
      if (s) all.push({ task: t, span: s });
    }
    const span = noteSpan(pStart, pEnd, all.map((r) => r.span), o.today);
    let overrun: GanttGroup["overrun"] = null;
    if (span && pEnd && !span.open) {
      for (const r of all) {
        if (r.task.done || r.task.cancelled || r.span[1] <= span.end) continue;
        if (!overrun) overrun = { until: r.span[1], count: 0 };
        overrun.count++;
        if (r.span[1] > overrun.until) overrun.until = r.span[1];
      }
    }
    const tree = buildTaskTree(pts, o.parents?.get(path) ?? new Map(), {
      noteEnd: span && pEnd && !span.open ? span.end : null,
      showDone: o.showDone,
    });
    const rows = tree.rows;
    const undatedCount = tree.undated;
    const g: GanttGroup = {
      path,
      name: nameOf(p),
      span,
      fromProps: !!(pStart || pEnd),
      status: propText(p, "Status"),
      rows,
      undated: undatedCount,
      overrun,
      props: (() => {
        const fm = p.file.frontmatter;
        const sk = writeKey(fm, [o.startProp]);
        const ek = writeKey(fm, o.endProps);
        return { startKey: sk.key, endKey: ek.key, hasStart: !!pStart, hasEnd: !!pEnd };
      })(),
    };
    (span ? groups : undated).push(g);
  }
  groups.sort(byGroup);
  undated.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { groups, undated };
}

/** 노트가 **차지하는** 끝 — 초과분까지. 창 판정에 쓴다(종료일은 지났어도 task 가 남은 노트가 사라지지 않게). */
export const reachEnd = (g: GanttGroup): string =>
  g.overrun && g.overrun.until > g.span!.end ? g.overrun.until : g.span!.end;

export interface VisibleGroup {
  group: GanttGroup;
  rows: GanttRow[];
  /** 창 밖이라 숨긴 task 행 수 */
  outside: number;
}

export interface WindowView {
  groups: VisibleGroup[];
  /** 날짜가 있는 노트 전체 수(창·완료 노트 필터 전) */
  total: number;
}

/**
 * 보기 기간(창)과 겹치는 노트만, 그 안에서도 창과 겹치는 task 행만.
 * `showDoneNotes` 가 false 면 Status 가 Done 인 노트를 뺀다.
 */
export function filterToWindow(m: GanttModel, from: string, to: string, showDoneNotes: boolean): WindowView {
  const groups: VisibleGroup[] = [];
  for (const g of m.groups) {
    if (!showDoneNotes && isDoneStatus(g.status)) continue;
    if (!overlaps(g.span!.start, reachEnd(g), from, to)) continue;
    // 자손까지 포함한 구간(reach)으로 본다 — 부모 reach 가 자손을 덮으므로 자손이 보이면 부모도 보인다
    const rows = g.rows.filter((r) => overlaps(r.reach[0], r.reach[1], from, to));
    groups.push({ group: g, rows, outside: g.rows.length - rows.length });
  }
  return { groups, total: m.groups.length };
}
