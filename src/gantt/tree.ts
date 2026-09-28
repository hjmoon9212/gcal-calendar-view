/*
 * 노트 안의 task → **들여쓰기 트리** 행. 순수 계산이라 DOM 도 설정도 안 본다(0.9.0~).
 *
 * 탭 들여쓰기로 적은 하위 task 가 곧 상하위 관계다 — 따로 지정할 것이 없다. Dataview 가 목록
 * 항목마다 부모 줄(`parent`)을 알려 주므로 그걸 따라 올라가 **가장 가까운 #task 조상**을 부모로 삼는다
 * (중간에 task 가 아닌 불릿이 끼어 있어도 트리가 끊기지 않게).
 *
 * 행 규칙:
 *   · 자기 📅 가 있으면 자기 막대(🛫 없으면 ◆)
 *   · 자기 날짜가 없어도 자손에 날짜가 있으면 **요약 막대**(자손 최소~최대) — 접어도 기간이 보인다
 *   · 자기도 자손도 날짜가 없으면 행이 안 된다(노트 라벨의 `+N 날짜 없음` 으로 센다)
 *   · 형제끼리 시작일 → 끝 → 줄 순
 *   · 출력은 **전위 순회**(부모 다음에 자손). 화면은 depth 로 접힘을 판정한다
 */
import type { TaskItem } from "../data/gather";
import { spanOf } from "../core/dates";

export interface ListItemRef {
  line: number;
  /** 부모 목록 항목의 줄. 최상위면 undefined/null/음수 */
  parent?: number | null;
}

/**
 * 줄 → 가장 가까운 **task** 조상 줄. 최상위면 null.
 * `lists` 는 노트의 모든 목록 항목(task 아닌 불릿 포함), `taskLines` 는 #task 인 줄.
 */
export function taskParents(lists: Iterable<ListItemRef>, taskLines: Set<number>): Map<number, number | null> {
  const up = new Map<number, number | null>();
  for (const l of lists) {
    const p = typeof l.parent === "number" && l.parent >= 0 ? l.parent : null;
    up.set(l.line, p);
  }
  const out = new Map<number, number | null>();
  for (const line of taskLines) {
    // 깨진 parent(순환)에 갇히지 않게 지나온 줄을 기억한다
    const seen = new Set<number>([line]);
    let p = up.get(line) ?? null;
    while (p !== null && !taskLines.has(p) && !seen.has(p)) {
      seen.add(p);
      p = up.get(p) ?? null;
    }
    out.set(line, p !== null && taskLines.has(p) && !seen.has(p) ? p : null);
  }
  return out;
}

export interface TreeRow {
  task: TaskItem;
  /** 그리는 구간 — 자기 날짜, 없으면 자손 요약 */
  span: [string, string];
  /** 자기 날짜가 없어 자손으로 요약한 막대인가 */
  summary: boolean;
  /** 📅 만 있는 task — ◆ */
  milestone: boolean;
  /** 자기 + 자손 전체 구간. 창 판정에 쓴다(자손이 창에 걸리면 부모도 보이게) */
  reach: [string, string];
  depth: number;
  /** 접힘 상태 키 — 🆔 가 있으면 그것, 없으면 경로 + 제목(줄 번호는 편집하면 밀린다) */
  key: string;
  /** 이 행 아래에 딸린 행 수(보이는 것만, 전 단계) */
  descendants: number;
  /** 자기 📅 보다 늦게 끝나는 미완료 자손 — 붉은 점선 연장 */
  overrun: { until: string; count: number } | null;
  /** 노트 종료일 또는 날짜 있는 가장 가까운 조상의 📅 보다 늦은 미완료 task — 붉은 테두리 */
  late: boolean;
}

export interface TreeOptions {
  /** 노트 **프로퍼티** 종료일(없으면 null — task 로 메운 끝은 초과 판정에 안 쓴다) */
  noteEnd: string | null;
  showDone: boolean;
}

const ID_RE = /🆔\s*([A-Za-z0-9_-]+)/u;
export const taskKey = (t: TaskItem): string => {
  const m = t.text.match(ID_RE);
  return m ? "id:" + m[1] : t.path + "#" + t.title;
};

const union = (a: [string, string] | null, b: [string, string] | null): [string, string] | null =>
  !a ? b : !b ? a : [a[0] < b[0] ? a[0] : b[0], a[1] > b[1] ? a[1] : b[1]];

const isOpen = (t: TaskItem) => !t.done && !t.cancelled;

export function buildTaskTree(
  tasks: TaskItem[],
  parentOf: Map<number, number | null>,
  o: TreeOptions
): { rows: TreeRow[]; undated: number } {
  const byLine = new Map<number, TaskItem>();
  for (const t of tasks) byLine.set(t.line, t);
  const kids = new Map<number | null, TaskItem[]>();
  for (const t of tasks) {
    const p = parentOf.get(t.line) ?? null;
    const k = p !== null && byLine.has(p) ? p : null;
    const l = kids.get(k);
    if (l) l.push(t);
    else kids.set(k, [t]);
  }

  interface Node {
    t: TaskItem;
    own: [string, string] | null;
    reach: [string, string] | null;
    kept: Node[];
    keep: boolean;
    /** 미완료 자손의 가장 늦은 📅 와 그 수 */
    openDue: { max: string; list: string[] };
  }
  let undated = 0;

  const make = (t: TaskItem, seen: Set<number>): Node => {
    seen.add(t.line);
    const own = t.due ? spanOf(t) : null;
    const children = (kids.get(t.line) ?? []).filter((c) => !seen.has(c.line)).map((c) => make(c, seen));
    let reach = own;
    const list: string[] = [];
    let max = "";
    for (const c of children) {
      reach = union(reach, c.reach);
      for (const d of c.openDue.list) list.push(d);
      if (c.openDue.max > max) max = c.openDue.max;
      if (c.own && isOpen(c.t)) {
        list.push(c.own[1]);
        if (c.own[1] > max) max = c.own[1];
      }
    }
    const kept = children.filter((c) => c.keep);
    const keep = !!reach && (o.showDone || isOpen(t) || kept.length > 0);
    if (!reach) undated++;
    return { t, own, reach, kept, keep, openDue: { max, list } };
  };

  const byNode = (a: Node, b: Node) => {
    const sa = a.own ?? a.reach!, sb = b.own ?? b.reach!;
    return sa[0] !== sb[0] ? (sa[0] < sb[0] ? -1 : 1) : sa[1] !== sb[1] ? (sa[1] < sb[1] ? -1 : 1) : a.t.line - b.t.line;
  };

  const rows: TreeRow[] = [];
  const emit = (n: Node, depth: number, bound: string | null): number => {
    const t = n.t;
    const span = (n.own ?? n.reach)!;
    let overrun: TreeRow["overrun"] = null;
    if (n.own) {
      const later = n.openDue.list.filter((d) => d > n.own![1]);
      if (later.length) overrun = { until: later.reduce((a, b) => (b > a ? b : a)), count: later.length };
    }
    const late = isOpen(t) && !!n.own && !!bound && n.own[1] > bound;
    const row: TreeRow = {
      task: t,
      span,
      summary: !n.own,
      milestone: !!n.own && !t.start,
      reach: n.reach!,
      depth,
      key: taskKey(t),
      descendants: 0,
      overrun,
      late,
    };
    rows.push(row);
    // 자손의 기준 = 날짜 있는 가장 가까운 조상의 📅 (없으면 노트 종료일)
    const nextBound = n.own ? n.own[1] : bound;
    let count = 0;
    for (const c of n.kept.sort(byNode)) count += 1 + emit(c, depth + 1, nextBound);
    row.descendants = count;
    return count;
  };

  const seen = new Set<number>();
  const roots = (kids.get(null) ?? []).map((t) => make(t, seen));
  // 순환(깨진 parent)으로 뿌리에 못 닿은 줄도 버리지 않는다 — 최상위로 올린다
  for (const t of tasks) if (!seen.has(t.line)) roots.push(make(t, seen));
  for (const r of roots.filter((n) => n.keep).sort(byNode)) emit(r, 0, o.noteEnd);
  return { rows, undated };
}
