/*
 * 화면이 다루는 값의 모양(0.7.5).
 *
 * 달력은 **task 와 GCal 일정을 구분하지 않고** 그린다 — 일정도 start/due/tStart/tEnd 를 그대로
 * 들고 오므로 레인 배치도 종일/시간 분리도 한 벌이면 된다. 다른 것은 딱 하나, 일정은
 * `path`·`line` 이 null 이라 **고칠 수 없다**(isRO). 그래서 둘을 합집합으로 둔다.
 */
import { TaskItem } from "../data/gather";
import { EventItem } from "../feed/events";

export type CalItem = TaskItem | EventItem;

/** 가짜 DOM 으로도 그릴 수 있어야 한다(테스트) — Obsidian 의 HTMLElement 확장에 기대지 않는다. */
export type El = any;

/**
 * 화면이 바깥에 닿는 통로. 상태는 컨트롤러가, 쓰기는 write/ 가, 일정은 feed/ 가 들고 있고
 * 화면은 여기 적힌 이름으로만 부른다 — **화면에서 새로 만드는 부작용은 없다.**
 */
export interface ViewCtx {
  app: any;
  plugin: any;
  /** 이 캘린더가 실제로 그리는 곳(컨테이너 안에 하나) */
  root: El;
  /** Dataview 가 들고 있는 luxon DateTime */
  L: any;
  /** 캘린더를 연 시점의 오늘. ⚠️ 자정을 넘기면 낡는다(알려진 버그) */
  todayISO: string;
  /** 블록별 일정 필터 (gcal: / gcal-exclude:) */
  CALF: { off: boolean; include: string[]; exclude: string[] };

  // ── 상태(CalendarController) ──
  S: any;
  st: { mode: string; view: any; showDone: boolean; showEvents: boolean; dragging: any };
  ctrl: any;
  activeCats: Set<string>;
  saveState: () => void;
  syncCategories: () => void;
  collect: () => CalItem[];
  render: () => void;
  takeDrag: () => CalItem | null;
  restorePageScroll: () => void;
  rememberScroll: () => void;

  // ── 쓰기(TaskWriteService) ──
  openAtLine: (task: CalItem, evt?: any) => any;
  editTask: (task: CalItem) => any;
  applyDates: (task: CalItem, changes: any) => Promise<void>;
  dropOnDate: (task: CalItem, iso: string, shift: boolean) => Promise<void>;
  dropOnTime: (task: CalItem, iso: string, startMin: number) => Promise<void>;
  writeBack: (task: CalItem, newDue: string) => Promise<void>;
  openMode: (e: any) => boolean | string;
  writer: any;

  // ── 일정(FeedAdapter) ──
  feed: () => any;
  feedPlugin: () => any;
  eventsFor: (fromISO: string, toISO: string) => CalItem[];
  passesCalFilter: (e: any) => boolean;
  rangeForView: () => [string, string];

  // ── 공통 조각 ──
  noteMarkdown: () => string;
  noteBlock: (md: string) => El;
  /** 배경 날짜 칸이 드롭을 받게 한다(데스크탑 전용) */
  attachDrop: (el: El, iso: string, baseBg: string) => void;
  HOUR_H: number;
  DAY_BOX_H: number;
  GUTTER: number;
}

/** 매 렌더 새로 오는 카테고리 네 값. */
export interface Categories {
  CATS: string[];
  CATLABEL: Record<string, string>;
  CATCOLOR: Record<string, string>;
  CAT_DEFAULT: string;
}

/**
 * 항목의 색 — **합집합이 갈리는 유일한 자리**다. 일정은 피드가 계산해 실어 온 색(color),
 * task 는 카테고리 색이다. `fallback` 은 모바일만 쓴다(데스크탑은 카테고리가 없으면 undefined
 * 그대로 두던 현재 동작을 지킨다).
 */
export function itemColor(
  t: CalItem,
  CATCOLOR: Record<string, string>,
  CAT_DEFAULT: string,
  fallback?: string
): string {
  if (t.kind === "event") return t.color;
  return CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT] || (fallback as string);
}

/** 항목의 카테고리 키. 일정에는 없다(필터도 별도 토글로 건다) → 빈 문자열. */
export const catKey = (t: CalItem): string => (t.kind === "event" ? "" : t.cat);
