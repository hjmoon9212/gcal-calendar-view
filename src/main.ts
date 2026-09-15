/*
 * Gcal Calendar View — #task 를 기간 막대·타임블록으로 그리는 캘린더.
 *
 * 원래는 볼트마다 놓인 dataviewjs 스크립트(Scripts/View/GcalCalendarView.js)였다.
 * 사본이 볼트별로 갈라지는 문제 때문에 플러그인으로 옮겼다 — 이제 BRAT 이 모든
 * 볼트·기기에 같은 버전을 배포하고, 볼트마다 다른 값(카테고리·색)은 설정에 둔다.
 *
 * 노트에서는 코드블록으로 부른다:
 *   ```gcal-calendar            ← 이 노트가 놓인 폴더 이하 (기본)
 *   ```
 *   ```gcal-calendar
 *   scope: vault                ← 볼트 전체
 *   ```
 *   ```gcal-calendar
 *   source: "0. Note" and !"Template"   ← Dataview 소스 쿼리 직접 지정
 *   ```
 *
 * Dataview 는 계속 필요하다 — 페이지 수집(api.pages)과 luxon 을 빌려 쓴다.
 */
import { MarkdownRenderChild, Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { GcalCalendarSettingTab } from "./settings/SettingsTab";
import { TaskSheetModal } from "./ui/TaskSheetModal";
import { parseList, parseOptions, resolveCalFilter, resolveSource } from "./core/blockOptions";
import { categoryColorMap, resolveEventColorInfo } from "./core/colors";
import { byDayOrder, dayRank } from "./core/order";
import { layoutTimeLanes } from "./core/timeLanes";
// @ts-ignore — 0.7.1 은 JS 그대로 옮겼다(타입은 0.7.5)
import { createCalendar } from "./calendar/createCalendar.js";

export default class GcalCalendarViewPlugin extends Plugin {
    settings: any;
    store: any;
    views!: Set<any>;

    async onload() {
        await this.loadSettings();
        // 구 window.__gcalCal — 보던 달·필터·스크롤과 낙관적 갱신 대기표를 담는다.
        // 캘린더(스코프)별로 분리되므로 한 노트에 여러 개가 있어도 서로 간섭하지 않는다.
        this.store = { state: {}, pending: new Map() };
        this.views = new Set();

        this.addSettingTab(new GcalCalendarSettingTab(this.app, this));
        this.registerMarkdownCodeBlockProcessor("gcal-calendar", (src, el, ctx) =>
            this.renderBlock(src, el, ctx)
        );

        // ── 커맨드 ──
        // 여태 하나도 없었다 — 폰에서는 커맨드 팔레트가 주된 진입로인데 이 플러그인은
        // 코드블록이 적힌 노트를 찾아가는 것 말고는 부를 방법이 없었다.

        // 폰에서 백틱 세 개와 블록 이름을 손으로 치는 게 가장 힘든 지점이다.
        this.addCommand({
            id: "insert-block",
            name: "캘린더 블록 삽입",
            editorCallback: (editor: any) => {
                editor.replaceSelection("```gcal-calendar\n```\n");
            },
        });

        // 태블릿은 isPhone 이 false 라 자동으로는 모바일 화면을 받지 못한다.
        // 설정 앱까지 가지 않고 여기서 바꿀 수 있어야 한다.
        this.addCommand({
            id: "toggle-mobile-ui",
            name: "모바일 화면 전환 (자동 → 항상 → 끄기)",
            callback: async () => {
                const order = ["auto", "always", "off"];
                const label: Record<string, string> = { auto: "자동 (폰에서만)", always: "항상", off: "끄기" };
                const cur = order.indexOf(this.settings.mobileUi || "auto");
                const next = order[(cur + 1) % order.length];
                this.settings.mobileUi = next;
                await this.saveSettings();
                this.refreshAll();
                new Notice("모바일 화면: " + label[next]);
            },
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * tasks-gcal-sync 의 읽기 전용 API. 설정 화면에서 «표시할 일정» 목록을 읽는 데 쓴다.
     * 없으면 null — 미설치·구버전·인증 전·고른 캘린더 0개 (전부 정상 상태다).
     */
    gcalFeed() {
        try {
            const a = (this.app as any).plugins?.plugins?.["tasks-gcal-sync"]?.api;
            if (!a || typeof a.listSelectedCalendars !== "function") return null;
            return a.isReady() ? a : null;
        } catch (e) {
            return null;
        }
    }

    /** 열려 있는 캘린더를 모두 다시 그린다 (설정 변경 후). */
    refreshAll() {
        for (const cal of this.views) {
            if (cal.isAlive()) cal.refresh();
        }
    }

    renderBlock(src: string, el: any, ctx: any) {
        const child = new MarkdownRenderChild(el);
        ctx.addChild(child);

        const plugins = (this.app as any).plugins.plugins;
        const api = plugins.dataview && plugins.dataview.api;
        if (!api) {
            // 로드 순서상 우리가 먼저일 수 있다. 안내를 띄우고 인덱스가 준비되면 한 번 다시 그린다.
            const warn = el.createEl("div", {
                text: "Dataview 플러그인이 필요합니다 — 활성화되면 자동으로 다시 그립니다.",
            });
            warn.style.cssText =
                "padding:8px;border:1px dashed var(--background-modifier-border);border-radius:4px;font-size:12px;opacity:.8;";
            let done = false;
            const ref = (this.app.metadataCache as any).on("dataview:index-ready", () => {
                if (done) return;
                done = true;
                (this.app.metadataCache as any).offref(ref);
                el.empty();
                this.renderBlock(src, el, ctx);
            });
            child.register(() => {
                if (!done) (this.app.metadataCache as any).offref(ref);
                done = true;
            });
            return;
        }

        const opts = parseOptions(src);
        const source = resolveSource(opts, ctx.sourcePath);
        let cal;
        try {
            cal = createCalendar({
                plugin: this, api, container: el, source,
                notes: opts.note, sourcePath: ctx.sourcePath, component: child,
                calFilter: resolveCalFilter(opts),
            });
        } catch (e) {
            console.error("[gcal-calendar-view] 렌더 실패", e);
            el.createEl("div", { text: "캘린더 렌더 실패 — 콘솔을 확인하세요: " + e.message });
            return;
        }
        this.views.add(cal);
        child.register(() => this.views.delete(cal));

        // 부분 갱신: Dataview 인덱스가 바뀌면 컨테이너를 비우지 않고 root 안에서만 교체한다.
        // (dataviewjs 시절에는 dv.component.render 를 덮어써야 했다 — 이제 우리가 소유한다)
        const ref = (this.app.metadataCache as any).on("dataview:metadata-change", () => {
            if (cal.isAlive()) cal.refresh();
        });
        child.register(() => (this.app.metadataCache as any).offref(ref));
    }
}

// 테스트가 옮기기 전과 같은 이름으로 꺼내 쓴다. Obsidian 은 기본 export 만 보므로 이 이름은 무해하다.
export const __test = {
    parseOptions,
    resolveSource,
    parseList,
    resolveCalFilter,
    resolveEventColorInfo,
    categoryColorMap,
    layoutTimeLanes,
    byDayOrder,
    dayRank,
    DEFAULT_SETTINGS,
    TaskSheetModal,
    GcalCalendarSettingTab,
};
