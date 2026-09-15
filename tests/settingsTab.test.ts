/**
 * 설정 탭의 현재 동작(0.7.1 — TS 로 옮기기 전에 고정).
 *
 * 화면 트리(사용법 샘플 · 모바일 · 카테고리 · GCal 일정 캘린더 색)와 핸들러마다
 * 바꾸는 설정 · 부르는 메서드 · display() 재호출 여부를 골든으로 둔다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { Platform, noticeLog } from "./obsidian-stub";
import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { FakeEl, findAll, serializeEl } from "./helpers/fakeDom";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require("../src/main").__test;

type Over = { settings?: any; feed?: any };

function makePlugin(over: Over = {}) {
  const calls: any[] = [];
  const settings = JSON.parse(JSON.stringify({ ...T.DEFAULT_SETTINGS, ...(over.settings ?? {}) }));
  const plugin: any = {
    settings,
    calls,
    saveSettings: async () => {
      calls.push(["saveSettings"]);
    },
    refreshAll: () => calls.push(["refreshAll"]),
    gcalFeed: () => over.feed ?? null,
  };
  return plugin;
}

function mount(plugin: any) {
  const tab: any = new T.GcalCalendarSettingTab({}, plugin);
  tab.containerEl = new FakeEl("div");
  tab.display();
  return tab;
}

const FEED = {
  listSelectedCalendars: () => [
    { id: "cal-own", name: "Work", color: "" },
    { id: "cal-growth", name: "Growth", color: "" },
    { id: "cal-holiday", name: "Holidays in South Korea", color: "" },
  ],
};
const WITH_OWN = { eventColors: { "cal-own": "#abcdef" } };

/** 핸들러를 하나씩 — 매번 새로 마운트해 그것만 실행한다. */
async function exerciseAll(label: string, over: Over) {
  const probe = mount(makePlugin(over));
  const targets: { kind: "control" | "el"; path: number[]; ci?: number; desc: string }[] = [];
  const walk = (el: FakeEl, path: number[]) => {
    const s = (el as any).setting;
    if (s) {
      s.controls.forEach((c: any, ci: number) => {
        if (c.onChangeCb || c.onClickCb) {
          targets.push({ kind: "control", path, ci, desc: `${s.nameText || "(이름 없음)"} ${ci}:${c.type}${c.buttonText ? " " + c.buttonText : ""}${c.tooltip ? " " + c.tooltip : ""}` });
        }
      });
      return;
    }
    if (el.onclick) targets.push({ kind: "el", path, desc: `<${el.tag}> ${el.text}` });
    el.children.forEach((c, i) => walk(c, [...path, i]));
  };
  walk(probe.containerEl, []);

  const out: any[] = [];
  for (const tg of targets) {
    const plugin = makePlugin(over);
    const tab = mount(plugin);
    let node: FakeEl = tab.containerEl;
    for (const i of tg.path) node = node.children[i];
    const before = JSON.parse(JSON.stringify(plugin.settings));
    let displays = 0;
    const real = tab.display.bind(tab);
    tab.display = () => {
      displays++;
      real();
    };
    noticeLog.length = 0;
    clip.length = 0;
    let input: any;
    try {
      if (tg.kind === "control") {
        const c = (node as any).setting.controls[tg.ci!];
        if (c.type === "text") input = "  new  ";
        else if (c.type === "color") input = "#010203";
        else if (c.type === "dropdown") {
          const others = c.options.filter(([v]: [string, string]) => v !== c.value);
          input = (others.length ? others : c.options).slice(-1)[0][0];
        }
        if (c.onChangeCb) await c.onChangeCb(input);
        else await c.onClickCb();
      } else {
        await node.onclick!();
      }
    } catch (e) {
      plugin.calls.push(["THREW", e instanceof Error ? e.message : String(e)]);
    }
    const changed: Record<string, any> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(plugin.settings)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(plugin.settings[k])) changed[k] = plugin.settings[k];
    }
    out.push({
      target: tg.desc,
      input,
      changed,
      calls: plugin.calls,
      display: displays,
      notices: [...noticeLog],
      clipboard: [...clip],
      buttonTextAfter: tg.kind === "el" ? node.text : undefined,
    });
  }
  golden(`settingsTab.handlers.${label}`, out);
}

const clip: string[] = [];

(async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t: string) => void clip.push(t) } },
  });
  // 샘플 복사 버튼은 1.2초 뒤 글자를 되돌린다 — 테스트가 그 타이머를 기다리지 않게
  const realTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => (ms >= 1000 ? 0 : realTimeout(fn, ms));

  (Platform as any).isPhone = false;
  golden("settingsTab.tree.desktop-no-feed", serializeEl(mount(makePlugin()).containerEl));
  golden("settingsTab.tree.feed-empty", serializeEl(mount(makePlugin({ feed: { listSelectedCalendars: () => [] } })).containerEl));
  golden("settingsTab.tree.feed-calendars", serializeEl(mount(makePlugin({ feed: FEED, settings: WITH_OWN })).containerEl));
  (Platform as any).isPhone = true;
  golden("settingsTab.tree.phone", serializeEl(mount(makePlugin()).containerEl));
  (Platform as any).isPhone = false;

  await exerciseAll("desktop-feed", { feed: FEED, settings: WITH_OWN });

  // hide(): 설정 창을 닫을 때 한 번만 다시 그린다
  {
    const plugin = makePlugin();
    const tab = mount(plugin);
    tab.hide();
    golden("settingsTab.hide", plugin.calls);
  }

  // 사용법 샘플 문구(복사 대상) — 트리에도 있지만 따로 모아 한눈에
  {
    const tab = mount(makePlugin());
    golden(
      "settingsTab.samples",
      findAll(tab.containerEl, (e) => e.tag === "pre").map((e) => e.text)
    );
  }

  (globalThis as any).setTimeout = realTimeout;
  done();
})();
