/**
 * 플러그인 클래스의 현재 동작(0.7.1 — main.ts 로 옮기기 전에 고정).
 * 명령 · 설정 로드 · 모바일 화면 전환 · tasks-gcal-sync 피드 덕 타이핑 · Dataview 가 늦게 올 때.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { noticeLog } from "./obsidian-stub";
import { eq, ok, done } from "./helpers/assert";
import { FakeEl, serializeEl } from "./helpers/fakeDom";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../src/main");
const PluginClass = mod.default ?? mod;
const T = mod.__test;

function makeApp(plugins: Record<string, any> = {}) {
  const refs: any[] = [];
  const offs: any[] = [];
  const app: any = {
    plugins: { plugins },
    metadataCache: {
      on(name: string, fn: (...a: any[]) => any) {
        const ref = { name, fn };
        refs.push(ref);
        return ref;
      },
      offref(ref: any) {
        offs.push(ref);
      },
    },
  };
  return { app, refs, offs };
}

(async () => {
  // ── onload: 무엇을 등록하나 ──
  {
    const { app } = makeApp();
    const p: any = new PluginClass(app, { id: "gcal-calendar-view", version: "test" });
    await p.onload();
    eq(p.__commands.map((c: any) => [c.id, c.name]), [
      ["insert-block", "캘린더 블록 삽입"],
      ["toggle-mobile-ui", "모바일 화면 전환 (자동 → 항상 → 끄기)"],
    ], "명령 두 개 · 순서");
    eq(p.__codeBlocks.map((c: any) => c[0]), ["gcal-calendar"], "코드블록 `gcal-calendar` 하나");
    eq(p.__settingTabs.length, 1, "설정 탭 하나");
    ok(p.__settingTabs[0] instanceof T.GcalCalendarSettingTab, "설정 탭 클래스");
    eq(Object.keys(p.store), ["state", "pending"], "store = { state, pending }");
    ok(p.store.pending instanceof Map, "pending 은 Map");
    ok(p.views instanceof Set && p.views.size === 0, "views 는 빈 Set");

    // insert-block
    const inserted: string[] = [];
    p.__commands[0].editorCallback({ replaceSelection: (s: string) => inserted.push(s) });
    eq(inserted, ["```gcal-calendar\n```\n"], "insert-block: 빈 블록을 커서에");
  }

  // ── loadSettings: 얕은 병합 ──
  {
    const { app } = makeApp();
    const p: any = new PluginClass(app, {});
    p.__data = null;
    await p.loadSettings();
    eq(p.settings, T.DEFAULT_SETTINGS, "data.json 없음 → 기본값");
    // ⚠️ 현재 동작(버그 후보): 얕은 병합이라 categories 배열이 **기본값과 같은 객체**다.
    //    설정 탭의 추가·삭제·키 편집이 DEFAULT_SETTINGS 자체를 바꾼다.
    ok(p.settings.categories === T.DEFAULT_SETTINGS.categories, "ODDITY: categories 가 DEFAULT_SETTINGS 와 같은 배열");
    ok(p.settings.eventColors === T.DEFAULT_SETTINGS.eventColors, "ODDITY: eventColors 도 같은 객체");
    const before = T.DEFAULT_SETTINGS.categories.length;
    p.settings.categories.push({ key: "x", label: "X", color: "#000000" });
    eq(T.DEFAULT_SETTINGS.categories.length, before + 1, "ODDITY: 설정에 push 하면 기본값이 늘어난다");
    T.DEFAULT_SETTINGS.categories.pop();

    p.__data = { mobileUi: "off", categories: [{ key: "work", label: "W", color: "#111111" }], unknown: 1 };
    await p.loadSettings();
    eq(p.settings.mobileUi, "off", "저장된 값이 이긴다");
    eq(p.settings.categories, [{ key: "work", label: "W", color: "#111111" }], "배열은 통째로 교체(병합 아님)");
    eq(p.settings.unknown, 1, "모르는 키도 남긴다");
    eq(p.settings.eventColor, "#7f8c8d", "없는 키는 기본값");
    eq(Object.keys(p.settings), ["categories", "defaultCategory", "eventColors", "eventColor", "mobileUi", "unknown"], "키 순서: 기본값 순 → 새 키");

    await p.saveSettings();
    eq(p.__data, JSON.parse(JSON.stringify(p.settings)), "saveSettings 는 settings 를 통째로 저장");
  }

  // ── toggle-mobile-ui: 자동 → 항상 → 끄기 → 자동 ──
  {
    const { app } = makeApp();
    const p: any = new PluginClass(app, {});
    await p.onload();
    const refreshed: string[] = [];
    p.views.add({ isAlive: () => true, refresh: () => refreshed.push("alive") });
    p.views.add({ isAlive: () => false, refresh: () => refreshed.push("dead") });
    noticeLog.length = 0;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await p.__commands[1].callback();
      seen.push(p.settings.mobileUi + "/" + p.__data.mobileUi);
    }
    eq(seen, ["always/always", "off/off", "auto/auto", "always/always"], "순환 순서 · 매번 저장");
    eq(noticeLog, ["모바일 화면: 항상", "모바일 화면: 끄기", "모바일 화면: 자동 (폰에서만)", "모바일 화면: 항상"], "Notice 문구");
    eq(refreshed, ["alive", "alive", "alive", "alive"], "살아 있는 캘린더만 다시 그린다");

    p.settings.mobileUi = "weird";
    await p.__commands[1].callback();
    eq(p.settings.mobileUi, "auto", "모르는 값이면 indexOf -1 → 다음은 auto");
  }

  // ── gcalFeed: tasks-gcal-sync API 덕 타이핑 ──
  {
    const cases: [string, any, string][] = [
      ["미설치", undefined, "null"],
      ["api 없음", {}, "null"],
      ["listSelectedCalendars 없음", { api: { isReady: () => true } }, "null"],
      ["준비 안 됨", { api: { listSelectedCalendars: () => [], isReady: () => false } }, "null"],
      ["isReady 가 던짐", { api: { listSelectedCalendars: () => [], isReady: () => { throw new Error("x"); } } }, "null"],
      ["isReady 없음", { api: { listSelectedCalendars: () => [] } }, "null"],
      ["준비됨", { api: { listSelectedCalendars: () => [], isReady: () => true } }, "api"],
    ];
    for (const [label, plugin, want] of cases) {
      const { app } = makeApp(plugin ? { "tasks-gcal-sync": plugin } : {});
      const p: any = new PluginClass(app, {});
      const got = p.gcalFeed();
      eq(got === null ? "null" : got === plugin.api ? "api" : "other", want, `gcalFeed: ${label}`);
    }
    const p: any = new PluginClass({}, {});
    eq(p.gcalFeed(), null, "app.plugins 자체가 없어도 null");
  }

  // ── renderBlock: Dataview 가 아직 없을 때 ──
  {
    const { app, refs, offs } = makeApp({});
    const p: any = new PluginClass(app, {});
    await p.loadSettings();
    p.store = { state: {}, pending: new Map() };
    p.views = new Set();
    const el = new FakeEl("div");
    const children: any[] = [];
    const ctx = { sourcePath: "0. Note/a.md", addChild: (c: any) => children.push(c) };
    p.renderBlock("scope: vault", el, ctx);
    eq(serializeEl(el), {
      tag: "div",
      children: [
        {
          tag: "div",
          text: "Dataview 플러그인이 필요합니다 — 활성화되면 자동으로 다시 그립니다.",
          style: { cssText: "padding:8px;border:1px dashed var(--background-modifier-border);border-radius:4px;font-size:12px;opacity:.8;" },
        },
      ],
    }, "안내 한 줄");
    eq(refs.map((r) => r.name), ["dataview:index-ready"], "index-ready 를 기다린다");
    eq(children.length, 1, "렌더 수명(MarkdownRenderChild)을 ctx 에 붙인다");

    // 인덱스가 준비됐는데 여전히 Dataview API 가 없으면 → 비우고 다시 안내(구독을 새로 건다)
    refs[0].fn();
    eq(offs.length, 1, "첫 신호에서 구독 해제");
    eq(el.children.length, 1, "비우고 다시 그렸다 — 안내 한 줄");
    eq(refs.map((r) => r.name), ["dataview:index-ready", "dataview:index-ready"], "다시 기다린다");
    refs[0].fn();
    eq(offs.length, 1, "이미 처리한 신호는 무시(done)");

    // 두 번째 렌더의 수명이 끝나면 아직 안 온 구독을 푼다
    children[1].unload();
    eq(offs.length, 2, "언로드 → 대기 중 구독 해제");
    children[0].unload();
    eq(offs.length, 2, "이미 끝난 첫 렌더는 다시 풀지 않는다");
  }

  done();
})();
