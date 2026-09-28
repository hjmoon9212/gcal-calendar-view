/*
 * 페이지 + task → Gantt 그룹/행 모델. 순수 계산이라 DOM 도 설정도 안 본다.
 *
 * **노트 1개 = 그룹 1개.** 그룹 막대는 노트 프로퍼티(noteDates.ts), 행은 그 노트의 `#task`.
 * task 막대 규칙은 캘린더와 같다 — 📅 가 있어야 그린다(🛫 만 있는 줄은 달력에도 안 나온다).
 */
import type { TaskItem } from "../data/gather";
import { spanOf } from "../core/dates";
import { firstDate, getProp, noteSpan, NoteSpan } from "./noteDates";

export interface GanttPage {
  file: { path: string; name?: string; frontmatter?: Record<string, any> };
  [key: string]: any;
}

export interface GanttRow {
  task: TaskItem;
  span: [string, string];
  /** 📅 만 있는 task — 막대 대신 ◆ */
  milestone: boolean;
}

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
}

export interface GanttOptions {
  startProp: string;
  endProps: string[];
  /** 이 Type 인 노트는 뺀다(소문자 비교) */
  excludeTypes: string[];
  today: string;
  /** 완료·취소 task 행을 그릴 것인가(노트 구간 계산에는 항상 넣는다) */
  showDone: boolean;
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

const byTask = (a: GanttRow, b: GanttRow) =>
  a.span[0] !== b.span[0] ? (a.span[0] < b.span[0] ? -1 : 1)
  : a.span[1] !== b.span[1] ? (a.span[1] < b.span[1] ? -1 : 1)
  : a.task.line - b.task.line;

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

    const all: GanttRow[] = [];
    let undatedCount = 0;
    for (const t of pts) {
      const s = t.due ? spanOf(t) : null;
      if (!s) {
        undatedCount++;
        continue;
      }
      all.push({ task: t, span: s, milestone: !t.start });
    }
    const span = noteSpan(pStart, pEnd, all.map((r) => r.span), o.today);
    const rows = (o.showDone ? all : all.filter((r) => !r.task.done && !r.task.cancelled)).sort(byTask);
    const g: GanttGroup = {
      path,
      name: nameOf(p),
      span,
      fromProps: !!(pStart || pEnd),
      status: propText(p, "Status"),
      rows,
      undated: undatedCount,
    };
    (span ? groups : undated).push(g);
  }
  groups.sort(byGroup);
  undated.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { groups, undated };
}

/** 축을 정할 때 덮어야 하는 모든 구간(그룹 막대 + 보이는 task 막대). */
export function allSpans(m: GanttModel): [string, string][] {
  const out: [string, string][] = [];
  for (const g of m.groups) {
    out.push([g.span!.start, g.span!.end]);
    for (const r of g.rows) out.push(r.span);
  }
  return out;
}
