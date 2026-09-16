/*
 * 캘린더 한 개의 상태와 일정 잡기 — createCalendar 에서 그대로 옮겼다(0.7.3).
 *
 * 화면(렌더러)은 여기 값을 읽고 바꾸기만 한다. **무엇을 그릴지 정하는 값**(보는 단위·기준일 ·
 * 필터 · 드래그 중인 항목)과 **다시 그리는 시점**(렌더 큐 · 수집 캐시), 그리고 **스크롤 기억**이
 * 여기 모여 있다.
 */
import { Platform } from "obsidian";
import { isRO } from "../core/order";
import { syncCategories, CategoryView } from "./categories";
import { gatherTasks, TaskItem } from "../data/gather";
import { Settings } from "../settings/defaults";

/** 이 실행이 끝나도 남아야 하는 값(플러그인 인스턴스가 스코프별로 들고 있다). */
export interface CalendarState {
  showDone?: boolean;
  showEvents?: boolean;
  cats?: string[];
  knownCats?: string[];
  /** 마지막 렌더 높이 — 블록이 통째로 다시 그려질 때 칸을 예약해 둔다. */
  h?: number;
  scrollTop?: number;
  scrollTs?: number;
  trayScroll?: number;
  overdueScroll?: number;
  dayScroll?: number;
  /** 모바일 월간에서 고른 날 · 0~24시 전부 보기 */
  mDay?: string;
  mFull?: boolean;
}

export interface ControllerDeps {
  plugin: any;
  container: any;
  /** Dataview API — 수집할 때마다 다시 묻는다(인덱스는 계속 바뀐다). */
  pages: () => Iterable<{ file: { path: string; tasks: any[] } }>;
  /** 이 캘린더의 스코프. 상태 보관함의 키이기도 하다. */
  source: string;
  luxon: any;
}

/** 이 시간 안의 스크롤 기억만 복원한다(그 뒤 사용자가 직접 스크롤했으면 존중). */
const SCROLL_TTL = 5000;

export function createController(deps: ControllerDeps) {
  const { plugin, container } = deps;
  const settings = (): Settings => plugin.settings;
  // 상태·대기표는 플러그인 인스턴스가 소유한다(구 window.__gcalCal).
  const store = plugin.store;
  const S: CalendarState = (store.state[deps.source] = store.state[deps.source] || {});

  // ── 블록이 처음부터 다시 그려질 때의 안전망 ──
  // 인덱스 변경은 refresh() 로 root 안에서만 교체되지만, 노트를 다시 열거나 읽기/편집 뷰를
  // 전환하면 Obsidian 이 코드블록을 통째로 다시 렌더한다. 그 사이 컨테이너에 자식이 없어
  // 높이가 0 이 되고, 노트가 짧아지면서 브라우저가 스크롤을 끌어올린다. root 에 높이를
  // 예약해봐야 소용없다 — root 자체가 그때 새로 생기니까. 그래서 컨테이너 쪽에 예약해 둔다.
  if (S.h) container.style.minHeight = S.h + "px";

  // 노트의 스크롤 컨테이너(읽기 뷰 = .markdown-preview-view, 편집 뷰 = .cm-scroller).
  // 우리가 파일을 쓸 때 위치를 기억해두고, 바로 뒤따르는 재실행의 첫 렌더에서 되돌린다.
  const scroller = (() => {
    for (let el = container; el; el = el.parentElement) {
      const cl = el.classList;
      if (cl && (cl.contains("markdown-preview-view") || cl.contains("cm-scroller"))) return el;
      if (el.scrollHeight > el.clientHeight + 1) {
        const o = getComputedStyle(el).overflowY;
        if (o === "auto" || o === "scroll") return el;
      }
    }
    return null;
  })();

  /** 보고 있는 단위·기준일과 필터. **저장하지 않는다** — 열 때마다 이번 달·오늘로 시작한다. */
  const st = {
    mode: "month",
    view: deps.luxon.now().startOf("month"),
    /** 달력에 완료 항목 표시 여부 */
    showDone: S.showDone !== false,
    /** GCal 일정(회의·약속) 표시 여부 */
    showEvents: S.showEvents !== false,
    /** 드래그 중인 항목 */
    dragging: null as any,
  };

  // 필터도 재실행 후 유지된다(무엇을 보는가는 "어디를 보는가" 와 달리 매번 맞추면 성가시다).
  const activeCats = new Set<string>(Array.isArray(S.cats) ? S.cats : undefined);
  let cats: CategoryView = { CATS: [], CATLABEL: {}, CATCOLOR: {}, CAT_DEFAULT: "" };

  let dataCache: TaskItem[] | null = null;
  let firstRender = true;
  let renderQueued = false;
  let renderNow: () => void = () => {};

  return {
    S,
    st,
    activeCats,
    /** 지금의 카테고리 목록·라벨·색. 매 렌더 시작에 refreshCategories() 로 갱신된다. */
    cats: () => cats,
    /**
     * 설정이 바뀌었을 수 있으니 매 렌더 다시 읽는다 — createCalendar() 는 한 번만 돌고
     * 이후엔 렌더만 다시 도니까, 굳혀 두면 설정을 바꿔도 껐다 켜야 반영된다.
     */
    refreshCategories: () => (cats = syncCategories(settings(), S, activeCats)),
    /** 다시 열 때 이어 갈 것만 저장한다. */
    saveState: () => {
      S.showDone = st.showDone;
      S.showEvents = st.showEvents;
      S.cats = [...activeCats];
    },

    /**
     * 모바일 화면을 쓸 것인가. **매 렌더 평가한다** — 굳혀 두면 설정을 바꿔도 이미 열려 있는
     * 캘린더는 옛 렌더러를 계속 쓴다. 설정으로 강제할 수 있어야 한다: 태블릿은 isPhone 이
     * false 고, 모바일 화면을 고칠 때 폰을 들지 않고 데스크탑에서 바로 확인할 수 있어야 한다.
     */
    isMobileUi: (): boolean => {
      const m = settings().mobileUi;
      if (m === "always") return true;
      if (m === "off") return false;
      try {
        return !!Platform.isPhone;
      } catch (e) {
        return false;
      }
    },

    // ── 수집 ──
    // 이 블록이 살아있는 동안 볼트 데이터는 우리가 쓸 때만 바뀐다(다른 경로로 파일이 바뀌면
    // Dataview 가 이 블록을 통째로 재실행한다) → 필터 토글·달 이동 같은 UI 재렌더에서
    // 볼트 전체 재순회를 반복하지 않게 수집 결과를 캐시한다.
    invalidate: () => (dataCache = null),
    collect: (): TaskItem[] =>
      dataCache ||
      (dataCache = gatherTasks(deps.pages(), {
        catDefault: cats.CAT_DEFAULT,
        pending: store.pending,
        now: Date.now(),
      })),

    // ── 드래그 ──
    // 드롭 타깃이 dragging 을 집어갈 때 쓴다. 일정에서는 dragging 을 세팅하지 않으므로
    // 이중 안전장치지만, 나중에 어포던스 가드를 하나 잊어도 여기서 막힌다.
    takeDrag: (): any => {
      const t = st.dragging;
      st.dragging = null;
      return isRO(t) ? null : t;
    },

    // ── 렌더 큐 ──
    /** 렌더러를 붙인다. 붙이기 전에는 render() 가 아무 일도 안 한다. */
    attach: (fn: () => void) => (renderNow = fn),
    /** 렌더 요청은 한 틱에 하나로 합친다 (드롭 1회에 여러 경로로 불려도 실제로는 1번만 그림). */
    render: () => {
      if (renderQueued) return;
      renderQueued = true;
      setTimeout(() => {
        renderQueued = false;
        renderNow();
      }, 0);
    },
    /** 이 실행의 첫 렌더인가(재실행 직전 스크롤 복원은 이때만). 물으면 소진된다. */
    takeFirstRender: (): boolean => {
      const f = firstRender;
      firstRender = false;
      return f;
    },

    // ── 스크롤 ──
    rememberScroll: () => {
      if (scroller) {
        S.scrollTop = scroller.scrollTop;
        S.scrollTs = Date.now();
      }
    },
    restorePageScroll: () => {
      if (!scroller || S.scrollTop === undefined) return;
      if (Date.now() - (S.scrollTs || 0) > SCROLL_TTL) return;
      if (Math.abs(scroller.scrollTop - S.scrollTop) > 1) scroller.scrollTop = S.scrollTop;
    },
    /** 통째 재실행에 대비해 이번 렌더 높이를 컨테이너에 예약해 둔다. */
    holdHeight: (h: number) => {
      if (h > 0) {
        S.h = h;
        container.style.minHeight = h + "px";
      }
    },
  };
}
