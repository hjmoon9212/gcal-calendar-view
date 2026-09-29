/*
 * Gantt 화면 — 툴바 · (고정 라벨 열 + 타임라인) · 날짜 없음 줄.
 *
 * 행마다 [라벨 칸(sticky) | 트랙 칸] 을 한 줄로 둔다. 라벨 열과 타임라인을 따로 그리면
 * 두 열의 행 높이를 맞추는 코드가 필요한데, 한 줄에 두면 저절로 맞는다.
 *
 * **보기 기간(창)**(0.8.1~): 줌이 곧 창의 크기이고 ◀ ▶ 로 옮긴다. 창과 겹치는 노트·task 만 그린다
 * (rows.ts `filterToWindow`). 창 밖으로 걸친 막대는 가장자리에서 잘리고 ◀/▶ 가 붙는다.
 *
 * ⛔ 여기서 노트를 고치지 않는다. task 조작은 넘겨받은 `taskClick`/`taskMenu` 로만 흘려보낸다 —
 *    무엇을 할지(열기·편집 모달·액션시트)는 createGantt 가 **캘린더와 같은 규칙**으로 정한다(0.9.1~).
 *
 * 스타일은 캘린더처럼 전부 인라인 cssText 다(styles.css 로 옮기면 테마와 특이성이 달라진다).
 * 강조는 최소로 — 글자색·막대 모양만, 배지·행 배경은 쓰지 않는다.
 */
import { skinCss, dimCss, statusMark, titleOf, OVERDUE_RED } from "../ui/style";
import { timeText } from "../core/time";
import { addDays } from "../core/dates";
import type { GanttGroup, GanttModel, GanttRow, VisibleGroup } from "./rows";
import { filterToWindow } from "./rows";
import { dayTicks, makeScale, monthTicks, Scale, stepAnchor, viewWindow, windowLabel, Zoom, ZOOMS, ZOOM_LABEL } from "./scale";
import { statusInfo } from "./status";
import { daysFor, DragMode, DRAG_THRESHOLD, previewSpan, spanText } from "./drag";

type El = any;

// 0.9.0: 0.8.x 는 행 22px · 막대 16px · 글자 10px 라 정렬이 눈에 안 들어왔다 → 키운다
export const LABEL_W = 280;
export const STATUS_W = 40;
export const GROUP_H = 32;
export const ROW_H = 30;
export const INDENT = 16;
const HOLD_GRAY = "var(--text-faint)";
const ACCENT = "var(--interactive-accent)";

export interface GanttViewState {
  zoom: Zoom;
  /** 창의 기준일. 열 때마다 오늘 */
  anchor: string;
  showDone: boolean;
  showDoneNotes: boolean;
  collapsed: string[];
  /** 펼친 task 키. **기본은 접힘** — 최상위 task 만 보인다(1단계) */
  expanded: string[];
  scrollLeft?: number;
  /** 타임라인에 쓸 수 있는 폭(px, 저장 안 함) — 창을 화면 폭에 맞춘다 */
  avail?: number;
}

export interface GanttViewDeps {
  root: El;
  state: GanttViewState;
  today: string;
  catColor: (cat: string) => string;
  /** 다시 그려 달라(상태를 바꾼 뒤) */
  render: () => void;
  /** 모델을 다시 만들어야 할 때(완료 task 토글) */
  rebuild: () => void;
  /** task 클릭 — 데스크탑 = 원본 줄 열기(Ctrl=새 탭 · Ctrl+Shift=분할), 폰 = 액션시트 */
  taskClick: (t: any, evt?: any) => void;
  /** task 우클릭 — Tasks 편집 모달(데스크탑). 폰에는 우클릭이 없다 */
  taskMenu: (t: any, evt?: any) => void;
  openNote: (path: string, evt?: any) => void;
  /** 툴팁 끝의 조작 안내(데스크탑/폰이 다르다) */
  hint: string;
  /** 막대를 끌어 고칠 수 있는가(데스크탑만 — 폰은 탭이 액션시트다) */
  canDrag: boolean;
  /** 노트 막대를 놓았다 → 프로퍼티 */
  dragNote: (g: GanttGroup, mode: DragMode, days: number) => void;
  /** task 막대를 놓았다 → 🛫/📅 */
  dragTask: (r: GanttRow, mode: DragMode, days: number) => void;
  noteHeader?: () => El | null;
}

const btnCss = (on: boolean) =>
  `font-size:11px;padding:2px 9px;border-radius:10px;cursor:pointer;${on ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;"}`;

export function renderGantt(model: GanttModel, d: GanttViewDeps): void {
  const { root, state, today } = d;
  const box = document.createElement("div") as El;

  const header = d.noteHeader?.();
  if (header) box.appendChild(header);

  const win = viewWindow(state.zoom, state.anchor);
  const view = filterToWindow(model, win[0], win[1], state.showDoneNotes);

  // ── 툴바 ──
  const bar = box.createEl("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;";
  const moveTo = (anchor: string) => {
    state.anchor = anchor;
    state.scrollLeft = undefined;
    d.render();
  };
  bar.createEl("button", { text: "◀" }).onclick = () => moveTo(stepAnchor(state.zoom, state.anchor, -1));
  const label = bar.createEl("b", { text: windowLabel(state.zoom, win) });
  label.style.cssText = "min-width:120px;text-align:center;font-size:12px;";
  bar.createEl("button", { text: "▶" }).onclick = () => moveTo(stepAnchor(state.zoom, state.anchor, 1));
  bar.createEl("button", { text: "오늘" }).onclick = () => moveTo(today);
  for (const z of ZOOMS) {
    const b = bar.createEl("button", { text: ZOOM_LABEL[z] });
    b.style.cssText = btnCss(z === state.zoom);
    b.onclick = () => {
      if (z === state.zoom) return;
      state.zoom = z;
      state.scrollLeft = undefined; // 줌이 바뀌면 옛 px 위치는 의미가 없다
      d.render();
    };
  }
  const doneBtn = bar.createEl("button", { text: state.showDone ? "완료 task ✓" : "완료 task ✗" });
  doneBtn.title = "완료·취소 task 행 표시/숨김 (노트 막대의 구간 계산에는 항상 포함)";
  doneBtn.onclick = () => {
    state.showDone = !state.showDone;
    d.rebuild();
  };
  const doneNoteBtn = bar.createEl("button", { text: state.showDoneNotes ? "완료 노트 ✓" : "완료 노트 ✗" });
  doneNoteBtn.title = "Status 가 Done 인 노트 표시/숨김";
  doneNoteBtn.onclick = () => {
    state.showDoneNotes = !state.showDoneNotes;
    d.render();
  };
  const count = bar.createEl("span", { text: `노트 ${view.groups.length}/${view.total}개` });
  count.style.cssText = "font-size:11px;opacity:.6;";
  count.title = "이 기간에 보이는 노트 / 날짜가 있는 전체 노트";

  if (!model.groups.length) {
    const empty = box.createEl("div", { text: "그릴 노트가 없습니다 — 범위 안에 StartDate/EndDate 프로퍼티나 📅 가 있는 #task 가 없습니다." });
    empty.style.cssText = "padding:8px;font-size:12px;opacity:.6;";
  } else if (!view.groups.length) {
    const empty = box.createEl("div", { text: "이 기간에 걸친 노트가 없습니다 — ◀ ▶ 로 옮겨 보세요." });
    empty.style.cssText = "padding:8px;font-size:12px;opacity:.6;";
  } else {
    const sc = makeScale(win[0], win[1], state.zoom, state.avail ?? 0);
    const scroller = box.createEl("div");
    scroller.style.cssText =
      "overflow-x:auto;overflow-y:hidden;border:1px solid var(--background-modifier-border);border-radius:4px;";
    const inner = scroller.createEl("div");
    inner.style.cssText = `width:${LABEL_W + sc.width}px;position:relative;`;

    headerRow(inner, sc, today, state.zoom === "week");
    const expanded = new Set(state.expanded);
    for (const v of view.groups) {
      const collapsed = d.state.collapsed.includes(v.group.path);
      groupRow(inner, v, sc, today, collapsed, d);
      if (collapsed) continue;
      // 노션식 접기 — 전위 순회 목록에서, 접힌 행보다 깊은 행은 건너뛴다
      let hideBelow = Infinity;
      v.rows.forEach((r, i) => {
        if (r.depth > hideBelow) return;
        hideBelow = Infinity;
        const next = v.rows[i + 1];
        const hasKids = !!next && next.depth > r.depth;
        const open = hasKids && expanded.has(r.key);
        let kids = 0;
        if (hasKids) for (let j = i + 1; j < v.rows.length && v.rows[j].depth > r.depth; j++) kids++;
        taskRow(inner, r, sc, today, d, hasKids ? { open, kids } : null);
        if (hasKids && !open) hideBelow = r.depth;
      });
    }

    // 창이 컨테이너보다 넓을 때만 스크롤이 생긴다. 처음엔 오늘이 보이게, 다시 그린 것이면 보던 자리 그대로.
    scroller.addEventListener("scroll", () => {
      state.scrollLeft = scroller.scrollLeft;
    });
    const place = () => {
      const w = scroller.clientWidth || 0;
      const inWin = today >= sc.from && today <= sc.to;
      scroller.scrollLeft =
        state.scrollLeft !== undefined ? state.scrollLeft
        : inWin ? Math.max(0, sc.x(today) - Math.max(0, w - LABEL_W) / 3) : 0;
    };
    requestAnimationFrame(place);
  }

  if (model.undated.length) {
    const u = box.createEl("div");
    u.style.cssText = "margin-top:6px;font-size:12px;opacity:.75;line-height:1.8;";
    u.createEl("span", { text: "📭 날짜 없음: " });
    model.undated.forEach((g, i) => {
      if (i) u.createEl("span", { text: " · " });
      const a = u.createEl("a", { text: g.name });
      a.style.cssText = "cursor:pointer;";
      a.title = g.path;
      a.onclick = (e: any) => d.openNote(g.path, e);
    });
  }

  root.replaceChildren(...box.childNodes);
}

// ── 행 조각 ─────────────────────────────────────────────────────────────────

/** [상태 | 라벨 | 트랙] 한 줄. 상태·라벨은 가로 스크롤해도 왼쪽에 붙어 있다(sticky). */
function line(inner: El, h: number, extra = ""): { status: El; label: El; track: El } {
  const row = inner.createEl("div");
  row.style.cssText = `display:flex;height:${h}px;border-bottom:1px solid var(--background-modifier-border-hover);${extra}`;
  const left = row.createEl("div");
  left.style.cssText =
    `position:sticky;left:0;z-index:2;flex:0 0 ${LABEL_W}px;width:${LABEL_W}px;box-sizing:border-box;` +
    "display:flex;align-items:center;overflow:hidden;white-space:nowrap;font-size:13px;" +
    "background:var(--background-primary);border-right:1px solid var(--background-modifier-border);";
  const status = left.createEl("div");
  status.style.cssText = `flex:0 0 ${STATUS_W}px;width:${STATUS_W}px;text-align:center;font-size:12px;`;
  const label = left.createEl("div");
  label.style.cssText = "flex:1 1 auto;min-width:0;padding-right:6px;display:flex;align-items:center;gap:4px;overflow:hidden;";
  const track = row.createEl("div");
  track.style.cssText = "position:relative;flex:1 0 auto;height:100%;";
  return { status, label, track };
}

function todayLine(track: El, sc: Scale, today: string): void {
  if (today < sc.from || today > sc.to) return;
  const t = track.createEl("div");
  t.style.cssText =
    `position:absolute;top:0;bottom:0;left:${sc.x(today) + Math.floor(sc.dayPx / 2)}px;width:0;` +
    "border-left:2px solid var(--interactive-accent);opacity:.5;pointer-events:none;";
}

function headerRow(inner: El, sc: Scale, today: string, weekZoom: boolean): void {
  const { status, label, track } = line(inner, weekZoom ? 36 : 20, "position:sticky;top:0;z-index:3;background:var(--background-secondary);");
  status.parentElement.style.background = "var(--background-secondary)";
  status.setText("상태");
  status.style.opacity = ".5";
  label.createEl("span", { text: "노트 · task" }).style.cssText = "font-size:11px;opacity:.5;";
  for (const m of monthTicks(sc)) {
    const c = track.createEl("div", { text: m.label });
    c.style.cssText =
      `position:absolute;top:0;height:18px;left:${m.x}px;width:${m.width}px;box-sizing:border-box;` +
      "padding-left:4px;font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;" +
      "border-left:1px solid var(--background-modifier-border);";
  }
  if (weekZoom) {
    for (const t of dayTicks(sc)) {
      const c = track.createEl("div", { text: t.label });
      const wk = t.weekday === 0 || t.weekday === 6;
      c.style.cssText =
        `position:absolute;top:18px;height:18px;left:${t.x}px;width:${t.width}px;text-align:center;font-size:11px;` +
        (t.iso === today ? "font-weight:700;color:var(--interactive-accent);" : wk ? "opacity:.45;" : "opacity:.7;");
    }
  }
}

/** 잘린 쪽 표시 — 막대가 창 밖으로 이어진다 */
function clipMark(track: El, side: "L" | "R", left: number, top: number): void {
  const m = track.createEl("div", { text: side === "L" ? "◀" : "▶" });
  m.style.cssText = `position:absolute;top:${top}px;left:${left}px;width:10px;font-size:8px;line-height:10px;opacity:.6;pointer-events:none;`;
}

/**
 * 막대 드래그(0.10.0~) — 가운데 = 기간째 이동, 양 끝 핸들 = 시작/끝만. 하루 단위로 스냅하고,
 * 끄는 동안 막대를 그 자리에 미리 그리며 `시작 ~ 끝` 라벨을 띄운다. 놓으면 `onDrop` 한 번.
 *
 * pointer 이벤트 + setPointerCapture — 캘린더 일간 리사이즈와 같은 이유다(HTML5 DnD 는 스냅
 * 미리보기를 못 그리고, 포인터가 막대 밖으로 나가면 move 를 놓친다).
 * DRAG_THRESHOLD 미만이면 드래그가 아니다 → 뒤따르는 click 이 평소대로 열기를 한다.
 * 끌고 놓은 뒤의 click 은 `dragged()` 로 삼킨다(pointerup 직후 click 이 한 번 온다).
 * 터치는 받지 않는다 — 태블릿의 가로 스크롤과 싸운다.
 */
function attachDrag(
  el: El,
  track: El,
  span: [string, string],
  edges: { start: boolean; end: boolean },
  place: (pv: [string, string]) => void,
  onDrop: (mode: DragMode, days: number) => void,
  dayPx: number,
  labelAt: (pv: [string, string]) => number,
  /** 몸통을 잡았을 때의 동작 — 막대는 기간째 이동, 초과 점선은 끝만(0.10.2~) */
  bodyMode: DragMode = "move"
): { dragged: () => boolean } {
  let justDragged = false;
  const begin = (e: any, mode: DragMode) => {
    if ((e.button ?? 0) !== 0 || e.pointerType === "touch") return;
    e.preventDefault?.();
    e.stopPropagation?.();
    const x0 = e.clientX;
    let moved = false;
    let days = 0;
    let tag: El = null;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    const move = (ev: any) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      moved = true;
      days = daysFor(dx, dayPx);
      const pv = previewSpan(span, mode, days);
      place(pv);
      if (!tag) {
        tag = track.createEl("div");
        tag.style.cssText =
          "position:absolute;top:-2px;z-index:5;padding:0 5px;border-radius:3px;font-size:11px;line-height:16px;white-space:nowrap;" +
          "background:var(--background-primary);border:1px solid var(--interactive-accent);pointer-events:none;";
      }
      tag.setText(spanText(pv));
      tag.style.left = labelAt(pv) + "px";
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch (_) {}
      tag?.remove();
      if (!moved) return;
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      if (days) onDrop(mode, days);
      else place(span);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e: any) => begin(e, bodyMode));
  for (const side of ["start", "end"] as const) {
    if (!edges[side]) continue;
    const h = el.createEl("div");
    h.title = side === "start" ? "끌어서 시작일만" : "끌어서 끝만";
    h.style.cssText =
      `position:absolute;top:0;bottom:0;${side === "start" ? "left" : "right"}:0;width:6px;cursor:ew-resize;touch-action:none;`;
    h.addEventListener("pointerdown", (e: any) => begin(e, side));
  }
  return { dragged: () => justDragged };
}

function groupRow(inner: El, v: VisibleGroup, sc: Scale, today: string, collapsed: boolean, d: GanttViewDeps): void {
  const g = v.group;
  const si = statusInfo(g.status);
  const { status, label, track } = line(inner, GROUP_H);
  status.setText(si.label);
  status.style.color = si.color;
  if (si.label) status.title = `Status: ${g.status}`;

  const tog = label.createEl("span", { text: v.rows.length ? (collapsed ? "▸" : "▾") : "·" });
  tog.style.cssText = "cursor:pointer;width:12px;text-align:center;opacity:.7;";
  if (v.rows.length) {
    tog.title = collapsed ? "펼치기" : "접기";
    tog.onclick = () => {
      const i = d.state.collapsed.indexOf(g.path);
      if (i >= 0) d.state.collapsed.splice(i, 1);
      else d.state.collapsed.push(g.path);
      d.render();
    };
  }
  const name = label.createEl("span", { text: "📄 " + g.name });
  name.style.cssText =
    "cursor:pointer;font-weight:600;overflow:hidden;text-overflow:ellipsis;" +
    (g.overrun ? `color:${OVERDUE_RED};` : "") + (si.bar === "done" ? "opacity:.55;" : "");
  name.title = groupTooltip(g, false);
  name.onclick = (e: any) => d.openNote(g.path, e);
  if (collapsed && v.rows.length) label.createEl("span", { text: `(${v.rows.length})` }).style.cssText = "opacity:.5;";
  const hidden = [
    v.outside ? `+${v.outside} 기간 밖` : "",
    g.undated ? `+${g.undated} 날짜 없음` : "",
  ].filter(Boolean).join(" · ");
  if (hidden) label.createEl("span", { text: hidden }).style.cssText = "font-size:10px;opacity:.45;";

  todayLine(track, sc, today);
  const s = g.span!;
  const b = sc.bar(s.start, s.end);
  if (b) {
    const color = si.bar === "hold" ? HOLD_GRAY : ACCENT;
    const look =
      si.bar === "planned" ? `border:1px dashed ${color};box-sizing:border-box;`
      : `background:${color};opacity:${si.bar === "done" ? ".2" : ".45"};`;
    const el = track.createEl("div");
    el.style.cssText =
      `position:absolute;top:10px;height:12px;left:${b.left}px;width:${Math.max(b.width, 3)}px;` +
      look + "border-radius:3px;cursor:pointer;";
    el.title = groupTooltip(g, d.canDrag);
    let drag: { dragged: () => boolean } | null = null;
    el.onclick = (e: any) => {
      if (drag?.dragged()) return;
      d.openNote(g.path, e);
    };
    if (d.canDrag) {
      drag = attachDrag(
        el, track, [s.start, s.end],
        { start: !b.clipL, end: !b.clipR },
        ([a, z]) => {
          el.style.left = sc.x(a) + "px";
          el.style.width = Math.max(3, sc.x(z) - sc.x(a) + sc.dayPx) + "px";
        },
        (mode, days) => d.dragNote(g, mode, days),
        sc.dayPx,
        ([a]) => sc.x(a)
      );
    }
    if (b.clipL) clipMark(track, "L", b.left, 11);
    if (b.clipR) clipMark(track, "R", b.left + b.width - 10, 11);
    if (s.open && !b.clipR) {
      // 끝이 안 정해진 기간 — 오늘 뒤로 옅게 흘려서 "진행 중" 을 보인다(창 안에서만)
      const w = Math.min(sc.dayPx * 7, sc.width - (b.left + b.width));
      if (w > 0) {
        const f = track.createEl("div");
        f.style.cssText =
          `position:absolute;top:10px;height:12px;left:${b.left + b.width}px;width:${w}px;` +
          `background:linear-gradient(to right, ${color}, transparent);opacity:.3;border-radius:0 3px 3px 0;pointer-events:none;`;
      }
    }
  }
  if (g.overrun) {
    // 종료일 뒤 ~ 가장 늦은 📅 — 채우지 않은 붉은 점선(초과분)
    const o = sc.bar(addDays(s.end, 1), g.overrun.until);
    if (o) {
      const x = track.createEl("div");
      x.style.cssText =
        `position:absolute;top:10px;height:12px;left:${o.left}px;width:${Math.max(o.width, 3)}px;box-sizing:border-box;` +
        `border:1px dashed ${OVERDUE_RED};border-radius:0 3px 3px 0;cursor:pointer;`;
      x.title = overrunText(g) + (d.canDrag ? "\n드래그=종료일 조정" : "");
      let xdrag: { dragged: () => boolean } | null = null;
      x.onclick = (e: any) => {
        if (xdrag?.dragged()) return;
        d.openNote(g.path, e);
      };
      if (d.canDrag) xdrag = dragOverrun(x, track, sc, [s.start, s.end], g.overrun.until, (days) => d.dragNote(g, "end", days));
    }
  }
}

/**
 * 붉은 점선(초과분)을 끌면 **끝을 옮긴다**(0.10.2~). 주 줌에서는 막대 본체가 창 밖이라 잡을 곳이
 * 점선뿐인 경우가 많다 — 표시 전용이던 0.10.1 까지는 거기서 아무 일도 안 일어났다.
 * 미리보기: 점선의 왼쪽 끝이 새 종료일 다음 날로 따라온다(다 덮으면 한 칸만 남는다).
 */
function dragOverrun(
  x: El,
  track: El,
  sc: Scale,
  span: [string, string],
  until: string,
  onDrop: (days: number) => void
): { dragged: () => boolean } {
  x.style.pointerEvents = "auto";
  return attachDrag(
    x, track, span, { start: false, end: false },
    ([, z]) => {
      const from = addDays(z, 1);
      const left = sc.x(from < sc.from ? sc.from : from);
      x.style.left = left + "px";
      x.style.width = Math.max(3, sc.x(until) + sc.dayPx - left) + "px";
    },
    (_mode, days) => onDrop(days),
    sc.dayPx,
    ([, z]) => sc.x(z),
    "end"
  );
}

function taskRow(inner: El, r: GanttRow, sc: Scale, today: string, d: GanttViewDeps, tree: { open: boolean; kids: number } | null): void {
  const t = r.task;
  const dim = t.done || t.cancelled;
  const { label, track } = line(inner, ROW_H);
  let drag: { dragged: () => boolean } | null = null;
  const click = (e: any) => {
    if (drag?.dragged()) return;
    d.taskClick(t, e);
  };
  const menu = (e: any) => {
    e?.preventDefault?.();
    d.taskMenu(t, e);
  };
  const tip = taskTooltip(r, d.hint);

  // 들여쓰기 + ▸/▾ (자식이 있을 때만). 토글 자리는 항상 비워 둬 제목이 깊이별로 줄 맞게 한다.
  const tog = label.createEl("span", { text: tree ? (tree.open ? "▾" : "▸") : "" });
  tog.style.cssText =
    `flex:0 0 14px;width:14px;margin-left:${16 + r.depth * INDENT}px;text-align:center;opacity:.7;` +
    (tree ? "cursor:pointer;" : "");
  if (tree) {
    tog.title = tree.open ? "하위 task 접기" : `하위 task ${tree.kids}개 펼치기`;
    tog.onclick = () => {
      const i = d.state.expanded.indexOf(r.key);
      if (i >= 0) d.state.expanded.splice(i, 1);
      else d.state.expanded.push(r.key);
      d.render();
    };
  }
  const lab = label.createEl("span", { text: statusMark(t, false) + (t.recurring ? "🔁 " : "") + titleOf(t) });
  lab.style.cssText =
    `cursor:pointer;overflow:hidden;text-overflow:ellipsis;${r.late ? `color:${OVERDUE_RED};` : ""}${dimCss(dim)}`;
  lab.title = tip;
  lab.onclick = click;
  lab.addEventListener("contextmenu", menu);
  if (tree && !tree.open) label.createEl("span", { text: `(${tree.kids})` }).style.cssText = "font-size:11px;opacity:.5;";

  todayLine(track, sc, today);
  const color = d.catColor(t.cat);
  let endX = -1; // 막대 오른쪽 끝 — 제목을 바깥에 쓸 자리
  if (r.milestone) {
    if (r.span[1] >= sc.from && r.span[1] <= sc.to) {
      const cx = sc.x(r.span[1]) + sc.dayPx / 2;
      const m = track.createEl("div", { text: "◆" });
      m.style.cssText =
        `position:absolute;top:6px;left:${cx - 8}px;width:16px;text-align:center;` +
        `font-size:15px;line-height:18px;color:${r.late ? OVERDUE_RED : color};cursor:pointer;${dim ? "opacity:.45;" : ""}`;
      m.title = tip;
      m.onclick = click;
      m.addEventListener("contextmenu", menu);
      if (d.canDrag && !dim) {
        // ◆ 는 옮기기만 — 시작이 없으니 양 끝이 없다
        drag = attachDrag(
          m, track, r.span, { start: false, end: false },
          ([, z]) => (m.style.left = sc.x(z) + sc.dayPx / 2 - 8 + "px"),
          (mode, days) => d.dragTask(r, mode, days),
          sc.dayPx,
          ([, z]) => sc.x(z)
        );
      }
      endX = cx + 8;
    }
  } else {
    const b = sc.bar(r.span[0], r.span[1]);
    if (b) {
      const inside = !r.summary && b.width >= 60;
      const text = inside ? (b.clipL ? "◀ " : "") + titleOf(t) + (b.clipR ? " ▶" : "") : "";
      const el = track.createEl("div", { text });
      el.style.cssText = r.summary
        ? // 요약 막대(자기 날짜 없음 — 하위 task 구간) = 괄호 모양
          `position:absolute;top:9px;height:10px;left:${b.left}px;width:${Math.max(b.width, 3)}px;box-sizing:border-box;` +
          `border:2px solid ${color};border-top:none;border-radius:0 0 3px 3px;cursor:pointer;${dim ? "opacity:.45;" : ""}`
        : `position:absolute;top:5px;height:20px;left:${b.left}px;width:${Math.max(b.width, 3)}px;box-sizing:border-box;` +
          `border-radius:4px;font-size:12px;line-height:18px;padding:0 5px;overflow:hidden;white-space:nowrap;cursor:pointer;` +
          skinCss(color, false, r.late) + dimCss(dim, "0.55");
      el.title = tip;
      el.onclick = click;
      el.addEventListener("contextmenu", menu);
      if (d.canDrag && !r.summary && !dim) {
        drag = attachDrag(
          el, track, r.span, { start: !b.clipL, end: !b.clipR },
          ([a, z]) => {
            el.style.left = sc.x(a) + "px";
            el.style.width = Math.max(3, sc.x(z) - sc.x(a) + sc.dayPx) + "px";
          },
          (mode, days) => d.dragTask(r, mode, days),
          sc.dayPx,
          ([a]) => sc.x(a)
        );
      }
      if (!inside) endX = b.left + b.width;
    }
  }
  if (r.overrun) {
    // 자기 📅 보다 늦게 끝나는 미완료 하위 task — 노트 종료일 초과와 같은 붉은 점선
    const o = sc.bar(addDays(r.span[1], 1), r.overrun.until);
    if (o) {
      const x = track.createEl("div");
      x.style.cssText =
        `position:absolute;top:5px;height:20px;left:${o.left}px;width:${Math.max(o.width, 3)}px;box-sizing:border-box;` +
        `border:1px dashed ${OVERDUE_RED};border-radius:0 4px 4px 0;pointer-events:none;`;
      if (d.canDrag && !dim) {
        x.title = `⚠ 하위 task ${r.overrun.count}개가 이 task 📅 보다 늦음 — 최대 ${r.overrun.until}\n드래그=📅 조정`;
        x.style.cursor = "grab";
        drag = dragOverrun(x, track, sc, r.span, r.overrun.until, (days) => d.dragTask(r, "end", days));
        x.onclick = click;
        x.addEventListener("contextmenu", menu);
      }
      if (endX >= 0) endX = Math.max(endX, o.left + o.width);
    }
  }
  if (endX >= 0 && endX < sc.width - 40) {
    // 막대가 짧아 제목이 안 들어가면 **오른쪽 바깥**에 쓴다
    const out = track.createEl("div", { text: titleOf(t) });
    out.style.cssText =
      `position:absolute;top:5px;left:${endX + 4}px;max-width:${Math.max(0, sc.width - endX - 8)}px;font-size:12px;line-height:20px;` +
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;opacity:.8;${r.late ? `color:${OVERDUE_RED};` : ""}${dimCss(dim)}`;
    out.title = tip;
    out.onclick = click;
    out.addEventListener("contextmenu", menu);
  }
}

function overrunText(g: GanttGroup): string {
  return `⚠ 종료일(${g.span!.end})보다 늦은 task ${g.overrun!.count}개 — 최대 ${g.overrun!.until}`;
}

function groupTooltip(g: GanttGroup, canDrag: boolean): string {
  const s = g.span;
  const range = s ? `${s.start} ~ ${s.open ? "(종료일 없음)" : s.end}` : "날짜 없음";
  return (
    `${g.name}\n${range}` +
    (s && !g.fromProps ? "\n(프로퍼티 없음 — task 날짜로 계산)" : "") +
    (g.status ? `\nStatus: ${g.status}` : "") +
    (g.overrun ? "\n" + overrunText(g) : "") +
    "\n클릭=노트 열기 · Ctrl+클릭=새 탭" +
    (canDrag ? "\n드래그=기간 이동 · 양 끝=시작/종료일 (프로퍼티)" : "")
  );
}

function taskTooltip(r: GanttRow, hint: string): string {
  const t = r.task;
  return (
    `${titleOf(t)}\n` +
    (r.summary ? `(날짜 없음 — 하위 task ${r.span[0]} ~ ${r.span[1]})` : `🛫 ${t.start || "-"}  📅 ${t.due}`) +
    (t.tStart !== null ? `  ⏰ ${timeText(t.tStart, t.tEnd!)}` : "") +
    (t.recurring ? "\n🔁 반복" : "") +
    (t.done ? "\n(완료됨)" : t.cancelled ? "\n(취소됨)" : "") +
    (r.late ? "\n⚠ 상위(노트 종료일 또는 상위 task 📅)보다 늦음" : "") +
    (r.overrun ? `\n⚠ 하위 task ${r.overrun.count}개가 이 task 📅 보다 늦음 — 최대 ${r.overrun.until}` : "") +
    "\n" + hint
  );
}
