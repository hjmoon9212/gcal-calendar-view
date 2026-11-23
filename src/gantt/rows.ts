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
import { buildTaskTree, Progress, TreeRow } from "./tree";

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
  /** 1단계(최상위) task 완료/전체 — 취소 제외, 날짜 없는 것도 센다(0.11.0~). task 가 없으면 null */
  progress: Progress | null;
  /** 속한 프로젝트 키(허브 노트 경로). 없으면 null */
  project: string | null;
  /** 이 노트가 프로젝트 허브 자신인가 */
  isHub: boolean;
}

/** `Project:` 프로퍼티가 가리키는 허브(0.11.0~). key = 허브 노트 경로 */
export interface ProjectRef {
  key: string;
  name: string;
}

/**
 * 프로젝트 = `Project:` 링크가 같은 노트들의 묶음(0.11.0~). 허브 노트의 프로퍼티가 막대,
 * 허브를 못 읽으면 자식 노트 구간의 합.
 */
export interface GanttProject {
  /** 허브 경로. 「(프로젝트 없음)」 이면 "" */
  key: string;
  name: string;
  /** 열 수 있는 허브 노트(범위 밖이어도 해석되면). 없으면 null */
  hubPath: string | null;
  span: NoteSpan | null;
  /** 허브 프로퍼티에서 온 구간인가(아니면 자식 노트 합) */
  fromHub: boolean;
  status: string;
  /** 날짜 있는 자식 노트(허브 자신은 task 가 있을 때만, 맨 앞) */
  groups: GanttGroup[];
  /** 자식 노트들의 1단계 task 합 */
  progress: Progress | null;
}

export const NO_PROJECT = "";

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
  /** 경로 → (줄 → 체크박스 자손 진행률). tree.ts `checkProgress` */
  progress?: Map<string, Map<number, Progress>>;
  /** 묶음 단위(0.11.0~). 기본 "project" — projectOf 가 없으면 노트 단위와 같다 */
  groupBy?: "project" | "note";
  /** 노트 → 그 노트의 `Project:` 허브. 링크 해석은 바깥(createGantt)이 한다 */
  projectOf?: (p: GanttPage) => ProjectRef | null;
  /** 허브 경로 → 페이지(범위 밖 허브의 프로퍼티를 읽으려고). 없으면 범위 안에서만 찾는다 */
  hubPage?: (path: string) => GanttPage | null;
}

export interface GanttModel {
  groups: GanttGroup[];
  /** 날짜가 하나도 없어 막대를 못 그린 노트 */
  undated: GanttGroup[];
  /** 프로젝트 묶음(groupBy = "project"). 노트 단위면 null */
  projects: GanttProject[] | null;
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
  const byProject = o.groupBy !== "note" && !!o.projectOf;
  // 노트 → 허브. 허브 자신은 다른 노트가 가리키는 경로라 그 경로가 곧 자기 프로젝트다.
  const refOf = new Map<string, ProjectRef | null>();
  const hubName = new Map<string, string>();
  const pageByPath = new Map<string, GanttPage>();
  for (const p of pages) pageByPath.set(p.file.path, p);
  if (byProject) {
    for (const p of pages) {
      const r = o.projectOf!(p);
      const ok = r && r.key !== p.file.path ? r : null;
      refOf.set(p.file.path, ok);
      if (ok) hubName.set(ok.key, ok.name);
    }
  }

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
    const parentOf = o.parents?.get(path) ?? new Map<number, number | null>();
    const tree = buildTaskTree(pts, parentOf, {
      noteEnd: span && pEnd && !span.open ? span.end : null,
      showDone: o.showDone,
      progress: o.progress?.get(path),
    });
    const rows = tree.rows;
    const undatedCount = tree.undated;
    // 1단계 진행률 — 행 필터(완료 숨김·날짜 없음)와 무관하게 최상위 #task 전부
    const lines = new Set(pts.map((t) => t.line));
    let prog: Progress | null = null;
    for (const t of pts) {
      const up = parentOf.get(t.line) ?? null;
      if ((up !== null && lines.has(up)) || t.cancelled) continue;
      if (!prog) prog = { done: 0, total: 0 };
      prog.total++;
      if (t.done) prog.done++;
    }
    const isHub = byProject && hubName.has(path);
    const proj = !byProject ? null : isHub ? path : refOf.get(path)?.key ?? null;
    const g: GanttGroup = {
      path,
      name: nameOf(p),
      span,
      fromProps: !!(pStart || pEnd),
      status: propText(p, "Status"),
      rows,
      undated: undatedCount,
      overrun,
      progress: prog,
      project: proj,
      isHub,
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
  // 어느 노트에도 `Project:` 가 없으면 묶을 것이 없다 — 「(프로젝트 없음)」 머리 줄 하나만 생기는
  // 대신 노트 단위로 그린다(책 목록처럼 허브 없이 노트만 있는 범위)
  if (!byProject || !groups.some((g) => g.project)) return { groups, undated, projects: null };
  return { groups, undated, projects: groupProjects(groups, pageByPath, hubName, o) };
}

/** 노트 그룹 → 프로젝트 묶음. 정렬 = 시작 → 끝 → 이름, 「(프로젝트 없음)」 은 맨 아래 */
function groupProjects(
  groups: GanttGroup[],
  pageByPath: Map<string, GanttPage>,
  hubName: Map<string, string>,
  o: GanttOptions
): GanttProject[] {
  const projects = new Map<string, GanttProject>();
  const projectFor = (key: string): GanttProject => {
    let pr = projects.get(key);
    if (pr) return pr;
    const hub = key ? pageByPath.get(key) ?? o.hubPage?.(key) ?? null : null;
    const s = hub ? noteSpan(propDate(hub, [o.startProp]), propDate(hub, o.endProps), [], o.today) : null;
    pr = {
      key,
      name: !key ? "(프로젝트 없음)" : hub ? nameOf(hub) : hubName.get(key) ?? key.split("/").pop()!.replace(/\.md$/i, ""),
      hubPath: hub ? hub.file.path : null,
      span: s,
      fromHub: !!s,
      status: hub ? propText(hub, "Status") : "",
      groups: [],
      progress: null,
    };
    projects.set(key, pr);
    return pr;
  };
  for (const g of groups) {
    const pr = projectFor(g.project ?? NO_PROJECT);
    // 허브 자신은 task 가 있을 때만 자식으로 둔다 — 없으면 막대가 프로젝트 막대와 겹칠 뿐이다
    if (g.isHub && !g.rows.length && !g.undated) continue;
    if (g.isHub) pr.groups.unshift(g);
    else pr.groups.push(g);
  }
  const out: GanttProject[] = [];
  for (const pr of projects.values()) {
    if (!pr.groups.length) continue;
    for (const g of pr.groups) {
      if (g.progress) {
        pr.progress = pr.progress ?? { done: 0, total: 0 };
        pr.progress.done += g.progress.done;
        pr.progress.total += g.progress.total;
      }
      if (pr.fromHub) continue;
      // 허브 구간이 없으면 자식 노트(초과분 포함)의 합
      const s = g.span!;
      const e = reachEnd(g);
      pr.span = !pr.span
        ? { start: s.start, end: e, open: s.open }
        : {
            start: s.start < pr.span.start ? s.start : pr.span.start,
            end: e > pr.span.end ? e : pr.span.end,
            open: pr.span.open || s.open,
          };
    }
    out.push(pr);
  }
  out.sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    const sa = a.span!, sb = b.span!;
    if (sa.start !== sb.start) return sa.start < sb.start ? -1 : 1;
    if (sa.end !== sb.end) return sa.end < sb.end ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
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

export interface VisibleProject {
  project: GanttProject;
  groups: VisibleGroup[];
}

export interface WindowView {
  groups: VisibleGroup[];
  /** 프로젝트 묶음(모델이 노트 단위면 null). 보이는 자식 노트가 있는 프로젝트만 */
  projects: VisibleProject[] | null;
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
  let projects: VisibleProject[] | null = null;
  if (m.projects) {
    const vis = new Map(groups.map((v) => [v.group.path, v] as const));
    projects = [];
    for (const pr of m.projects) {
      const gs = pr.groups.map((g) => vis.get(g.path)).filter((v): v is VisibleGroup => !!v);
      if (gs.length) projects.push({ project: pr, groups: gs });
    }
  }
  return { groups, projects, total: m.groups.length };
}
