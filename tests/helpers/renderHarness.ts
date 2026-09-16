/**
 * 캘린더 한 개를 가짜 DOM 에 그려 보는 하네스(0.7.2).
 *
 * `createCalendar` 는 브라우저 전역(document · requestAnimationFrame · getComputedStyle)과
 * 플러그인 바깥 세 곳(Dataview · tasks-gcal-sync 피드 · Obsidian vault/workspace)에 닿는다.
 * 그 넷을 여기서 한 번에 세우고, 테스트는 **무엇을 넣었을 때 무엇이 그려지는지**만 본다.
 *
 * ⛔ 진짜 시각·진짜 파일을 쓰지 않는다. 시계는 fakeEnv 가 2026-08-06 12:00(로컬)로 고정하고,
 *    노트는 메모리 문자열이다. luxon 은 Dataview 가 주는 것과 같은 방식으로 `api.luxon` 에 싣는다.
 */
import { DateTime } from "luxon";
import { FakeEl } from "./fakeDom";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults";

/** 하네스가 기록하는 바깥 호출. "무엇을 불렀나" 가 곧 이 캘린더의 부작용 전부다. */
export interface Calls {
  /** 피드에 "이 구간을 보고 있다" 고 알린 기록 — 캐시 적중이어도 매번 있어야 한다(0.2.7). */
  requestEvents: [string, string][];
  peekEvents: [string, string][];
  /** 노트에 쓴 결과. path → 최종 본문 */
  writes: { path: string; before: string; after: string }[];
  opened: { path: string; line: number; mode: any }[];
  editModal: string[];
  notices: string[];
  settingTab: string[];
  /** 피드 변경 구독을 건 횟수 — 인증 전에도 걸려 있어야 한다(0.2.2). */
  subscribed: number;
}

export interface EventFix {
  uid: string;
  title: string;
  startISO: string;
  endISO: string;
  tStart: number | null;
  tEnd: number | null;
  allDay: boolean;
  calendarId: string;
  calendarName: string;
  location?: string;
  recurring?: boolean;
}

export interface HarnessOptions {
  /** 볼트의 노트 — path → 본문. `#task` 줄이 그대로 Dataview 태스크가 된다. */
  files: Record<string, string>;
  events?: EventFix[];
  /** 피드 상태: "none" 미설치 · "not-ready" 인증 전 · "ready" 정상 */
  feed?: "none" | "not-ready" | "ready";
  calendars?: { id: string; name: string; color?: string }[];
  settings?: Record<string, any>;
  /** 코드블록 옵션에서 온 값 */
  source?: string;
  notes?: string[];
  calFilter?: { off: boolean; include: string[]; exclude: string[] };
  /** 이전 렌더에서 이어받는 상태(store.state[source]) */
  state?: Record<string, any>;
  tasksPluginEdit?: (line: string) => string | Promise<string>;
  /**
   * Dataview 인덱스가 따라오지 않는 상태를 만든다 — 노트는 바뀌었는데 `pages()` 는 옛 줄을 준다.
   * 낙관적 갱신(대기표)이 존재하는 이유가 이 구간이라, 그것을 보려면 이 상태가 필요하다.
   */
  indexLag?: boolean;
}

/** Dataview 가 주는 모양으로 노트를 태스크 목록으로 바꾼다(불릿·체크박스만 벗긴다). */
function pagesFrom(files: Record<string, string>): any[] {
  return Object.entries(files).map(([path, body]) => ({
    file: {
      path,
      tasks: body.split("\n").flatMap((raw, line) => {
        const m = raw.match(/^\s*[-*+]\s*\[(.)\]\s*(.*)$/);
        if (!m) return [];
        return [{ text: m[2], line, status: m[1], completed: m[1] === "x" || m[1] === "X" }];
      }),
    },
  }));
}

/** document · rAF · getComputedStyle 을 세운다. 테스트 파일마다 한 번. */
export function installDom(): void {
  const head = new FakeEl("head");
  const doc: any = {
    head,
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => {
      const n = new FakeEl("#text");
      n.text = text;
      return n;
    },
    getElementById: (id: string) => head.children.find((c) => c.attrs.id === id || (c as any).id === id) ?? null,
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  // rAF 는 **즉시** 부른다. 캘린더는 스크롤 복원을 동기 1회 + 다음 프레임 1회로 하는데,
  // 미뤄 두면 테스트가 끝난 뒤에 돌아 어느 스냅샷에도 안 잡힌다.
  (globalThis as any).requestAnimationFrame = (fn: () => void) => {
    fn();
    return 0;
  };
  // 스크롤 컨테이너 탐색용. 아무 것도 스크롤하지 않는 문서로 둔다.
  (globalThis as any).getComputedStyle = () => ({ overflowY: "visible" });
}

export function makeHarness(o: HarnessOptions) {
  const calls: Calls = { requestEvents: [], peekEvents: [], writes: [], opened: [], editModal: [], notices: [], settingTab: [], subscribed: 0 };
  const files = { ...o.files };
  const events = o.events ?? [];
  const feedMode = o.feed ?? "none";
  const listeners: (() => void)[] = [];

  const feedApi = {
    isReady: () => feedMode === "ready",
    peekEvents: (from: string, to: string) => {
      calls.peekEvents.push([from, to]);
      return events.filter((e) => e.startISO <= to && e.endISO >= from);
    },
    requestEvents: async (from: string, to: string) => {
      calls.requestEvents.push([from, to]);
    },
    listSelectedCalendars: () => o.calendars ?? [],
    onChange: (cb: () => void) => {
      calls.subscribed++;
      listeners.push(cb);
      return { unsubscribe: true };
    },
  };

  const tasksPlugin = o.tasksPluginEdit
    ? { apiV1: { editTaskLineModal: async (line: string) => {
        calls.editModal.push(line);
        return o.tasksPluginEdit!(line);
      } } }
    : undefined;

  const vaultFile = (path: string) => (files[path] === undefined ? null : { path, extension: "md" });
  const app: any = {
    plugins: {
      plugins: {
        ...(feedMode === "none" ? {} : { "tasks-gcal-sync": { api: feedApi } }),
        ...(tasksPlugin ? { "obsidian-tasks-plugin": tasksPlugin } : {}),
      },
    },
    vault: {
      getAbstractFileByPath: (p: string) => vaultFile(p),
      read: async (f: any) => files[f.path],
      process: async (f: any, fn: (d: string) => string) => {
        const before = files[f.path];
        const after = fn(before);
        files[f.path] = after;
        if (after !== before) calls.writes.push({ path: f.path, before, after });
        return after;
      },
    },
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: (mode: any) => ({
        openFile: async (f: any, opts: any) => {
          calls.opened.push({ path: f.path, line: opts?.eState?.line ?? 0, mode });
        },
        view: null,
      }),
      setActiveLeaf: () => {},
      revealLeaf: () => {},
    },
    setting: {
      open: () => calls.settingTab.push("open"),
      openTabById: (id: string) => calls.settingTab.push(id),
    },
  };

  const plugin: any = {
    app,
    settings: JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, ...(o.settings ?? {}) })),
    store: { state: {}, pending: new Map() },
  };
  const source = o.source ?? "\"0. Note\" and !\"Template\"";
  if (o.state) plugin.store.state[source] = { ...o.state };

  const container = new FakeEl("div");
  const component = { register: (cb: any) => listeners.push(cb) };

  return {
    calls,
    files,
    plugin,
    container,
    /** 피드가 "일정이 바뀌었다" 고 알린다 — 구독이 실제로 걸렸는지 본다. */
    notifyFeed: () => listeners.forEach((f) => typeof f === "function" && f()),
    args: {
      plugin,
      api: {
        luxon: { DateTime },
        pages: (_src: string) => pagesFrom(o.indexLag ? { ...o.files } : files),
      },
      container,
      source,
      notes: o.notes ?? [],
      sourcePath: "0. Note/캘린더.md",
      component,
      calFilter: o.calFilter,
    },
  };
}

/** 렌더 결과에서 조건에 맞는 요소를 문서 순서로 — 버튼을 라벨로 집을 때 쓴다. */
export function byText(root: FakeEl, text: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (e: FakeEl) => {
    if (e.text === text) out.push(e);
    e.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * 라벨이 적힌 **누를 수 있는** 요소. 글자만 보고 고르면 트레이 카드의 카테고리 이름 같은
 * 장식 글자를 집는다 — 실제로 onclick 이 달린 것만 본다(버튼 글자는 자식 span 일 수 있다).
 */
export function clickable(root: FakeEl, label: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (e: FakeEl) => {
    if (e.onclick && (e.text === label || e.children.some((c) => c.text === label))) out.push(e);
    e.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** 라벨로 눌러 다시 그린다. 렌더 큐가 setTimeout 이라 한 틱 기다린다. */
export async function clickLabel(root: FakeEl, label: string, nth = 0): Promise<void> {
  const el = clickable(root, label)[nth];
  if (!el) throw new Error(`누를 수 있는 "${label}" 이(가) 없다`);
  await el.onclick!({ preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
}
