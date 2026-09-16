/*
 * 캘린더 한 개의 **배선**. 그리는 것도, 고치는 것도 여기 없다 — 조각을 만들어 이어 줄 뿐이다.
 *
 *   · calendar/CalendarController.ts  보는 단위·기준일·필터 · 렌더 큐 · 수집 캐시 · 스크롤 기억
 *   · write/TaskWriteService.ts       노트 쓰기(`vault.process` 는 거기서만) · 열기 · 편집 모달
 *   · feed/FeedAdapter.ts             GCal 일정 가져오기(덕 타이핑 · 구독 · 구간 캐시)
 *   · ui/desktop/DesktopView.js       트레이 · 툴바 · 월/주/일 달력 (드래그 · 우클릭)
 *   · ui/mobile/MobileView.js         트레이 카드 · 월간 점 · 날짜별 목록 · 일간 타임라인 (탭)
 *   · ui/style.ts · ui/lanes.ts       표면이 공유하는 스타일 조각 · 주 경계 레인 배치
 *
 * 데스크탑과 모바일은 **화면만** 갈라진다 — 수집·쓰기·피드는 한 벌을 나눠 쓴다. 사본이
 * 갈라지면 ⏰ 삽입 규칙 같은 것이 한쪽에서만 고쳐진다(dataviewjs 시절 갈라지던 그 문제다).
 * 인라인 cssText 도 그대로 둔다 — styles.css 로 옮기면 테마와의 CSS 특이성이 달라진다.
 */
import { MarkdownRenderer } from "obsidian";
import { resolveEventColor } from "../core/colors";
import { createWriteService } from "../write/TaskWriteService";
import { createController } from "./CalendarController";
import { rangeForView as viewRange } from "../feed/events";
import { createFeedAdapter } from "../feed/FeedAdapter";
import { createDesktopView } from "../ui/desktop/DesktopView";
import { createMobileView } from "../ui/mobile/MobileView";

/**
 * 캘린더 한 개를 container 안에 그린다. 반환값의 refresh() 를 호출부가 인덱스 변경에 물린다.
 * 본문은 dataviewjs 시절 로직 그대로다(레인 배치·드래그·낙관적 갱신·스크롤 복원·⏰).
 */
export interface CalendarArgs {
    plugin: any;
    /** Dataview API — 페이지 수집과 luxon 을 빌려 쓴다 */
    api: any;
    container: any;
    /** 수집 스코프(Dataview 소스 쿼리). 상태 보관함의 키이기도 하다. */
    source: string;
    /** 블록의 `note:` 줄 */
    notes: string[];
    sourcePath: string;
    /** 이 렌더의 수명(MarkdownRenderChild) — 구독을 여기 건다 */
    component: any;
    calFilter?: { off: boolean; include: string[]; exclude: string[] };
}

export function createCalendar({ plugin, api, container, source, notes, sourcePath, component, calFilter }: CalendarArgs) {
    const app = plugin.app;
    // 블록별 일정 필터 (calendars: / exclude-calendars:). 없으면 전부 통과.
    const CALF = calFilter || { off: false, include: [], exclude: [] };
    const L = api.luxon.DateTime;   // Dataview 가 들고 있는 luxon 재사용
    const root = container.createEl("div");
    root.style.width = "100%";
    root.classList.add("gcal-cal");
    // 이 캘린더가 수집할 스코프 (코드블록 옵션에서 결정돼 주입된다)
    const SOURCE = source;

    // ── 상태 · 스크롤 · 렌더 큐 · 수집 ──────────────────────────────────────
    // 전부 calendar/CalendarController.ts 가 들고 있다. 화면은 여기서 꺼낸 이름으로만 닿는다.
    const ctrl = createController({ plugin, container, pages: () => api.pages(SOURCE), source: SOURCE, luxon: L });
    const S = ctrl.S;
    const st = ctrl.st;
    const activeCats = ctrl.activeCats;
    const isMobileUi = () => ctrl.isMobileUi();
    const saveState = () => ctrl.saveState();
    const rememberScroll = () => ctrl.rememberScroll();
    const restorePageScroll = () => ctrl.restorePageScroll();
    const invalidate = () => ctrl.invalidate();
    const collect = () => ctrl.collect();
    const takeDrag = () => ctrl.takeDrag();
    const render = () => ctrl.render();
    // 카테고리(설정에서 내려온다)는 매 렌더 다시 읽는다 — 이 네 값은 그래서 let 이다.
    let CATS: string[] = [];
    let CATLABEL: Record<string, string> = {};
    let CATCOLOR: Record<string, string> = {};
    let CAT_DEFAULT = "";
    const syncCategories = () => { ({ CATS, CATLABEL, CATCOLOR, CAT_DEFAULT } = ctrl.refreshCategories()); };
    syncCategories();

    // ★ **열 때마다 이번 달 · 오늘 선택으로 시작한다**(0.6.0~).
    //
    // 예전에는 보던 달/보기를 `S` 에 기억했다. 그런데 캘린더를 여는 이유는 대개
    // **"오늘 뭐 있지"** 라서, 지난달이나 일간에 떨어져 있으면 매번 오늘로 돌아오는 데
    // 탭을 두세 번 쓰게 된다. 기억해서 얻는 것보다 잃는 게 컸다.
    //
    // ⚠️ **"열 때" 는 `createCalendar` 가 도는 순간뿐이다.** 그 뒤의 재렌더는 컨트롤러의
    //    `mode`/`view` 를 그대로 쓰므로, 달을 넘기거나 일간에 들어간 상태에서 노트를
    //    편집해도 화면이 튀지 않는다 — 되돌리는 건 노트를 다시 열었을 때다.
    //
    // 필터(완료 표시 · 📆 일정 · 카테고리)는 **그대로 유지한다.** 그건 "어디를 보는가" 가
    // 아니라 "무엇을 보는가" 라서, 매번 다시 맞추게 하면 성가시다.
    S.mDay = L.now().toISODate();   // 모바일 월간의 「오늘 카드」가 바로 펼쳐지게

    // ══ GCal 일정 (읽기 전용) ═══════════════════════════════════════════════════
    // 가져오는 일은 feed/FeedAdapter.ts 가 한다(덕 타이핑 · 구독 · 구간 캐시). 여기서는
    // 화면이 쓰는 이름만 남긴다.
    const feedApi = createFeedAdapter({
        app,
        component,
        settings: () => plugin.settings,
        calFilter: CALF,
        categories: () => ({ CATS, CATCOLOR }),
        showEvents: () => st.showEvents,
        onChange: () => render(),
        isAlive: () => root.isConnected,
        eventColor: (e) => resolveEventColor(plugin.settings, CATCOLOR, e.calendarId, e.calendarName),
    });
    const feedPlugin = () => feedApi.feedPlugin();
    const feed = () => feedApi.feed();
    const eventsFor = (fromISO: string, toISO: string) => feedApi.eventsFor(fromISO, toISO);
    const passesCalFilter = (e: any) => feedApi.passes(e);


    /**
     * `note:` 로 적어 둔 설명을 캘린더 위에 그린다. 여러 줄은 줄바꿈으로 이어 붙인다.
     *
     * **마크다운으로 렌더한다.** 이 옵션의 용도가 원래 블록 위에 두던 콜아웃 내용을
     * 옮겨 담는 것이라, `**굵게**`·`` `코드` ``·`- 목록`·[[링크]] 가 글자 그대로
     * 보이면 옮길 수가 없다.
     */
    // 이 블록에 note: 가 적혀 있을 때만 그린다. 공통 사용법은 설정 화면에 붙박이로 있다.
    const noteMarkdown = () => (notes && notes.length ? notes.join("\n") : "");

    function noteBlock(md: string) {
        const d = document.createElement("div");
        d.style.cssText =
            "margin-bottom:8px;padding:6px 10px;border-left:3px solid var(--interactive-accent);" +
            "background:var(--background-secondary);border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;opacity:.9;";
        // Obsidian 1.5+ 는 정적 render(), 그 이전은 renderMarkdown(). 둘 다 받아준다.
        try {
            if (typeof MarkdownRenderer.render === "function") {
                MarkdownRenderer.render(plugin.app, md, d, sourcePath, component);
            } else {
                MarkdownRenderer.renderMarkdown(md, d, sourcePath, component);
            }
        } catch (e) {
            console.warn("[gcal-calendar-view] note 마크다운 렌더 실패 → 평문으로 표시", e);
            d.setText(md);
        }
        return d;
    }

    // 날짜 계산(addDays · diffDays · sundayStart · coversDay · onDay)은 core/dates.ts.
    // ⚠️ 이 값은 캘린더를 연 시점에 굳는다 — 자정을 넘기면 낡는다(알려진 버그, 0.8.x 에서 고친다).
    const todayISO = L.now().toISODate();

    // ⏰ 타임블록의 문법·분 계산(TIME_PAT · FIELD_EMOJI · toMin · toHHMM · timeText · snapMin)은
    // core/time.ts 에 있다. **줄에 넣는 위치 규칙**도 거기 주석에 있다 — 고치기 전에 읽을 것.
    const HOUR_H = 64;        // 일간 보기에서 1시간 높이(px). 15분 스냅 = 16px 라 15분 단위가 눈에 잡힌다
    const DAY_BOX_H = 560;    // 시간 그리드 스크롤 박스 높이(px)
    const GUTTER = 52;        // 시각 라벨이 차지하는 왼쪽 폭(px)

    // ══ 노트 쓰기 ══════════════════════════════════════════════════════════════
    // 여는 것도 고치는 것도 write/TaskWriteService.ts 가 한다 — `vault.process` 는 거기서만
    // 부른다. 화면은 아래 이름으로만 닿는다.
    const writer = createWriteService({
        app,
        pending: plugin.store.pending,
        rememberScroll,
        afterWrite: () => { invalidate(); render(); },
    });
    const openMode = (e: any) => writer.openMode(e);
    const openAtLine = (task: any, evt?: any) => writer.openAtLine(task, evt);
    const editTask = (task: any) => writer.editTask(task);
    const applyDates = (task: any, changes: any) => writer.applyDates(task, changes);
    const dropOnDate = (task: any, iso: string, shift: boolean) => writer.dropOnDate(task, iso, shift);
    const dropOnTime = (task: any, iso: string, startMin: number) => writer.dropOnTime(task, iso, startMin);
    const writeBack = (task: any, newDue: string) => writer.writeBack(task, newDue);

    // 배경 날짜 칸에 트레이 카드 드롭 → 해당 날짜로 due 지정/이동
    function attachDrop(el: any, iso: string, baseBg: string) {
        el.addEventListener("dragover", (e: any) => { e.preventDefault(); e.stopPropagation(); el.style.background = "var(--background-modifier-active-hover)"; });
        el.addEventListener("dragleave", () => { el.style.background = baseBg; });
        el.addEventListener("drop", async (e: any) => { e.preventDefault(); e.stopPropagation(); el.style.background = baseBg; const t = takeDrag(); if (t) await dropOnDate(t, iso, e.shiftKey); });
    }

    const rangeForView = () => viewRange(st.mode, st.view);

    // ── 화면 ────────────────────────────────────────────────────────────────
    // 데스크탑과 모바일은 **화면만** 갈라진다. 수집·쓰기·피드는 위의 것을 그대로 쓴다 —
    // 사본이 갈라지면 ⏰ 삽입 규칙 같은 것이 한쪽에서만 고쳐진다(이 플러그인이 dataviewjs
    // 스크립트에서 옮겨 온 이유가 바로 그 "사본이 갈라짐" 이다).
    const viewCtx = {
        app, plugin, root, L, todayISO, CALF,
        S, st, ctrl, activeCats, saveState, syncCategories, collect, render, takeDrag,
        restorePageScroll, rememberScroll,
        openAtLine, editTask, applyDates, dropOnDate, dropOnTime, writeBack, openMode, writer,
        feed, feedPlugin, eventsFor, passesCalFilter, rangeForView,
        noteMarkdown, noteBlock, attachDrop,
        HOUR_H, DAY_BOX_H, GUTTER,
    };
    const desktop = createDesktopView(viewCtx);
    const mobile = createMobileView(viewCtx);

    function renderNow() {
        syncCategories();   // 설정이 바뀌었을 수 있다 (플러그인 재시작 없이 반영하려면 매번 읽어야 한다)
        const cats = { CATS, CATLABEL, CATCOLOR, CAT_DEFAULT };
        desktop.setCategories(cats);
        mobile.setCategories(cats);
        // 터치에서는 데스크탑 조작(드래그·우클릭)이 이벤트조차 발생하지 않는다 —
        // 폰에서는 통째로 다른 화면을 그린다. 판정은 **매 렌더** 다시 한다.
        return ctrl.isMobileUi() ? mobile.renderMobileNow() : desktop.renderDesktop();
    }

    ctrl.attach(renderNow);   // 렌더 큐가 부를 대상
    renderNow();   // 첫 페인트는 동기로 — setTimeout 으로 미루면 그만큼 빈 칸으로 남는다
    // 호출부(코드블록 프로세서)가 Dataview 인덱스 변경에 물려 쓴다.
    return { refresh: () => { invalidate(); renderNow(); }, isAlive: () => root.isConnected };
}
