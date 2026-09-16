/*
 * 캘린더 한 개 — 수집 · 레인 배치 · 드래그 · 낙관적 갱신 · 스크롤 복원 · ⏰ · 모바일 화면.
 * main.js 에서 **본문 그대로** 옮겼다(0.7.1). 쪼개는 것은 0.7.2 에서 렌더 하네스를 만든 뒤다.
 */
import { Keymap, MarkdownRenderChild, MarkdownRenderer, Notice, Platform } from "obsidian";
import { byDayOrder, isRO } from "../core/order";
import { layoutTimeLanes } from "../core/timeLanes";
import { calKey } from "../core/blockOptions";
import { resolveEventColor } from "../core/colors";
import { addDays, coversDay, diffDays, onDay, sundayStart } from "../core/dates";
import { DEFAULT_MIN, SNAP_MIN, snapMin, timeText, toHHMM, toMin } from "../core/time";
import { pkey } from "../data/pending";
import { gatherTasks } from "../data/gather";
import { findTaskLine, patchLine } from "../write/linePatch";
import { planDropOnDate, planDropOnTime, planWriteBack } from "../write/dropRules";
import { syncCategories as resolveCategories } from "./categories";
import { eventCacheKey, passesCalFilter as passesFilter, rangeForView as viewRange, toEventItem as makeEventItem } from "../feed/events";
import { layoutWeekBars } from "../ui/lanes";
import { mobileHourRange } from "../ui/mobileHours";
import { TaskSheetModal } from "../ui/TaskSheetModal";

/**
 * 캘린더 한 개를 container 안에 그린다. 반환값의 refresh() 를 호출부가 인덱스 변경에 물린다.
 * 본문은 dataviewjs 시절 로직 그대로다(레인 배치·드래그·낙관적 갱신·스크롤 복원·⏰).
 */
export function createCalendar({ plugin, api, container, source, notes, sourcePath, component, calFilter }) {
    const app = plugin.app;
    // 블록별 일정 필터 (calendars: / exclude-calendars:). 없으면 전부 통과.
    const CALF = calFilter || { off: false, include: [], exclude: [] };
    const L = api.luxon.DateTime;   // Dataview 가 들고 있는 luxon 재사용
    const root = container.createEl("div");
    root.style.width = "100%";
    root.classList.add("gcal-cal");
    // 이 캘린더가 수집할 스코프 (코드블록 옵션에서 결정돼 주입된다)
    const SOURCE = source;

    // ── 모바일 화면을 쓸 것인가 ───────────────────────────────────────────────
    // 데스크탑 렌더러는 조작이 전부 HTML5 드래그와 우클릭이라 터치에서는 **이벤트가
    // 아예 발생하지 않는다** — 폰에서는 열기 말고 아무것도 못 한다. 그래서 화면을
    // 통째로 갈아 끼운다(renderNow 첫 줄에서 갈린다). 쓰기 경로(applyDates)는 공유한다.
    //
    // 설정으로 강제할 수 있어야 한다: 태블릿은 isPhone 이 false 고, 모바일 화면을
    // 고칠 때 폰을 들지 않고 데스크탑에서 바로 확인할 수 있어야 한다.
    //
    // ⚠️ const 로 한 번만 계산하면 안 된다 — createCalendar() 는 한 번만 돌고 이후엔
    //    renderNow() 만 다시 돈다. 값을 굳혀 두면 설정을 바꿔도 **이미 열려 있는 캘린더는
    //    옛 렌더러를 계속 쓴다.** 카테고리(syncCategories)가 같은 이유로 매 렌더 다시 읽는다.
    const isMobileUi = () => {
        const m = plugin.settings.mobileUi;
        if (m === "always") return true;
        if (m === "off") return false;
        try { return !!Platform.isPhone; } catch (e) { return false; }
    };

    // ── 재실행 대비 전역 보관함 ────────────────────────────────────────────────
    // Dataview 는 볼트의 파일이 바뀔 때마다 이 dataviewjs 블록을 통째로 재실행한다
    // (설정: refreshInterval, 기본 2500ms). 그때 스크립트 지역변수는 전부 초기화되므로
    // 보던 달/주·필터·스크롤이 되돌아가고, 방금 옮긴 막대도 옛 자리로 그려져 깜빡여 보인다.
    // → 유지해야 할 값은 window 에 두고 재실행 직후 복원한다. 캘린더(스코프)별로 분리.
    const G = plugin.store;   // 상태·대기표는 플러그인 인스턴스가 소유(구 window.__gcalCal)
    const S = (G.state[SOURCE] = G.state[SOURCE] || {});
    // 다시 열 때 이어 갈 것만 저장한다. **`mode`/`view` 는 일부러 뺐다**(0.6.0~) —
    // 열 때마다 이번 달·오늘로 시작하므로 저장해도 아무도 안 읽는다. 안 읽는 값을
    // 계속 쓰면 다음에 보는 사람이 "어디서 복원되나" 를 헛짚는다.
    const saveState = () => { S.showDone = showDone; S.showEvents = showEvents; S.cats = [...activeCats]; };

    // ── 블록이 처음부터 다시 그려질 때의 안전망 ──────────────────────────
    // 인덱스 변경은 refresh() 로 root 안에서만 교체되지만, 노트를 다시 열거나
    // 읽기/편집 뷰를 전환하면 Obsidian 이 코드블록을 통째로 다시 렌더한다.
    // 그 사이 컨테이너에 자식이 없어 높이가 0 이 되고, 노트가 짧아지면서
    // 브라우저가 스크롤을 끌어올린다. root 에 높이를 예약해봐야 소용없다 —
    // root 자체가 그때 새로 생기니까. 그래서 컨테이너 쪽에 예약해 둔다.
    const HOLD = container;
    if (S.h) HOLD.style.minHeight = S.h + "px";

    // 노트의 스크롤 컨테이너(읽기 뷰 = .markdown-preview-view, 편집 뷰 = .cm-scroller).
    // 우리가 파일을 쓸 때 위치를 기억해두고, 바로 뒤따르는 재실행의 첫 렌더에서 되돌린다.
    const SCROLL_TTL = 5000;   // ms — 이 시간 안의 기억만 복원 (그 뒤 사용자가 직접 스크롤했으면 존중)
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
    const rememberScroll = () => { if (scroller) { S.scrollTop = scroller.scrollTop; S.scrollTs = Date.now(); } };
    const restorePageScroll = () => {
        if (!scroller || S.scrollTop === undefined) return;
        if (Date.now() - (S.scrollTs || 0) > SCROLL_TTL) return;
        if (Math.abs(scroller.scrollTop - S.scrollTop) > 1) scroller.scrollTop = S.scrollTop;
    };

    // 낙관적 갱신 대기표(키 규칙 · 만료)는 data/pending.ts 에 있다.
    // 날짜 선택기(webkit 캘린더 아이콘) 깨짐 → 깔끔한 SVG 아이콘으로 교체 (테마색 반영)
    (function fixDateIcon() {
        // 캘린더가 여러 개 열려 있어도 한 번만 주입하고, 테마는 선택자로 갈라 즉시 반영되게 한다.
        // (이전에는 실행할 때마다 서로의 style 을 지우고 다시 만들었고, 테마 전환에는 반응하지 않았다)
        if (document.getElementById("gcal-date-fix")) return;
        const svg = (stroke) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${stroke}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='18' rx='2'/%3E%3Cline x1='16' y1='2' x2='16' y2='6'/%3E%3Cline x1='8' y1='2' x2='8' y2='6'/%3E%3Cline x1='3' y1='10' x2='21' y2='10'/%3E%3C/svg%3E`;
        const rule = (sel, stroke, scheme) =>
            `${sel} .gcal-cal input[type="date"]{color-scheme:${scheme};}` +
            `${sel} .gcal-cal input[type="date"]::-webkit-calendar-picker-indicator{opacity:.85;cursor:pointer;background:url("${svg(stroke)}") center/14px no-repeat;}`;
        const st = document.createElement("style");
        st.id = "gcal-date-fix";
        st.textContent = rule("body.theme-dark", "%23cccccc", "dark") + rule("body:not(.theme-dark)", "%23444444", "light");
        document.head.appendChild(st);
    })();
    // ★ **열 때마다 이번 달 · 오늘 선택으로 시작한다**(0.6.0~).
    //
    // 예전에는 보던 달/보기를 `S` 에 기억했다. 그런데 캘린더를 여는 이유는 대개
    // **"오늘 뭐 있지"** 라서, 지난달이나 일간에 떨어져 있으면 매번 오늘로 돌아오는 데
    // 탭을 두세 번 쓰게 된다. 기억해서 얻는 것보다 잃는 게 컸다.
    //
    // ⚠️ **"열 때" 는 `createCalendar` 가 도는 순간뿐이다.** 그 뒤의 재렌더(`renderNow`)는
    //    지역 변수 `mode`/`view` 를 그대로 쓰므로, 달을 넘기거나 일간에 들어간 상태에서
    //    노트를 편집해도 화면이 튀지 않는다 — 되돌리는 건 노트를 다시 열었을 때다.
    //
    // 필터(완료 표시 · 📆 일정 · 카테고리)는 **그대로 유지한다.** 그건 "어디를 보는가" 가
    // 아니라 "무엇을 보는가" 라서, 매번 다시 맞추게 하면 성가시다.
    let mode = "month";
    let view = L.now().startOf("month");
    S.mDay = L.now().toISODate();   // 모바일 월간의 「오늘 카드」가 바로 펼쳐지게
    let dragging = null;
    let showDone = S.showDone !== false;   // 달력에 완료 항목 표시 여부
    let showEvents = S.showEvents !== false;   // GCal 일정(회의·약속) 표시 여부

    // ══ GCal 일정 (읽기 전용) ═══════════════════════════════════════════════════
    // 실제 Google Calendar 일정은 tasks-gcal-sync 가 받아온다 — 자격증명이 거기 있고,
    // 여기에 OAuth 를 또 두면 refresh token 소비자가 둘이 되어 회전 때 경합한다.
    //
    // 매 렌더마다 다시 찾는다. 로드 순서는 보장되지 않고 사용자가 나중에 켤 수도 있다
    // (editTask 가 obsidian-tasks-plugin 을 찾는 방식과 같다). 버전이 아니라 **덕 타이핑**
    // 이라 구·신 버전이 섞여 있어도 깨지지 않고 그냥 없는 것처럼 동작한다.
    //
    // null 이 되는 경우: 모바일(그쪽은 isDesktopOnly 라 아예 로드 안 됨) · 미설치 ·
    // 구버전(api 없음) · 인증 전 · 고른 캘린더 0개. 전부 v0.1.13 과 동일한 화면이 된다.
    // 플러그인이 깔려 있고 API 모양이 맞는가 (준비 여부는 안 본다)
    const feedPlugin = () => {
        try {
            const p = app.plugins && app.plugins.plugins && app.plugins.plugins["tasks-gcal-sync"];
            const a = p && p.api;
            if (!a || typeof a.peekEvents !== "function" || typeof a.requestEvents !== "function") return null;
            return a;
        } catch (e) {
            return null;   // 실패하면 없는 것으로 — 캘린더는 task 만 그린다(fail open)
        }
    };
    // 지금 일정을 줄 수 있는가 (인증됨 + 고른 캘린더 1개 이상)
    const feed = () => {
        const a = feedPlugin();
        try { return a && a.isReady() ? a : null; } catch (e) { return null; }
    };

    // 드롭 타깃이 dragging 을 집어갈 때 쓴다. 일정에서는 dragging 을 세팅하지 않으므로
    // 이중 안전장치지만, 나중에 어포던스 가드를 하나 잊어도 여기서 막힌다.
    const takeDrag = () => { const t = dragging; dragging = null; return isRO(t) ? null : t; };


    // ══ 카테고리 (플러그인 설정에서 내려온다) ════════════════════════════════════
    // 볼트마다 다른 유일한 값이라 코드가 아니라 설정에 둔다 — 사본이 갈라지던 원인이었다.
    // 설정 탭에서 편집한다.
    //
    // ⚠️ const 로 한 번만 계산하면 안 된다. dataviewjs 시절에는 인덱스가 바뀔 때마다
    //    스크립트가 통째로 재실행돼 자동으로 최신 설정이 반영됐지만, 플러그인에서는
    //    createCalendar() 가 한 번만 돌고 이후엔 renderNow() 만 다시 돈다. 그래서
    //    매 렌더 시작에 syncCategories() 로 설정을 다시 읽는다 — 안 그러면 설정을
    //    바꿔도 플러그인을 껐다 켜야 반영된다.
    let CATS = [], CATLABEL = {}, CATCOLOR = {}, CAT_DEFAULT = "";
    const activeCats = new Set(Array.isArray(S.cats) ? S.cats : undefined);   // 필터도 재실행 후 유지
    const syncCategories = () => {
        ({ CATS, CATLABEL, CATCOLOR, CAT_DEFAULT } = resolveCategories(plugin.settings, S, activeCats));
    };
    syncCategories();
    // ═════════════════════════════════════════════════════════════════════════════

    /**
     * `note:` 로 적어 둔 설명을 캘린더 위에 그린다. 여러 줄은 줄바꿈으로 이어 붙인다.
     *
     * **마크다운으로 렌더한다.** 이 옵션의 용도가 원래 블록 위에 두던 콜아웃 내용을
     * 옮겨 담는 것이라, `**굵게**`·`` `코드` ``·`- 목록`·[[링크]] 가 글자 그대로
     * 보이면 옮길 수가 없다.
     */
    // 이 블록에 note: 가 적혀 있을 때만 그린다. 공통 사용법은 설정 화면에 붙박이로 있다.
    const noteMarkdown = () => (notes && notes.length ? notes.join("\n") : "");

    function noteBlock(md) {
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

    // 어디에 열 것인가 — Obsidian 링크와 똑같은 규칙을 따른다.
    //   그냥 클릭 = 현재 탭 · Ctrl(Cmd)+클릭 = 새 탭 · Ctrl+Shift+클릭 = 분할 창
    // Keymap.isModEvent 가 있으면 그걸 쓴다 (사용자의 Obsidian 설정까지 반영됨).
    // dataviewjs 샌드박스에 Keymap 이 없는 버전을 대비해 직접 판정도 남겨둔다.
    const openMode = (e) => {
        if (!e) return false;
        if (typeof Keymap !== "undefined" && Keymap && typeof Keymap.isModEvent === "function") return Keymap.isModEvent(e);
        if (e.ctrlKey || e.metaKey) return e.shiftKey ? "split" : "tab";
        return false;
    };

    // 그 파일을 보여줄 leaf 를 고른다.
    // 이미 어딘가 열려 있으면 새로 열지 않고 그 탭으로 이동한다 (중복 탭 방지).
    // 단 Ctrl(Cmd)+클릭은 "새로 열라"는 뜻이므로 그때는 항상 새 탭/분할.
    function leafForFile(path, mode) {
        if (!mode) {
            const open = app.workspace.getLeavesOfType("markdown")
                .find(l => l.view && l.view.file && l.view.file.path === path);
            if (open) {
                app.workspace.setActiveLeaf(open, { focus: true });
                app.workspace.revealLeaf(open);   // 사이드바/접힌 탭이면 꺼내 준다
                return open;
            }
        }
        return app.workspace.getLeaf(mode);   // false = 현재 탭(설정에 따라 새 탭) · "tab" = 새 탭 · "split" = 분할
    }

    // 원본 노트의 해당 줄로 이동 (편집 모드면 커서/스크롤까지 보정)
    async function openAtLine(task, evt) {
        if (isRO(task)) return;   // GCal 일정은 노트에 원본이 없다
        const f = app.vault.getAbstractFileByPath(task.path);
        if (!f) { new Notice("파일 없음: " + task.path); return; }
        const leaf = leafForFile(task.path, openMode(evt));
        const line = typeof task.line === "number" ? task.line : 0;
        await leaf.openFile(f, { eState: { line }, active: true });
        const ed = leaf.view && leaf.view.editor;
        if (ed) { ed.setCursor({ line, ch: 0 }); ed.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true); }
    }

    // 우클릭 → Tasks 편집 모달(탭 이동 없이). apiV1.editTaskLineModal 로 줄을 수정 → 파일 반영 → 제자리 갱신.
    async function editTask(task) {
        if (isRO(task)) return;   // GCal 일정은 읽기 전용
        rememberScroll();
        const tp = app.plugins.plugins["obsidian-tasks-plugin"];
        const api = tp && tp.apiV1;   // apiV1 은 getter(속성) — 괄호 없이 접근
        const file = app.vault.getAbstractFileByPath(task.path);
        if (!file) { new Notice("파일 없음: " + task.path); return; }
        // API 없으면(구버전 등) 원본 줄로 이동만
        if (!api || typeof api.editTaskLineModal !== "function") { await openAtLine(task); return; }
        const curLines = (await app.vault.read(file)).split("\n");
        const idx = findTaskLine(curLines, task);
        if (idx < 0) { new Notice("태스크 줄을 찾지 못함: " + task.path); return; }
        const cur = curLines[idx];
        const edited = await api.editTaskLineModal(cur);   // 취소 시 빈 문자열/원본 반환
        if (!edited || edited === cur) return;
        let missed = false;
        let wroteAt = idx;
        await app.vault.process(file, (d) => {
            const lines = d.split("\n");
            const j = findTaskLine(lines, task);
            if (j < 0) { missed = true; return d; }   // 못 찾으면 아무것도 건드리지 않는다
            lines[j] = edited;
            wroteAt = j;
            return lines.join("\n");
        });
        if (missed) { new Notice("태스크 줄을 찾지 못함: " + task.path); return; }
        // applyDates 와 같은 낙관적 갱신 — 인덱스가 따라올 때까지 옛 텍스트로 그려져 튀는 걸 막는다.
        // ⚠️ 오버레이의 text 는 Dataview 의 t.text 형식(불릿·체크박스 없음)이어야 한다. 파일 줄을
        //    그대로 넣으면 gather() 가 그걸 태스크 텍스트로 삼아 제목이 "- [ ] 제목" 이 되고,
        //    그 값이 다음 쓰기 때 patch(task.text) 로 다시 오버레이에 저장돼 계속 전파된다.
        // ⚠️ 반복(🔁) task 를 완료하면 Tasks 가 **다음 회차 줄까지 만들어 두 줄을 개행으로 이어**
        //    돌려준다. 그건 한 태스크의 텍스트가 아니므로 낙관적 갱신 대상이 아니다 — 넣으면
        //    제목이 "할일 - [x] 할일" 처럼 합쳐져 보이고, 줄이 하나 늘어 이후 조작이
        //    "태스크 줄을 찾지 못함" 으로 떨어진다. 이 경우는 Dataview 재색인에 그냥 맡긴다.
        if (!/\r?\n/.test(edited)) {
            G.pending.set(pkey(task.path, wroteAt, task.title), { text: edited.replace(/^\s*[-*+]\s*\[.\]\s*/, ""), ts: Date.now() });
        }
        invalidate();
        render();
    }

    // 배경 날짜 칸에 트레이 카드 드롭 → 해당 날짜로 due 지정/이동
    function attachDrop(el, iso, baseBg) {
        el.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); el.style.background = "var(--background-modifier-active-hover)"; });
        el.addEventListener("dragleave", () => { el.style.background = baseBg; });
        el.addEventListener("drop", async (e) => { e.preventDefault(); e.stopPropagation(); el.style.background = baseBg; const t = takeDrag(); if (t) await dropOnDate(t, iso, e.shiftKey); });
    }

    const gather = () => gatherTasks(api.pages(SOURCE), { catDefault: CAT_DEFAULT, pending: G.pending, now: Date.now() });

    const passesCalFilter = (e) => passesFilter(e, CALF);

    /**
     * 일정의 색. **색은 전부 이 플러그인 설정이 정한다** — tasks-gcal-sync 가 실어 보내는
     * `e.color` 는 일부러 보지 않는다. 색이 두 군데 있으면 어느 쪽이 이기는지를 매번
     * 되짚어야 하고, 실제로 그렇게 헷갈렸다.
     *
     * 기본이 **카테고리 색**인 이유: `#gcal/<이름>` 라우팅이 태그 이름과 캘린더 이름을 그대로
     * 맞추므로, 캘린더 "Growth" 의 회의는 growth 카테고리 색이 되어 같은 캘린더의 task 막대와
     * 저절로 같아진다.
     */
    const eventColor = (e) => resolveEventColor(plugin.settings, CATCOLOR, e.calendarId, e.calendarName);
    const toEventItem = (e) => makeEventItem(e, eventColor(e));

    // 일정은 gather() 에 넣지 않는다. dataCache 는 볼트 쓰기 때 무효화되는 물건이라
    // 거기 넣으면 일정이 영영 낡고, 대기표(pending) 스윕이 헛돈다. 별도 메모를 둔다.
    let evCache = null;
    let feedVersion = 0;   // 피드가 onChange 로 알릴 때마다 올린다
    let subscribed = false;

    // 일정이 도착하면 다시 그리도록 구독한다. **처음 피드를 본 시점에** 건다 —
    // 캘린더를 만들 때 한 번만 시도하면, 나중에 인증하거나 캘린더를 고른 사용자는
    // 다른 이유로 렌더가 일어날 때까지 아무 일도 안 일어난 것처럼 보인다.
    // component(MarkdownRenderChild)에 걸어 두므로 노트를 닫으면 자동 해제된다.
    const subscribe = (f) => {
        if (subscribed || !f || typeof f.onChange !== "function") return;
        subscribed = true;
        try {
            component.register(f.onChange(() => {
                feedVersion++;
                if (root.isConnected) render();
            }));
        } catch (e) {
            console.debug("[gcal-calendar-view] 일정 구독 실패 — 갱신은 렌더 때만 일어난다", e);
        }
    };

    const eventsFor = (fromISO, toISO) => {
        subscribe(feedPlugin());   // 준비 전에도 걸어 둔다 — 설정에서 캘린더를 고르면 알려 온다
        const f = feed();
        if (!f || !showEvents || CALF.off) return [];
        const key = eventCacheKey(fromISO, toISO, feedVersion, CATS, CATCOLOR, plugin.settings);
        // ★ 캐시가 맞아도 **먼저** 요청한다 (v0.2.7). 이 호출은 피드에게 "뷰가 이 구간을
        //   보고 있다" 를 알리는 유일한 신호다. 캐시 적중일 때 건너뛰었더니 조용한 구간에서
        //   피드가 이 창을 잊고 폴링을 멈췄고 — 폴링이 멈추면 달라질 일이 없으니 이 캐시도
        //   영영 유효해서 — GCal 에서 지운 일정이 Obsidian 재시작 전까지 남았다(2026-09-07).
        //   실제 네트워크 호출 여부는 피드가 TTL 로 판단하므로 매 렌더 불러도 싸다.
        // 던지고 잊는다 — 도착하면 onChange 가 온다.
        // 계약상 reject 하지 않지만, 플러그인 경계 너머라 버전이 어긋날 수 있다.
        // catch 를 붙여 두지 않으면 그때 unhandled rejection 이 콘솔을 채운다.
        try { Promise.resolve(f.requestEvents(fromISO, toISO)).catch(() => { }); } catch (_) { }
        if (evCache && evCache.key === key) return evCache.items;
        let items = [];
        try {
            items = f.peekEvents(fromISO, toISO).filter(passesCalFilter).map(toEventItem);
        } catch (e) {
            console.debug("[gcal-calendar-view] 일정 조회 실패 → task 만 그린다", e);
            items = [];
        }
        evCache = { key, items };
        return items;
    };

    const rangeForView = () => viewRange(mode, view);

    // 원본 줄의 🛫 start / 📅 due / ⏰ time 을 직접 변경 (changes: {start?, due?, time?}).
    // 없는 필드는 새로 추가하고, time 에 null 을 주면 시각을 제거한다.
    async function applyDates(task, changes) {
        // ★ 쓰기의 유일한 길목이다. dropOnDate·dropOnTime·writeBack·리사이즈가 전부 여기로
        //   흐르므로, 개별 어포던스 가드를 하나 빠뜨려도 GCal 일정이 노트를 고칠 수는 없다.
        if (isRO(task)) return;
        rememberScroll();   // 쓰기 → Dataview 재실행 사이에 스크롤이 튀지 않게
        const file = app.vault.getAbstractFileByPath(task.path);
        if (!file) { new Notice("파일 없음: " + task.path); return; }
        // 줄을 고치는 규칙은 write/linePatch.ts 한 곳에 있다.
        const patch = (ln) => patchLine(ln, changes);
        let wroteAt = task.line;   // 실제로 고친 줄 (대기표 키를 여기에 맞춰야 함)
        let missed = false;
        await app.vault.process(file, (data) => {
            const lines = data.split("\n");
            const i = findTaskLine(lines, task);
            if (i < 0) { missed = true; return data; }   // 못 찾으면 아무것도 건드리지 않는다
            lines[i] = patch(lines[i]);
            wroteAt = i;
            return lines.join("\n");
        });
        if (missed) { new Notice("태스크 줄을 찾지 못함: " + task.path); return; }
        // Dataview 인덱스는 몇 초 늦게 따라온다 → 그 전까지 쓸 새 줄을 대기표에 올린다.
        // (이게 없으면 바로 뒤 render() 가 옛 날짜로 그렸다가 인덱스 갱신 때 막대가 튄다)
        G.pending.set(pkey(task.path, wroteAt, task.title), { text: patch(task.text), ts: Date.now() });
        invalidate();
        render();
    }

    // 무엇을 쓸지 정하는 규칙은 write/dropRules.ts 에 있다. 여기서는 **쓰고 말한다**.
    const runPlan = async (task, plan) => {
        if (!plan.changes) { new Notice(plan.notice); return; }
        await applyDates(task, plan.changes);
        new Notice(plan.notice);
    };
    // 배경 날짜 칸 드롭 (일반 = 기간째 이동 · Shift = 마감일만 조정)
    const dropOnDate = (task, iso, shift) => runPlan(task, planDropOnDate(task, iso, shift));
    // 일간 보기 시간 그리드 드롭 → 시각 지정/이동
    const dropOnTime = (task, iso, startMin) => runPlan(task, planDropOnTime(task, iso, startMin));
    // 트레이 빠른버튼·날짜선택기 → 마감일만 지정
    const writeBack = (task, newDue) => runPlan(task, planWriteBack(task, newDue));

    // 한 주(weekStartISO~+6)에 걸치는 태스크를 기간 막대로 area 위에 배치.
    // 막대 본체 드래그=기간째 이동, Shift+드래그=마감일 조정, 클릭=원본 열기. 반환=막대영역 높이(px).
    /**
     * 기간 막대 한 줄의 높이(px). 막대 자체는 `laneH - 3`.
     *
     * **월간·주간이 같은 값을 쓴다**(0.6.3~). 예전에는 월간 20 · 주간 26 으로 갈려 있어
     * 보기를 바꿀 때마다 같은 막대가 다른 두께로 보였다. 20 은 빽빽해서 제목이 잘리고
     * 드롭 타깃(막대를 다른 날로 끄는 자리)도 좁았다.
     */
    const LANE_H = 25;

    function placeBars(area, tasks, weekStartISO, laneH, topOffset, laneMemo) {
        const clampCol = (c) => Math.max(0, Math.min(6, c));
        const colAt = (clientX) => { const r = area.getBoundingClientRect(); return clampCol(Math.floor((clientX - r.left) / r.width * 7)); };

        // 막대 위에 떨궈도 처리되도록 area 자체가 드롭 받음 (빈 칸은 각 셀이 처리)
        area.addEventListener("dragover", (e) => e.preventDefault());
        area.addEventListener("drop", async (e) => { e.preventDefault(); const t = takeDrag(); if (t) await dropOnDate(t, addDays(weekStartISO, colAt(e.clientX)), e.shiftKey); });

        const { placed, lanes: laneCount } = layoutWeekBars(tasks, weekStartISO, laneMemo);
        for (const b of placed) {
            const t = b.t;
            const ro = isRO(t);
            const c = ro ? t.color : (CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT]);
            const dim = t.done || t.cancelled;          // 취소[-] 도 완료처럼 흐리게
            const overdue = !ro && !dim && t.due < todayISO;   // 일정에는 "지연" 이 없다
            const bar = area.createEl("div");
            bar.title = ro
                ? `${t.title}\n📆 ${t.calendarName}` +
                  (t.tStart !== null ? `\n⏰ ${timeText(t.tStart, t.tEnd)}` : `\n종일`) +
                  (t.start !== t.due ? `\n${t.start} ~ ${t.due}` : `\n${t.due}`) +
                  (t.recurring ? "\n🔁 반복 일정" : "") +
                  (t.location ? `\n📍 ${t.location}` : "") +
                  "\n(읽기 전용 — Google Calendar 일정)"
                : `${t.title}\n🛫 ${t.start || "-"}  📅 ${t.due}` + (t.tStart !== null ? `  ⏰ ${timeText(t.tStart, t.tEnd)}` : "") + (t.recurring ? "\n🔁 반복" : "") + (dim ? (t.cancelled ? "\n(취소됨)" : "\n(완료됨)") : "\n드래그=기간째 이동(놓은 칸=시작일) · Shift+드래그=마감일만 조정 · 클릭=열기 · Ctrl+클릭=새 탭");
            // 일정은 더 옅은 배경 · 점선 테두리 · 굵은 좌측 레일 없음 · 커서 default 로
            // "잡을 수 없는 것" 임을 알린다. 레일은 task 막대의 서명이라 일정에는 주지 않는다.
            bar.style.cssText = `position:absolute;left:calc(${b.sCol / 7 * 100}% + 2px);width:calc(${(b.eCol - b.sCol + 1) / 7 * 100}% - 4px);top:${topOffset + b.lane * laneH}px;height:${laneH - 3}px;z-index:1;box-sizing:border-box;background:${c}${ro ? "14" : "2b"};border:1px ${ro ? "dashed" : "solid"} ${overdue ? "#e05a7a" : c};${ro ? "" : `border-left:4px solid ${c};`}border-radius:${b.clipL ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipL ? "0" : "4px"};display:flex;align-items:center;padding:0 7px;font-size:11px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:${ro ? "default" : "grab"};${dim ? "opacity:0.55;text-decoration:line-through;" : ""}`;
            bar.appendChild(document.createTextNode(
                // 📆 = Google Calendar 에서 온 항목. 툴팁의 `📆 <캘린더명>` 과 같은 글자를 쓴다.
                // task 가 쓰는 글자(✓ ✗ 🔖 🔁 ◀ ▶)와 겹치지 않는다.
                (ro ? "📆 " : (t.cancelled ? "✗ " : t.done ? "✓ " : "")) +
                (t.recurring ? "🔁 " : "") +
                (t.bookmark ? "🔖 " : "") +
                (b.clipL ? "◀ " : "") +
                (t.tStart !== null && !b.clipL ? toHHMM(t.tStart) + " " : "") +
                (t.title || "(제목 없음)") + (b.clipR ? " ▶" : "")));
            if (!ro) {
                bar.draggable = true;
                // dragend 로 반드시 비운다 — 캘린더 밖에 떨궈 취소하면 dragging 이 남고,
                // 그 뒤 외부 드래그(파일 끌어오기 등)가 캘린더에 떨어지면 엉뚱한 태스크가 이동한다.
                bar.addEventListener("dragstart", (e) => { dragging = t; e.dataTransfer.effectAllowed = "move"; });
                bar.addEventListener("dragend", () => { dragging = null; });
                bar.addEventListener("click", (e) => openAtLine(t, e));
                bar.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(t); });   // 우클릭=편집 모달
            }
        }
        return laneCount * laneH;
    }

    // 날짜 없음 트레이용 — 잘리지 않는 카드
    function trayItem(task) {
        // 도달 불가 — 트레이는 tasks(=task 전용 배열)에서만 그려진다. 일정은 calTasks 에만 합류한다.
        // 그래도 막아 둔다: 뚫리면 지난 회의 수백 건이 🔴 지연 트레이를 덮는다.
        if (isRO(task)) return document.createElement("span");
        const c = CATCOLOR[task.cat] || CATCOLOR[CAT_DEFAULT];
        const el = document.createElement("div");
        el.draggable = true;
        el.title = task.text;
        el.style.cssText = `background:var(--background-primary);border:1px solid var(--background-modifier-border);border-left:4px solid ${c};border-radius:5px;padding:5px 8px;cursor:grab;`;
        const t1 = el.createEl("div", { text: (task.recurring ? "🔁 " : "") + (task.bookmark ? "🔖 " : "") + (task.title || "(제목 없음)") });
        t1.style.cssText = "font-size:13px;line-height:1.35;font-weight:500;white-space:normal;word-break:break-word;";
        const meta = el.createEl("div");
        meta.style.cssText = "font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        let base = CATLABEL[task.cat] || task.cat;
        if (task.due) base += " · 📅 " + task.due;
        const baseSpan = meta.createEl("span", { text: base });
        baseSpan.style.opacity = "0.55";
        if (task.due) {
            const od = diffDays(todayISO, task.due);
            if (od > 0) {
                const w = meta.createEl("span", { text: ` (${od}일 지남)` });
                w.style.cssText = "color:#eab308;font-weight:700;";
            }
        }

        // 빠른 재예약 컨트롤 (드래그 없이 시점 변경)
        const ctl = el.createEl("div");
        ctl.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;";
        const mkBtn = (labelText, iso) => {
            const b = ctl.createEl("button", { text: labelText });
            b.style.cssText = "font-size:11px;padding:1px 7px;border-radius:10px;cursor:pointer;";
            b.onclick = async (e) => { e.stopPropagation(); await writeBack(task, iso); };
        };
        mkBtn("오늘", todayISO);
        mkBtn("내일", addDays(todayISO, 1));
        mkBtn("+7일", addDays(todayISO, 7));
        const dp = ctl.createEl("input");
        dp.type = "date";
        dp.value = task.due || todayISO;
        dp.draggable = false;
        dp.style.cssText = "font-size:11px;padding:0 2px;";   // color-scheme 은 주입 스타일이 테마별로 처리
        dp.onclick = (e) => e.stopPropagation();
        dp.onmousedown = (e) => e.stopPropagation();
        dp.onchange = async (e) => { if (e.target.value) await writeBack(task, e.target.value); };

        el.addEventListener("dragstart", (e) => { dragging = task; e.dataTransfer.effectAllowed = "move"; });
        el.addEventListener("dragend", () => { dragging = null; });   // 취소된 드래그가 남지 않게
        el.addEventListener("click", (e) => openAtLine(task, e));
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(task); });   // 우클릭=편집 모달
        return el;
    }

    // 트레이를 파일별로 그룹핑해 렌더
    function renderGrouped(container, items) {
        if (!items.length) { container.createEl("span", { text: "없음 🎉" }).style.cssText = "font-size:12px;opacity:0.5;"; return; }
        const byFile = new Map();
        for (const t of items) { if (!byFile.has(t.path)) byFile.set(t.path, []); byFile.get(t.path).push(t); }
        for (const path of [...byFile.keys()].sort()) {
            const grp = container.createEl("div");
            grp.style.cssText = "margin-bottom:8px;";
            const name = path.split("/").pop().replace(/\.md$/, "");
            const hdr = grp.createEl("div", { text: `📄 ${name} (${byFile.get(path).length})` });
            hdr.style.cssText = "font-size:12px;font-weight:600;opacity:0.85;margin:2px 0 4px;cursor:pointer;border-bottom:1px solid var(--background-modifier-border);padding-bottom:2px;";
            hdr.onclick = async (e) => { const f = app.vault.getAbstractFileByPath(path); if (f) await leafForFile(path, openMode(e)).openFile(f, { active: true }); };
            const body = grp.createEl("div");
            body.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px;";
            for (const t of byFile.get(path)) body.appendChild(trayItem(t));
        }
    }

    function renderWeek(container, tasks) {
        const weekStart = view.toISODate();
        const wd = ["일", "월", "화", "수", "목", "금", "토"];
        const head = container.createEl("div");
        head.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);";
        for (let i = 0; i < 7; i++) {
            const iso = addDays(weekStart, i);
            const h = head.createEl("div", { text: `${wd[i]} ${parseInt(iso.slice(8, 10), 10)}` });
            h.style.cssText = `text-align:center;font-size:11px;font-weight:600;padding:3px 0;color:${i === 0 ? "#e05a7a" : i === 6 ? "#4f7cff" : "inherit"};${iso === todayISO ? "background:var(--background-modifier-hover);border-radius:4px 4px 0 0;" : ""}`;
        }
        const area = container.createEl("div");
        area.style.cssText = "position:relative;border:1px solid var(--background-modifier-border);border-radius:0 0 4px 4px;overflow:hidden;";
        const cols = area.createEl("div");
        cols.style.cssText = "position:absolute;inset:0;display:grid;grid-template-columns:repeat(7,1fr);z-index:0;";
        for (let i = 0; i < 7; i++) {
            const iso = addDays(weekStart, i);
            const cc = cols.createEl("div");
            const bg = iso === todayISO ? "var(--background-modifier-hover)" : "transparent";
            cc.style.cssText = `border-left:${i === 0 ? "0" : "1px solid var(--background-modifier-border)"};background:${bg};`;
            attachDrop(cc, iso, bg);
        }
        const barsH = placeBars(area, tasks, weekStart, LANE_H, 6);
        area.style.minHeight = (barsH + 12) + "px";
    }

    function renderMonth(container, tasks) {
        const wd = ["일", "월", "화", "수", "목", "금", "토"];
        const wdHead = container.createEl("div");
        wdHead.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);margin-bottom:2px;";
        for (let i = 0; i < 7; i++) {
            const hh = wdHead.createEl("div", { text: wd[i] });
            hh.style.cssText = `text-align:center;font-size:11px;font-weight:600;opacity:0.7;color:${i === 0 ? "#e05a7a" : i === 6 ? "#4f7cff" : "inherit"};`;
        }
        const gridStart = sundayStart(view);
        const ym = view.toFormat("yyyy-MM");
        // 이 달을 덮는 데 필요한 주 수만 그린다 (6주 고정이면 5주로 끝나는 달에 빈 줄이 남는다)
        const weeks = Math.ceil((diffDays(view.endOf("month").toISODate(), gridStart.toISODate()) + 1) / 7);
        const laneMemo = new Map();   // 여러 주에 걸친 막대가 같은 높이를 유지하도록
        for (let w = 0; w < weeks; w++) {
            const weekStartISO = gridStart.plus({ days: w * 7 }).toISODate();
            const row = container.createEl("div");
            row.style.cssText = "position:relative;overflow:hidden;margin-bottom:3px;";
            const cells = row.createEl("div");
            cells.style.cssText = "position:absolute;inset:0;display:grid;grid-template-columns:repeat(7,1fr);z-index:0;";
            for (let i = 0; i < 7; i++) {
                const iso = addDays(weekStartISO, i);
                const inMonth = iso.slice(0, 7) === ym;
                const bg = inMonth ? "transparent" : "var(--background-secondary)";
                const cc = cells.createEl("div");
                cc.style.cssText = `border:1px solid var(--background-modifier-border);background:${bg};${iso === todayISO ? "outline:2px solid var(--interactive-accent);outline-offset:-2px;" : ""}`;
                const dn = cc.createEl("div", { text: String(parseInt(iso.slice(8, 10), 10)) });
                dn.style.cssText = `font-size:10px;font-weight:600;opacity:${inMonth ? 0.7 : 0.3};text-align:right;padding:1px 4px;`;
                attachDrop(cc, iso, bg);
            }
            const barsH = placeBars(row, tasks, weekStartISO, LANE_H, 17, laneMemo);
            row.style.minHeight = (17 + barsH + 4) + "px";
        }
    }

    // 일간 보기용 칩 (종일 스트립에 놓이는, 시각 없는 태스크)
    function dayChip(task) {
        const ro = isRO(task);
        const c = ro ? task.color : (CATCOLOR[task.cat] || CATCOLOR[CAT_DEFAULT]);
        const el = document.createElement("div");
        el.title = ro
            ? `${task.title}\n📆 ${task.calendarName}\n종일` +
              (task.recurring ? "\n🔁 반복 일정" : "") +
              (task.location ? `\n📍 ${task.location}` : "") +
              "\n(읽기 전용 — Google Calendar 일정)"
            : task.title + (task.recurring ? "\n🔁 반복" : "") + "\n시간 그리드로 드래그하면 시각이 지정됩니다";
        el.style.cssText = `background:${c}${ro ? "14" : "2b"};border:1px ${ro ? "dashed" : "solid"} ${c};${ro ? "" : `border-left:4px solid ${c};`}border-radius:4px;padding:2px 7px;font-size:11px;line-height:16px;cursor:${ro ? "default" : "grab"};max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${task.done || task.cancelled ? "opacity:.55;text-decoration:line-through;" : ""}`;
        el.appendChild(document.createTextNode((ro ? "📆 " : "") + (task.recurring ? "🔁 " : "") + (task.bookmark ? "🔖 " : "") + (task.title || "(제목 없음)")));
        if (!ro) {
            el.draggable = true;
            el.addEventListener("dragstart", (e) => { dragging = task; e.dataTransfer.effectAllowed = "move"; });
            el.addEventListener("dragend", () => { dragging = null; });
            el.addEventListener("click", (e) => openAtLine(task, e));
            el.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(task); });
        }
        return el;
    }

    // 하루를 시간 그리드로. 시각 있는 태스크는 블록, 없는 태스크는 위쪽 종일 스트립.
    //   블록 드래그      = 시작 시각 이동(길이 유지)
    //   블록 하단 핸들   = 종료 시각만 변경
    //   종일 → 그리드    = 시각 부여 · 그리드 → 종일 = 시각 제거
    function renderDay(container, tasks) {
        const iso = view.toISODate();
        const today = tasks.filter((t) => onDay(t, iso));
        const timed = today.filter(t => t.tStart !== null).sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
        // 종일 스트립 안에서도 📆 일정이 먼저다 — 그날 뼈대를 왼쪽에서 바로 읽게.
        const allday = today.filter(t => t.tStart === null).sort(byDayOrder);

        // ── 종일 스트립 ──
        const ad = container.createEl("div");
        ad.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;border:1px solid var(--background-modifier-border);border-radius:4px 4px 0 0;padding:5px 6px;min-height:32px;";
        const adLabel = ad.createEl("span", { text: `종일 (${allday.length})` });
        adLabel.style.cssText = "font-size:11px;opacity:.6;margin-right:2px;";
        for (const t of allday) ad.appendChild(dayChip(t));
        ad.addEventListener("dragover", (e) => { e.preventDefault(); ad.style.background = "var(--background-modifier-active-hover)"; });
        ad.addEventListener("dragleave", () => { ad.style.background = ""; });
        ad.addEventListener("drop", async (e) => {
            e.preventDefault(); e.stopPropagation(); ad.style.background = "";
            const t = takeDrag();
            if (!t) return;
            if (t.tStart === null) { if (t.due !== iso) { await applyDates(t, { due: iso }); new Notice("📅 " + iso); } return; }
            await applyDates(t, { time: null });
            new Notice("⏰ 시각 제거");
        });

        // ── 시간 그리드 ──
        const box = container.createEl("div");
        box.style.cssText = `position:relative;height:${DAY_BOX_H}px;overflow:auto;border:1px solid var(--background-modifier-border);border-top:0;border-radius:0 0 4px 4px;`;
        // 저장 조건이 까다로운 이유: 재렌더로 이전 컨테이너가 문서에서 떨어질 때 브라우저가
        // scrollTop 을 0 으로 되돌리며 scroll 이벤트를 흘리는데, 그 낡은 컨테이너의 리스너가
        // 살아 있어서 방금 복원한 값을 0 으로 덮어쓴다. 현재 컨테이너이고 붙어 있을 때만 저장한다.
        box.addEventListener("scroll", () => {
            if (!dayScrollRestoring && box === dayBox && box.isConnected) S.dayScroll = box.scrollTop;
        });
        dayBox = box;
        const grid = box.createEl("div");
        grid.style.cssText = `position:relative;height:${24 * HOUR_H}px;`;
        for (let h = 0; h < 24; h++) {
            const row = grid.createEl("div");
            row.style.cssText = `position:absolute;left:0;right:0;top:${h * HOUR_H}px;height:${HOUR_H}px;border-top:1px solid var(--background-modifier-border);`;
            const lab = row.createEl("span", { text: String(h).padStart(2, "0") + ":00" });
            lab.style.cssText = "position:absolute;left:5px;top:1px;font-size:10px;opacity:.45;";
            // 30분 보조선
            const half = row.createEl("div");
            half.style.cssText = `position:absolute;left:${GUTTER}px;right:0;top:${HOUR_H / 2}px;border-top:1px dashed var(--background-modifier-border);opacity:.5;`;
        }
        if (iso === todayISO) {
            const now = L.now();
            const nl = grid.createEl("div");
            nl.style.cssText = `position:absolute;left:${GUTTER}px;right:0;top:${(now.hour * 60 + now.minute) / 60 * HOUR_H}px;border-top:2px solid #e05a7a;z-index:3;pointer-events:none;`;
        }

        const minAt = (clientY) => {
            const r = grid.getBoundingClientRect();
            return snapMin((clientY - r.top) / HOUR_H * 60);
        };

        // ── 드롭 예측 그림자 ──
        // 드롭은 포인터 위치를 시작 시각으로 삼는데, 사람은 블록 한가운데를 잡으므로
        // 브라우저의 드래그 고스트 윗변과 실제 착지 지점이 잡은 만큼 어긋난다.
        // 계산을 건드리는 대신 착지 지점을 그려서, 고스트가 아니라 이걸 보고 조준하게 한다.
        // 위치·라벨·배지를 모두 아래 startOf() 하나에서 뽑으므로 셋이 어긋날 수 없다.
        const ghost = grid.createEl("div");
        ghost.style.cssText = `position:absolute;left:${GUTTER}px;right:0;display:none;z-index:4;pointer-events:none;box-sizing:border-box;border:1px dashed var(--interactive-accent);border-radius:4px;`;
        // 배경만 반투명하게 깐다. ghost 자체에 opacity 를 주면 라벨까지 흐려져 안 읽힌다
        const ghostBg = ghost.createEl("div");
        ghostBg.style.cssText = "position:absolute;inset:0;background:var(--interactive-accent);opacity:.22;border-radius:3px;";
        const ghostLabel = ghost.createEl("div");
        ghostLabel.style.cssText = "position:absolute;left:5px;top:1px;font-size:11px;font-weight:600;color:var(--text-accent);white-space:nowrap;";
        const badge = grid.createEl("div");
        badge.style.cssText = "position:absolute;left:2px;display:none;z-index:5;pointer-events:none;font-size:10px;font-weight:600;line-height:1.5;padding:0 4px;border-radius:6px;background:var(--interactive-accent);color:var(--text-on-accent);";
        // dropOnTime 과 같은 클램프를 태운다 — 끝자락에서 그림자와 결과가 갈라지지 않게
        const startOf = (clientY) => Math.max(0, Math.min(1440 - SNAP_MIN, minAt(clientY)));
        const hideGhost = () => { ghost.style.display = "none"; badge.style.display = "none"; };
        grid.addEventListener("dragover", (e) => {
            e.preventDefault();
            const t = dragging;
            if (!t || isRO(t)) return;   // 일정은 착지 그림자도 그리지 않는다
            const len = t.tStart !== null ? t.tEnd - t.tStart : DEFAULT_MIN;
            const s = startOf(e.clientY);
            const end = Math.min(1440, s + len);
            const top = s / 60 * HOUR_H;
            ghost.style.top = top + "px";
            ghost.style.height = Math.max(16, (end - s) / 60 * HOUR_H - 2) + "px";
            ghostLabel.textContent = timeText(s, end);
            ghost.style.display = "";
            badge.style.top = top + "px";
            badge.textContent = toHHMM(s);
            badge.style.display = "";
        });
        grid.addEventListener("dragleave", (e) => { if (!grid.contains(e.relatedTarget)) hideGhost(); });
        grid.addEventListener("drop", async (e) => {
            e.preventDefault();
            hideGhost();
            const t = takeDrag();
            if (t) await dropOnTime(t, iso, minAt(e.clientY));
        });
        grid.addEventListener("dragend", hideGhost);

        const placed = layoutTimeLanes(timed);
        for (const { t, lane, lanes, span } of placed) {
            const ro = isRO(t);
            const c = ro ? t.color : (CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT]);
            const dim = t.done || t.cancelled;
            const top = t.tStart / 60 * HOUR_H;
            const h = Math.max(16, (t.tEnd - t.tStart) / 60 * HOUR_H - 2);
            const blk = grid.createEl("div");
            blk.title = ro
                ? `${t.title}\n📆 ${t.calendarName}\n⏰ ${timeText(t.tStart, t.tEnd)}` +
                  (t.recurring ? "\n🔁 반복 일정" : "") +
                  (t.location ? `\n📍 ${t.location}` : "") +
                  "\n(읽기 전용 — Google Calendar 일정)"
                : `${t.title}\n⏰ ${timeText(t.tStart, t.tEnd)}` + (t.recurring ? "\n🔁 반복" : "") + `\n드래그=시각 이동 · 아래끝 드래그=종료 시각 · 종일 줄로 드래그=시각 제거 · 클릭=열기`;
            // 일정은 z-index 1 — 겹치면 task 가 클릭을 가져간다(조작할 수 있는 쪽이 이겨야 한다)
            blk.style.cssText = `position:absolute;left:calc(${GUTTER}px + (100% - ${GUTTER}px) * ${lane / lanes});width:calc((100% - ${GUTTER}px) * ${span / lanes} - 5px);top:${top}px;height:${h}px;z-index:${ro ? 1 : 2};box-sizing:border-box;background:${c}${ro ? "14" : "2b"};border:1px ${ro ? "dashed" : "solid"} ${c};${ro ? "" : `border-left:4px solid ${c};`}border-radius:4px;padding:2px 6px;font-size:11px;line-height:1.3;overflow:hidden;cursor:${ro ? "default" : "grab"};${dim ? "opacity:.55;text-decoration:line-through;" : ""}`;
            blk.appendChild(document.createTextNode(`${toHHMM(t.tStart)} ${ro ? "📆 " : (t.cancelled ? "✗ " : t.done ? "✓ " : "")}${t.recurring ? "🔁 " : ""}${t.title || "(제목 없음)"}`));
            if (ro) continue;   // ↓ 아래는 전부 조작 경로 — 일정에는 리사이즈 레일조차 만들지 않는다
            blk.draggable = true;
            blk.addEventListener("dragstart", (e) => { dragging = t; e.dataTransfer.effectAllowed = "move"; });
            blk.addEventListener("dragend", () => { dragging = null; });
            // 리사이즈로 포인터를 놓으면 click 이 블록까지 버블링돼 원본 파일이 열려버린다
            // (pointerdown 의 stopPropagation 은 click 을 막지 못한다 — 별개 이벤트다).
            let resizing = false;
            blk.addEventListener("click", (e) => { if (resizing) { e.preventDefault(); e.stopPropagation(); return; } openAtLine(t, e); });
            blk.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(t); });

            // 하단 리사이즈 핸들 — 종료 시각만 바꾼다.
            // pointer 이벤트 + setPointerCapture 를 쓴다: mousedown/mousemove 로는 HTML5 드래그가
            // 먼저 시작돼 리사이즈를 가로채고, 포인터가 블록 밖으로 나가면 move 를 놓친다.
            // 잡을 곳이 보이도록 아래쪽에 굵은 선을 그린다(투명하면 있는 줄 모른다).
            const rz = blk.createEl("div");
            rz.title = "드래그해서 종료 시각 조정";
            rz.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:10px;cursor:ns-resize;touch-action:none;border-bottom:3px solid ${c};`;
            rz.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
            rz.addEventListener("pointerdown", (e) => {
                e.preventDefault(); e.stopPropagation();
                blk.draggable = false;             // 리사이즈 중에는 블록 이동 드래그를 끈다
                resizing = true;
                rz.setPointerCapture(e.pointerId);
                const y0 = e.clientY;
                let newEnd = t.tEnd;
                const move = (ev) => {
                    newEnd = Math.min(1440, Math.max(t.tStart + SNAP_MIN, snapMin(t.tEnd + (ev.clientY - y0) / HOUR_H * 60)));
                    blk.style.height = Math.max(16, (newEnd - t.tStart) / 60 * HOUR_H - 2) + "px";
                };
                const up = async () => {
                    rz.removeEventListener("pointermove", move);
                    try { rz.releasePointerCapture(e.pointerId); } catch (_) { }
                    blk.draggable = true;
                    // click 은 pointerup 직후 타이머보다 먼저 오므로, 한 틱 뒤에 푼다
                    setTimeout(() => { resizing = false; }, 0);
                    if (newEnd !== t.tEnd) { await applyDates(t, { time: timeText(t.tStart, newEnd) }); new Notice("⏰ " + timeText(t.tStart, newEnd)); }
                };
                rz.addEventListener("pointermove", move);
                rz.addEventListener("pointerup", up, { once: true });
                rz.addEventListener("pointercancel", up, { once: true });
            });
        }

        // 첫 표시 위치: 사용자가 보던 곳 → 없으면 현재 시각(한 시간 위 여백).
        // 일간 버튼을 누르면 S.dayScroll 이 undefined 로 초기화되므로 누를 때마다 지금 시각으로 돌아온다.
        // 계산한 값은 곧바로 S 에 고정한다. 안 그러면 재렌더마다 스크롤이 다시 계산돼
        // 사용자가 옮겨 둔 위치가 튀어 화면이 새로고침된 것처럼 보인다.
        if (S.dayScroll === undefined) {
            const n = L.now();
            S.dayScroll = Math.max(0, (n.hour * 60 + n.minute) / 60 * HOUR_H - HOUR_H);
        }
    }

    // 이 블록이 살아있는 동안 볼트 데이터는 우리가 쓸 때만 바뀐다
    // (다른 경로로 파일이 바뀜다면 Dataview 가 이 블록을 통째 재실행한다).
    // → 필터 토글·달 이동 같은 UI 재렌더에서 볼트 전체 재순회를 반복하지 않게 수집 결과를 캐시한다.
    let dataCache = null;
    let firstRender = true;   // 이 실행의 첫 렌더인가 (재실행 직전 스크롤 복원은 이때만)
    const invalidate = () => { dataCache = null; };
    const collect = () => (dataCache || (dataCache = gather()));

    // 렌더 요청은 한 틱에 하나로 합친다 (드롭 1회에 여러 경로로 불려도 실제로는 1번만 그림)
    let renderQueued = false;
    // ══════════════════════════ 모바일 화면 ════════════════════════════════════
    // 데스크탑 렌더러와 **화면만** 갈라진다. 수집(collect)·쓰기(applyDates)·편집(editTask)은
    // 위의 것을 그대로 쓴다 — 사본이 갈라지면 ⏰ 삽입 규칙 같은 것이 한쪽에서만 고쳐진다.
    // (이 플러그인이 dataviewjs 스크립트에서 옮겨 온 이유가 바로 그 "사본이 갈라짐" 이다.)
    //
    // 규칙 셋:
    //   · 드래그 없음      — 터치에서 HTML5 DnD 는 이벤트가 아예 발생하지 않는다
    //   · 우클릭 없음      — 모든 수정은 행을 탭해서 여는 액션시트(TaskSheetModal)로
    //   · 중첩 스크롤 없음 — 폰에서 안쪽 스크롤 박스는 노트 스크롤과 싸운다.
    //                       데스크탑 트레이의 max-height:280px, 일간의 560px 박스를 쓰지 않는다.

    const colorOf = (t) => (isRO(t) ? t.color : (CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT] || "#7f8c8d"));
    const fileName = (p) => (p ? p.split("/").pop().replace(/\.md$/, "") : "");
    const metaLine = (t) => {
        const bits = [CATLABEL[t.cat] || t.cat || "-"];
        if (t.path) bits.push("📄 " + fileName(t.path));
        return bits.join("  ·  ");
    };
    const mmdd = (iso) => iso.slice(5).replace("-", ".");
    const dateBadge = (t) => {
        if (t.start && t.due && t.start !== t.due) return "🛫 " + mmdd(t.start) + " ~ 📅 " + mmdd(t.due);
        if (t.due) return "📅 " + mmdd(t.due);
        if (t.start) return "🛫 " + mmdd(t.start);
        return "";
    };

    /** 액션시트를 연다. 쓰기 함수를 그대로 넘긴다 — 모달은 노트를 직접 고치지 않는다. */
    const openSheet = (t) => {
        new TaskSheetModal(app, t, {
            applyDates, dropOnDate, writeBack, editTask, openAtLine,
            isRO, colorOf, metaLine, timeText, toMin, toHHMM, addDays, todayISO,
            notice: (m) => new Notice(m),
        }).open();
    };

    /**
     * 목록의 한 줄. **task 와 GCal 일정을 같은 함수로 그린다** — 지금 모바일에는 일정이
     * 오지 않지만(피드가 데스크탑 전용이다), 나중에 넣을 때 목록 코드를 다시 짜지 않으려고
     * 처음부터 isRO 로 갈라 둔다.
     */
    function mobileRow(item) {
        const ro = isRO(item);
        const el = document.createElement("div");
        // 📆 읽기 전용은 **데스크탑과 같은 서명**으로 그린다 — 점선 테두리 · 옅은 배경 ·
        // **좌측 레일 없음**(굵은 레일은 task 막대의 서명이다). 0.4.0 은 데이터만 연결하고
        // 이 구분을 빠뜨려서, 탭해 보기 전에는 고칠 수 있는 항목인지 알 수 없었다.
        const c = colorOf(item);
        el.style.cssText =
            "display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 10px;margin-bottom:6px;" +
            "border:1px " + (ro ? "dashed " + c : "solid var(--background-modifier-border)") + ";" +
            (ro ? "background:" + c + "14;" : "border-left:4px solid " + c + ";") +
            "border-radius:8px;cursor:pointer;";
        const box = el.createEl("div");
        box.style.cssText = "flex:1 1 auto;min-width:0;";
        const ttl = box.createEl("div", { text: (ro ? "📆 " : "") + (item.title || "(제목 없음)") });
        ttl.style.cssText = "font-size:14px;line-height:1.35;word-break:break-word;" +
            (item.done || item.cancelled ? "opacity:.5;text-decoration:line-through;" : "");
        const sub = box.createEl("div");
        sub.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;font-size:11px;opacity:.6;margin-top:3px;";
        const badge = dateBadge(item);
        if (badge) sub.createEl("span", { text: badge });
        if (item.tStart !== null && item.tStart !== undefined) sub.createEl("span", { text: "⏰ " + timeText(item.tStart, item.tEnd) });
        if (item.recurring) sub.createEl("span", { text: "🔁" });
        if (!ro) sub.createEl("span", { text: "📄 " + fileName(item.path) });
        // 지연은 색으로 말한다 — 목록에서 눈에 띄어야 하는 건 이것 하나다.
        if (item.due && !item.done && !item.cancelled) {
            const od = diffDays(todayISO, item.due);
            if (od > 0) {
                const w = sub.createEl("span", { text: od + "일 지남" });
                w.style.cssText = "color:#eab308;font-weight:700;opacity:1;";
            }
        }
        const chev = el.createEl("span", { text: "›" });
        chev.style.cssText = "opacity:.35;font-size:18px;flex:0 0 auto;";
        el.onclick = () => openSheet(item);
        return el;
    }

    /** 제목 + 행들. 비어 있으면 빈 이유를 한 줄로 말한다 (빈 화면은 고장과 구분되지 않는다). */
    function mobileSection(box, label, items, emptyText) {
        const sec = box.createEl("div");
        sec.style.cssText = "margin-bottom:14px;";
        const h = sec.createEl("div", { text: label });
        h.style.cssText = "font-size:12px;font-weight:600;opacity:.75;margin:0 0 6px;" +
            "padding-bottom:3px;border-bottom:1px solid var(--background-modifier-border);";
        if (!items.length) {
            if (emptyText) {
                const e = sec.createEl("div", { text: emptyText });
                e.style.cssText = "font-size:12px;opacity:.45;padding:2px 0 4px;";
            }
            return sec;
        }
        for (const it of items) sec.appendChild(mobileRow(it));
        return sec;
    }

    /**
     * 월간 요약. 막대가 아니라 **카테고리 색 점**만 찍는다 — 폰 폭에서 7칸을 나누면 한 칸이
     * 50px 라 막대에 글자가 들어가지 않고, 어차피 드래그도 못 한다.
     * 칸을 탭하면 아래 목록이 그 날 카드만 남는다 (다시 탭하면 해제).
     */
    function mobileMonthGrid(box, items) {
        const first = view.startOf("month");
        const gridStart = sundayStart(first);
        const gridEnd = sundayStart(first.endOf("month")).plus({ days: 6 });
        const wrap = box.createEl("div");
        wrap.style.cssText = "margin-bottom:12px;";
        const head = wrap.createEl("div");
        head.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:2px;";
        ["일", "월", "화", "수", "목", "금", "토"].forEach((d, i) => {
            const c = head.createEl("div", { text: d });
            c.style.cssText = "text-align:center;font-size:10px;opacity:.5;" + (i === 0 ? "color:#e05a7a;" : "");
        });
        const grid = wrap.createEl("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);gap:2px;";
        for (let d = gridStart; d <= gridEnd; d = d.plus({ days: 1 })) {
            const iso = d.toISODate();
            const inMonth = d.month === first.month;
            const isToday = iso === todayISO;
            const sel = S.mDay === iso;
            const cell = grid.createEl("div");
            // 테두리 = 고른 날, 굵은 강조색 숫자 = 오늘. 둘을 다른 신호로 나눠야
            // "오늘을 고른 것"과 "오늘이 그냥 오늘인 것"이 구분된다.
            cell.style.cssText =
                "min-height:44px;padding:3px 2px;border-radius:6px;cursor:pointer;text-align:center;" +
                "border:1px solid " + (sel ? "var(--interactive-accent)" : "transparent") + ";" +
                (inMonth ? "" : "opacity:.3;");
            const n = cell.createEl("div", { text: String(d.day) });
            n.style.cssText = "font-size:11px;" + (isToday ? "font-weight:800;color:var(--interactive-accent);" : "");
            const dots = cell.createEl("div");
            dots.style.cssText = "display:flex;justify-content:center;flex-wrap:wrap;gap:2px;margin-top:2px;min-height:6px;";
            const cols = [];
            for (const t of items) {
                if (!coversDay(t, iso)) continue;
                const cc = colorOf(t);
                if (!cols.includes(cc)) cols.push(cc);
            }
            for (const cc of cols.slice(0, 3)) {
                const dot = dots.createEl("span");
                dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:" + cc + ";display:inline-block;";
            }
            if (cols.length > 3) {
                const more = dots.createEl("span", { text: "+" });
                more.style.cssText = "font-size:9px;line-height:6px;opacity:.6;";
            }
            // 칸을 탭하면 **월간 화면을 유지한 채** 그 날 카드만 아래에 남는다.
            // 다시 탭하면 해제. 시간축으로 보려면 헤더의 「일간」·「오늘」을 쓴다.
            cell.onclick = () => { S.mDay = sel ? undefined : iso; render(); };
        }
        return wrap;
    }

    // ── 일간 타임라인 ──────────────────────────────────────────────────────
    // 데스크탑 일간 보기와 같은 그림이지만 **보기 전용**이다. 데스크탑은 드래그로 시각을
    // 주고 옮기는데 터치에서는 그게 안 되고, 빈 곳 탭을 쓰기 동작으로 삼으면 스크롤하려다
    // 스친 탭에 시각이 붙는다 — 되돌릴 방법이 없다. 시각은 항목을 탭해 여는 액션시트의
    // 「시작 시각 + 길이 버튼」으로 준다.
    // 겹침 레인은 layoutTimeLanes 로 데스크탑과 같은 배치를 쓴다.
    const M_HOUR_H = 48;   // 모바일 1시간 높이(px). 15분 = 12px — 손가락으로 15분이 구분된다
    const M_GUTTER = 44;   // 시각 라벨이 차지하는 왼쪽 폭(px)
    const WD = ["일", "월", "화", "수", "목", "금", "토"];

    /**
     * 📥 날짜 없음 · 🔴 지연 트레이. **데스크탑과 같이 화면 맨 위**에 둔다.
     *
     * 둘 다 **오늘 기준**이라 보고 있는 달·고른 날짜와 무관하게 늘 같은 목록이다 —
     * 그래서 위치도 고정이다. 「처리 안 된 게 있다」를 알려 주는 면이라 안 보이면
     * 그대로 묻힌다(0.6.0 이 오늘을 자동 선택하면서 이 둘이 화면에서 사라졌다).
     *
     * 카드마다 **안쪽 스크롤**을 둔다(데스크탑 280px → 폰 200px). 지연이 수십 건이어도
     * 달력까지 한참 스크롤하지 않게. 행은 `mobileRow` 라 **탭하면 액션시트**가 열린다.
     */
    function mobileTrays(box, open) {
        const card = (title, items, empty, accent) => {
            const wrap = box.createEl("div");
            wrap.style.cssText = "border:1px " + (accent ? "solid" : "dashed") +
                " var(--background-modifier-border);" +
                (accent ? "border-left:3px solid " + accent + ";" : "") +
                "border-radius:8px;padding:8px;margin-bottom:8px;";
            const h = wrap.createEl("div", { text: title });
            h.style.cssText = "font-size:12px;font-weight:600;opacity:.8;margin-bottom:6px;" +
                (accent ? "color:" + accent + ";" : "");
            if (!items.length) {
                const e = wrap.createEl("div", { text: empty });
                e.style.cssText = "font-size:12px;opacity:.45;";
                return;
            }
            const body = wrap.createEl("div");
            body.style.cssText = "max-height:200px;overflow:auto;";
            for (const it of items) body.appendChild(mobileRow(it));
        };
        // 기준은 **📅 하나뿐**이다(데스크탑 트레이와 같다). 🛫 만 있고 📅 가 없는 줄을
        // 여기서 빼면 그 task 는 어디에도 안 나타난다 — 막대·일간·날짜별 섹션이 전부
        // `t.due` 를 요구하므로, 남는 건 월간 그리드의 점 하나뿐이라 그 날짜 칸을 정확히
        // 탭해야만 닿는다.
        card("📥 날짜 없음 (" + open.filter((t) => !t.due).length + ")",
            open.filter((t) => !t.due), "없음 🎉", "");
        const overdue = open
            .filter((t) => t.due && t.due < todayISO)
            .sort((a, b) => (a.due < b.due ? -1 : 1));
        card("🔴 지연 (" + overdue.length + ")", overdue, "없음 🎉", "#e05a7a");
    }

    function renderMobileDay(box, items) {
        const iso = view.toISODate();
        // 데스크탑 renderDay 와 같은 기준: 이 날에 걸친 것(기간의 어느 하루라도 이 날이면)
        const today = items.filter((t) => onDay(t, iso));
        const timed = today.filter((t) => t.tStart !== null);
        // 종일 줄 안에서도 📆 일정이 먼저 — 데스크탑 renderDay 와 같은 규칙
        const allday = today.filter((t) => t.tStart === null).sort(byDayOrder);

        // ── 종일 줄 ──
        const ad = box.createEl("div");
        ad.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;min-height:44px;" +
            "border:1px solid var(--background-modifier-border);border-radius:8px 8px 0 0;";
        const adLabel = ad.createEl("span", { text: "종일 (" + allday.length + ")" });
        adLabel.style.cssText = "font-size:11px;opacity:.55;flex:0 0 auto;";
        if (!allday.length) {
            const e = ad.createEl("span", { text: "없음" });
            e.style.cssText = "font-size:11px;opacity:.35;";
        }
        for (const t of allday) {
            const chip = ad.createEl("div");
            const c = colorOf(t);
            const dim = t.done || t.cancelled;
            // 시간 그리드 블록과 같은 규칙(아래) — 종일 칩만 실선이면 같은 일정이 종일이냐
            // 시간지정이냐에 따라 다르게 보인다.
            const ro = isRO(t);
            chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;font-size:12px;" +
                "border-radius:8px;cursor:pointer;max-width:100%;" +
                "background:" + c + (ro ? "14" : "2b") + ";" +
                "border:1px " + (ro ? "dashed" : "solid") + " " + c + ";" +
                (ro ? "" : "border-left:4px solid " + c + ";") +
                (dim ? "opacity:.55;text-decoration:line-through;" : "");
            const lbl = chip.createEl("span", { text: (ro ? "📆 " : "") + (t.title || "(제목 없음)") });
            lbl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            chip.onclick = (e) => { e.stopPropagation(); openSheet(t); };
        }

        // ── 시간 그리드 ──
        // **안쪽 스크롤 박스를 만들지 않는다.** 폰에서 중첩 스크롤은 노트 스크롤과 싸운다.
        // 대신 그릴 시간대를 좁힌다 — 기본 08~20시, 항목이나 현재 시각이 벗어나면 그만큼 넓힌다.
        const fullDay = !!S.mFull;
        const [h0, h1] = mobileHourRange(timed, { fullDay, nowHour: iso === todayISO ? L.now().hour : null });

        const grid = box.createEl("div");
        grid.style.cssText = "position:relative;height:" + (h1 - h0) * M_HOUR_H + "px;" +
            "border:1px solid var(--background-modifier-border);border-top:0;border-radius:0 0 8px 8px;overflow:hidden;";
        for (let h = h0; h < h1; h++) {
            const row = grid.createEl("div");
            row.style.cssText = "position:absolute;left:0;right:0;top:" + (h - h0) * M_HOUR_H + "px;height:" + M_HOUR_H + "px;" +
                "border-top:1px solid var(--background-modifier-border);";
            const lab = row.createEl("span", { text: String(h).padStart(2, "0") + ":00" });
            lab.style.cssText = "position:absolute;left:5px;top:1px;font-size:10px;opacity:.45;";
            const half = row.createEl("div");
            half.style.cssText = "position:absolute;left:" + M_GUTTER + "px;right:0;top:" + M_HOUR_H / 2 + "px;" +
                "border-top:1px dashed var(--background-modifier-border);opacity:.5;";
        }
        if (iso === todayISO) {
            const now = L.now();
            const m = now.hour * 60 + now.minute;
            if (m >= h0 * 60 && m <= h1 * 60) {
                const nl = grid.createEl("div");
                nl.style.cssText = "position:absolute;left:" + M_GUTTER + "px;right:0;top:" +
                    ((m - h0 * 60) / 60 * M_HOUR_H) + "px;border-top:2px solid #e05a7a;z-index:3;pointer-events:none;";
            }
        }

        // 타임라인은 **보기 전용**이다. 빈 시간대 탭에 아무것도 걸지 않는다 —
        // 스크롤하려다 스친 탭으로 시각이 붙으면 되돌릴 방법이 없다.
        // 시각은 액션시트의 「시작 시각 + 길이 버튼」으로 준다.

        for (const { t, lane, lanes, span } of layoutTimeLanes(timed)) {
            const ro = isRO(t);
            const c = colorOf(t);
            const dim = t.done || t.cancelled;
            const top = (t.tStart - h0 * 60) / 60 * M_HOUR_H;
            const h = Math.max(20, (t.tEnd - t.tStart) / 60 * M_HOUR_H - 2);
            const blk = grid.createEl("div");
            blk.style.cssText =
                "position:absolute;left:calc(" + M_GUTTER + "px + (100% - " + M_GUTTER + "px) * " + lane / lanes + ");" +
                "width:calc((100% - " + M_GUTTER + "px) * " + span / lanes + " - 5px);" +
                "top:" + top + "px;height:" + h + "px;z-index:" + (ro ? 1 : 2) + ";box-sizing:border-box;" +
                "background:" + c + (ro ? "14" : "2b") + ";border:1px " + (ro ? "dashed" : "solid") + " " + c + ";" +
                (ro ? "" : "border-left:4px solid " + c + ";") +
                "border-radius:6px;padding:2px 6px;font-size:11px;line-height:1.3;overflow:hidden;cursor:pointer;" +
                (dim ? "opacity:.55;text-decoration:line-through;" : "");
            blk.appendChild(document.createTextNode(
                timeText(t.tStart, t.tEnd) + " " + (ro ? "📆 " : (t.cancelled ? "✗ " : t.done ? "✓ " : "")) +
                (t.recurring ? "🔁 " : "") + (t.title || "(제목 없음)")
            ));
            // 블록 탭은 그리드까지 내려가면 안 된다 — 배치 중이라면 제 위에 자기를 놓게 된다.
            blk.onclick = (e) => { e.stopPropagation(); openSheet(t); };
        }

        // ── 그리드 아래 ──
        const foot = box.createEl("div");
        foot.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;";
        const fullBtn = foot.createEl("button", { text: S.mFull ? "표시 시간 줄이기" : "0~24시 전부 보기" });
        fullBtn.style.cssText = "min-height:32px;font-size:12px;padding:0 12px;border-radius:8px;cursor:pointer;";
        fullBtn.onclick = () => { S.mFull = !S.mFull; render(); };
        if (!fullDay && (h0 > 0 || h1 < 24)) {
            const note = foot.createEl("span", { text: String(h0).padStart(2, "0") + ":00~" + String(h1).padStart(2, "0") + ":00 만 표시 중" });
            note.style.cssText = "font-size:11px;opacity:.45;";
        }
    }

    function renderMobileNow() {
        syncCategories();
        saveState();
        const first = firstRender;
        firstRender = false;
        // 분리된 DOM 에 조립한 뒤 한 번에 교체 — 데스크탑 경로와 같은 이유(빈 프레임 방지).
        const box = document.createElement("div");
        const noteMd = noteMarkdown();
        if (noteMd) box.appendChild(noteBlock(noteMd));

        const all = collect().filter((t) => activeCats.has(t.cat));
        const open = all.filter((t) => !t.done && !t.cancelled);
        const shown = showDone ? all : open;

        // ── 트레이를 **맨 위에, 모드와 무관하게** — 데스크탑 세로 순서와 같다.
        //
        // 📥 날짜 없음·🔴 지연은 **오늘 기준**이라 달력이 무엇을 보여주든 같은 목록이다.
        // 월간에만 두면 "일간에서는 왜 안 보이지" 가 되고, 실제로 0.6.0 까지 일간에는
        // 한 줄 힌트(「월간에서 볼 수 있습니다」)만 있었다 — **볼 수 있는 곳으로 가라는
        // 안내는 그 자리에 두는 것보다 나을 게 없다.**
        mobileTrays(box, open);

        // ── 📆 GCal 일정 (읽기 전용, 0.4.0~) ──
        //
        // 0.3.0 의 모바일 화면은 **"폰엔 일정이 없다"를 전제로** 만들어졌다 —
        // 받아오는 tasks-gcal-sync 가 `isDesktopOnly` 였기 때문이다. 그 전제가 sync
        // 0.10.0(모바일 읽기 전용)에서 깨졌으므로 여기도 데이터를 받는다.
        //
        // 그리는 쪽은 이미 준비돼 있었다 — `mobileRow`·`renderMobileDay`·`colorOf`·
        // `TaskSheetModal` 이 전부 `isRO()` 를 본다. **데이터만 안 가고 있었다.**
        const [rangeFrom, rangeTo] = rangeForView();
        const evItems = eventsFor(rangeFrom, rangeTo);
        // ⚠️ **일정은 달력 쪽에만 합류하고 트레이에는 안 간다**(데스크탑과 같은 규칙).
        //    `📥 날짜 없음`·`🔴 지연` 은 아래에서 `open`(task 전용)으로만 만든다 —
        //    안 그러면 지난 회의 수백 건이 🔴 지연을 덮는다.
        const calItems = shown.concat(evItems);

        // 모드는 데스크탑과 같은 지역 변수를 쓴다(한 세션 안에서는 보던 단위가 유지된다).
        // 다만 모바일에는 주간이 없다 — 폰 폭에서 7칸 막대는 글자가 안 들어간다.
        const dayMode = mode === "day";
        // 고른 날은 **보고 있는 달 안에 있을 때만** 유효하다. ◀▶ 로 달을 넘기면
        // 그리드에 없는 날의 카드만 떠 있는 상태가 되므로 그때는 없는 것으로 친다.
        const selDay = !dayMode && S.mDay && S.mDay.slice(0, 7) === view.toFormat("yyyy-MM") ? S.mDay : null;

        // ── 헤더: 이동 · 오늘 · 월간/일간 · 완료 토글 ──
        const bar = box.createEl("div");
        bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;";
        const navBtn = (label, fn, extra) => {
            const b = bar.createEl("button", { text: label });
            b.style.cssText = "min-height:36px;padding:0 12px;border-radius:8px;font-size:13px;cursor:pointer;" + (extra || "");
            b.onclick = fn;
            return b;
        };
        navBtn("◀", () => {
            view = dayMode ? view.minus({ days: 1 }) : view.startOf("month").minus({ months: 1 });
            render();
        });
        const lab = bar.createEl("b", {
            text: dayMode ? view.toFormat("M월 d일") + " (" + WD[view.weekday % 7] + ")" : view.toFormat("yyyy년 M월"),
        });
        lab.style.cssText = "font-size:15px;flex:1 1 auto;text-align:center;";
        navBtn("▶", () => {
            view = dayMode ? view.plus({ days: 1 }) : view.startOf("month").plus({ months: 1 });
            render();
        });
        // 「오늘로」는 한 곳에 모은다 — 「오늘」 버튼과 보기 전환 버튼이 같은 자리로 간다.
        // 월간은 이번 달을 열면서 **오늘을 고른 상태**로 둬서 아래 목록이 곧바로 오늘
        // 카드가 된다. 달만 맞추면 그리드에서 오늘을 한 번 더 찾아 탭해야 하고,
        // 그 사이에 이 달 전체 목록이 한 번 펼쳐진다.
        const goToday = (m) => {
            if (m === "day") {
                view = L.now().startOf("day");
            } else {
                view = L.now().startOf("month");
                S.mDay = todayISO;
            }
            mode = m;
            render();
        };

        // 「오늘」은 **보고 있는 쪽을 그대로 두고** 오늘로만 돌아온다.
        navBtn("오늘", () => goToday(mode === "day" ? "day" : "month"));

        // 보기 전환도 오늘 기준으로 연다. 이미 그 보기에 있어도 되돌린다(early return 없음) —
        // 예전 「오늘」 버튼이 이미 이번 달일 때 아무것도 안 해서 반응이 없던 것과 같은 함정이다.
        for (const [m, text] of [["month", "월간"], ["day", "일간"]]) {
            navBtn(text, () => goToday(m),
                mode === m ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;");
        }
        navBtn(showDone ? "완료 ✓" : "완료 ✗", () => { showDone = !showDone; render(); });
        if (selDay) navBtn("선택 해제", () => { S.mDay = undefined; render(); });

        // ── 카테고리 필터 ── 데스크탑과 같은 규칙, 손가락 크기로만 키운다.
        const filterBar = box.createEl("div");
        filterBar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px;";
        const allOn = CATS.length > 0 && CATS.every((c) => activeCats.has(c));
        const allBtn = filterBar.createEl("button", { text: allOn ? "전체 해제" : "전체" });
        allBtn.style.cssText = "min-height:32px;font-size:12px;padding:0 12px;border-radius:16px;cursor:pointer;";
        allBtn.onclick = () => { if (allOn) activeCats.clear(); else CATS.forEach((c) => activeCats.add(c)); render(); };
        for (const cat of CATS) {
            const on = activeCats.has(cat);
            const b = filterBar.createEl("button");
            b.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:12px;" +
                "padding:0 12px;border-radius:16px;cursor:pointer;border:1px solid var(--background-modifier-border);" +
                "opacity:" + (on ? 1 : 0.4) + ";";
            const dot = b.createEl("span");
            dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:" + CATCOLOR[cat] + ";display:inline-block;";
            b.createEl("span", { text: CATLABEL[cat] });
            b.onclick = () => { if (activeCats.has(cat)) activeCats.delete(cat); else activeCats.add(cat); render(); };
        }

        // ── 📆 일정 칩 ── 데스크탑과 같은 규칙: 카테고리 필터에 섞지 않는다(「전체 해제」는
        //    task 만 끈다). 피드가 없으면 **칩 자체를 안 그린다** — 죽은 칩은 노이즈다.
        const evFeedM = CALF.off ? null : feed();
        if (!evFeedM && !CALF.off && feedPlugin()) {
            // 플러그인은 있는데 준비가 안 됐다(인증 전 · 고른 캘린더 0개) → **왜 안 보이는지 말한다.**
            // 폰에서는 설정까지 가는 길이 멀어서 이 안내가 데스크탑보다 더 중요하다.
            const hintM = filterBar.createEl("button", { text: "📅 일정 — 설정 필요" });
            hintM.style.cssText = "min-height:32px;font-size:12px;padding:0 12px;border-radius:16px;cursor:pointer;" +
                "border:1px dashed var(--background-modifier-border);opacity:.55;";
            hintM.onclick = () => {
                try { app.setting.open(); app.setting.openTabById("tasks-gcal-sync"); }
                catch (e) { new Notice("설정 → 커뮤니티 플러그인 → Tasks GCal Sync 에서 인증·캘린더를 설정하세요"); }
            };
        }
        if (evFeedM) {
            const eb = filterBar.createEl("button");
            eb.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:12px;" +
                "padding:0 12px;border-radius:16px;cursor:pointer;border:1px dashed var(--background-modifier-border);" +
                "opacity:" + (showEvents ? 1 : 0.4) + ";";
            // ⚠️ 꺼져 있으면 `eventsFor` 가 []를 돌려준다 — 그때 건수를 적으면 "0건" 으로
            //    오해된다. 켜져 있을 때만 숫자를 붙인다.
            eb.createEl("span", {
                text: showEvents ? "📅 일정 " + evItems.length : "📅 일정",
            });
            eb.onclick = () => { showEvents = !showEvents; render(); };
        }

        // ── 본문 ──
        if (dayMode) {
            renderMobileDay(box, calItems);
        } else if (selDay) {
            // 월간 레이아웃(그리드)은 그대로 두고 아래만 그 날 카드로 바꾼다.
            // 아래에 기존 목록까지 이어 붙이면 같은 task 가 두 번 보인다(📌 와 날짜별 섹션).
            // 정렬은 손대지 않는다 — 평소 목록과 같은 순서여야 눈이 헤매지 않는다.
            mobileMonthGrid(box, calItems);
            const day = calItems.filter((t) => coversDay(t, selDay)).sort(byDayOrder);
            const wd = WD[L.fromISO(selDay).weekday % 7];
            mobileSection(box, "📌 " + selDay + " (" + wd + ") — " + day.length + "건", day,
                "이 날에 걸친 항목이 없습니다.");
        } else {
            mobileMonthGrid(box, calItems);

            // 이 달의 날짜별 — **지연 항목을 빼지 않는다.**
            //
            // 예전에는 위 지연 목록에 나온 것을 뺐다(*"평평한 목록에서 같은 게 두 번
            // 보이면 그냥 버그로 보인다"*). 그때는 트레이가 이 목록과 같은 흐름에
            // 섞여 있었기 때문이다. 이제 트레이는 **맨 위의 별도 카드**라 데스크탑과
            // 같은 관계가 된다 — 트레이는 *"오늘 기준으로 밀린 것"*, 이 목록은
            // *"이 달의 달력"* 이고, 데스크탑도 둘 다 그린다. 같은 일이 두 면에 나오는
            // 것은 중복이 아니라 **다른 질문에 대한 답**이다.
            const ym = view.toFormat("yyyy-MM");
            const byDay = new Map();
            for (const t of calItems) {
                if (!t.due) continue;
                if (t.due.slice(0, 7) !== ym) continue;
                if (!byDay.has(t.due)) byDay.set(t.due, []);
                byDay.get(t.due).push(t);
            }
            // 날짜별 목록도 같은 규칙으로 — 섹션을 열었을 때 회의가 맨 위에 온다.
            for (const list of byDay.values()) list.sort(byDayOrder);
            const days = [...byDay.keys()].sort();
            if (!days.length) {
                mobileSection(box, view.toFormat("yyyy년 M월"), [], "이 달에 마감일이 있는 항목이 없습니다.");
            } else {
                for (const iso of days) {
                    const wd = ["일", "월", "화", "수", "목", "금", "토"][L.fromISO(iso).weekday % 7];
                    const mark = iso === todayISO ? "  ← 오늘" : "";
                    mobileSection(box, mmdd(iso) + " (" + wd + ")" + mark, byDay.get(iso));
                }
            }
        }

        // ── 조립 끝 ──
        root.replaceChildren(...box.childNodes);
        const h = root.offsetHeight;
        if (h > 0) { S.h = h; HOLD.style.minHeight = h + "px"; }
        if (first) restorePageScroll();
    }

    function render() {
        if (renderQueued) return;
        renderQueued = true;
        setTimeout(() => { renderQueued = false; renderNow(); }, 0);
    }

    // 일간 보기 시간 그리드의 스크롤 컨테이너. 복원은 renderNow 의 restoreScroll 이 맡는다
    // (거기서 동기 + rAF 두 번 시도한다 — 한 번만 하면 아직 레이아웃 전이라 대입이 0으로 잘린다).
    let dayBox = null;
    let dayScrollRestoring = false;   // 복원 중 발생하는 scroll 이벤트가 저장값을 덮지 않게

    function renderNow() {
        // 화면만 갈라진다. 아래 데스크탑 경로는 조작이 전부 HTML5 드래그와 우클릭이라
        // 터치에서는 열기 말고 아무것도 못 한다 — 폰에서는 통째로 다른 화면을 그린다.
        if (isMobileUi()) return renderMobileNow();
        syncCategories();   // 설정이 바뀌었을 수 있다 (플러그인 재시작 없이 반영하려면 매번 읽어야 한다)
        saveState();
        const first = firstRender;
        firstRender = false;
        dayBox = null;   // 이번 렌더에서 일간 보기를 그리면 renderDay 가 다시 채운다
        // 분리된 DOM 에 먼저 조립한 뒤 한 번에 교체 → 화면이 비는 프레임이 없다
        const box = document.createElement("div");
        const noteMd = noteMarkdown();
        if (noteMd) box.appendChild(noteBlock(noteMd));
        const all = collect().filter(t => activeCats.has(t.cat));
        const tasks = all.filter(t => !t.done && !t.cancelled);   // 트레이/현황 = 미완료(취소[-] 제외)
        // GCal 일정은 **달력에만** 합류한다. 트레이(날짜 없음·지연)는 tasks 에서 나오므로
        // 지난 회의가 🔴 지연을 덮는 일이 구조적으로 없고, 「완료」 토글도 일정에 닿지 않는다.
        const [rangeFrom, rangeTo] = rangeForView();
        const evItems = eventsFor(rangeFrom, rangeTo);
        const calTasks = (showDone ? all : tasks).concat(evItems);   // 달력 = 토글에 따라 완료·취소 포함

        // ── 날짜 없음 트레이 ──
        const undated = tasks.filter(t => !t.due);
        const tray = box.createEl("div");
        tray.style.cssText = "border:1px dashed var(--background-modifier-border);border-radius:4px;padding:4px;margin-bottom:8px;";
        tray.createEl("div", { text: `📥 날짜 없음 (${undated.length}) — 달력으로 드래그해 날짜 지정` }).style.cssText = "font-size:11px;opacity:0.7;margin-bottom:2px;";
        const trayBody = tray.createEl("div");
        trayBody.style.cssText = "max-height:280px;overflow:auto;";
        trayBody.addEventListener("scroll", () => { S.trayScroll = trayBody.scrollTop; });
        renderGrouped(trayBody, undated);

        // ── 지연(Overdue) 트레이 ── (취소 [-] 제외)
        const overdue = tasks.filter(t => t.due && t.due < todayISO).sort((a, b) => a.due < b.due ? -1 : 1);
        const otray = box.createEl("div");
        otray.style.cssText = "border:1px solid var(--background-modifier-border);border-left:3px solid #e05a7a;border-radius:4px;padding:4px;margin-bottom:8px;";
        otray.createEl("div", { text: `🔴 지연 Overdue (${overdue.length}) — 드래그해서 다시 예약` }).style.cssText = "font-size:11px;opacity:0.85;margin-bottom:2px;color:#e05a7a;font-weight:600;";
        const obody = otray.createEl("div");
        obody.style.cssText = "max-height:280px;overflow:auto;";
        obody.addEventListener("scroll", () => { S.overdueScroll = obody.scrollTop; });
        renderGrouped(obody, overdue);

        // ── 툴바: 네비 + 뷰 전환 ── (트레이 아래, 달력 바로 위)
        // 이 줄은 아래 달력을 조작하는 손잡이다. 트레이 위에 두면 조작 대상과 멀어져서,
        // 트레이가 길어질수록 "이 버튼이 뭘 바꾸는지" 가 화면에서 끊긴다.
        const bar = box.createEl("div");
        bar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
        const prev = bar.createEl("button", { text: "◀" });
        const label = bar.createEl("b");
        label.style.minWidth = "150px";
        label.setText(
            mode === "month" ? view.toFormat("yyyy년 M월")
                : mode === "day" ? view.toFormat("yyyy.MM.dd") + " (" + ["일", "월", "화", "수", "목", "금", "토"][view.weekday % 7] + ")"
                    : view.toFormat("yyyy.MM.dd") + " ~ " + view.plus({ days: 6 }).toFormat("MM.dd"));
        const next = bar.createEl("button", { text: "▶" });
        const todayBtn = bar.createEl("button", { text: "오늘" });
        // 보기 전환은 세 개의 명시적 버튼으로. (순환 버튼이면 월간에서 일간까지 두 번 눌러야 해서
        //  "일간 보기가 없다"고 느껴진다 — 현재 보기가 어디인지도 드러나지 않는다.)
        for (const [m, lab] of [["month", "월간"], ["week", "주간"], ["day", "일간"]]) {
            const b = bar.createEl("button", { text: lab });
            if (m === "day") b.title = "일간 보기 — 누르면 현재 시각으로 맞춘다";
            b.style.cssText = `font-size:11px;padding:2px 9px;border-radius:10px;cursor:pointer;${m === mode ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;"}`;
            b.onclick = () => {
                // 이미 일간이면 다시 눌러 "지금 시각으로 되돌리기" 로 쓴다
                if (m === mode) { if (m === "day") { S.dayScroll = undefined; render(); } return; }
                mode = m;
                // 주간·일간은 항상 "오늘" 기준으로 연다 (보던 달의 1일 기준이면 대개 지난 주가 열린다)
                view = m === "month" ? view.startOf("month") : m === "week" ? sundayStart(L.now()) : L.now().startOf("day");
                if (m === "day") S.dayScroll = undefined;
                render();
            };
        }
        const doneBtn = bar.createEl("button", { text: showDone ? "완료 ✓" : "완료 ✗" });
        doneBtn.title = "달력에 완료·취소 항목 표시/숨김";
        doneBtn.onclick = () => { showDone = !showDone; render(); };
        const step = (n) => (mode === "month" ? view.plus({ months: n }) : mode === "day" ? view.plus({ days: n }) : view.plus({ weeks: n }));
        prev.onclick = () => { view = step(-1); render(); };
        next.onclick = () => { view = step(1); render(); };
        todayBtn.onclick = () => {
            view = mode === "month" ? L.now().startOf("month") : mode === "day" ? L.now().startOf("day") : sundayStart(L.now());
            if (mode === "day") S.dayScroll = undefined;   // "오늘" 은 지금 시각까지 데려다 준다
            render();
        };

        // ── 카테고리 필터 토글 ──
        const filterBar = box.createEl("div");
        filterBar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;";
        // 한 카테고리만 보려고 나머지를 하나씩 끄는 게 번거로워 전체 버튼을 토글로 둔다.
        // 다 켜져 있으면 "전체 해제" → 한 번 비우고 볼 것만 켠다. 아니면 "전체" → 다 켠다.
        // 버튼 글자가 곧 눌렀을 때 일어날 일이다(현재 상태 표시가 아니다).
        const allOn = CATS.length > 0 && CATS.every(c => activeCats.has(c));
        const allBtn = filterBar.createEl("button", { text: allOn ? "전체 해제" : "전체" });
        allBtn.title = allOn ? "카테고리를 모두 끈다 — 볼 것만 다시 켜면 된다" : "카테고리를 모두 켠다";
        allBtn.style.cssText = "font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;";
        allBtn.onclick = () => { if (allOn) activeCats.clear(); else CATS.forEach(c => activeCats.add(c)); render(); };
        for (const cat of CATS) {
            const on = activeCats.has(cat);
            const b = filterBar.createEl("button");
            b.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;border:1px solid var(--background-modifier-border);opacity:${on ? 1 : 0.4};`;
            const dot = b.createEl("span");
            dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${CATCOLOR[cat]};display:inline-block;`;
            b.createEl("span", { text: CATLABEL[cat] });
            b.onclick = () => { if (activeCats.has(cat)) activeCats.delete(cat); else activeCats.add(cat); render(); };
        }

        // ── GCal 일정 토글 ──
        // 카테고리 필터(activeCats)에 섞지 않는다. syncCategories() 가 CATS 에 없는 키를
        // 지우므로 knownCats 재조정과 싸우고, 「전체 / 전체 해제」의 의미도 모호해진다.
        // 그래서 구분선 오른쪽에 별도 칩으로 둔다 — 「전체 해제」는 task 만 끈다.
        // 피드가 없으면(모바일·미설치·인증 전) 아예 그리지 않는다. 죽은 칩은 노이즈다.
        const evFeed = CALF.off ? null : feed();
        // 플러그인은 있는데 준비가 안 됐으면(인증 전 · 고른 캘린더 0개) **왜 안 보이는지 말한다.**
        // 아무 말 없이 비어 있으면 "기능이 없는 건지 고장난 건지" 를 구분할 수가 없다.
        // 모바일·미설치는 여기 안 걸린다(feedPlugin 이 null) — 죽은 칩을 그리지 않는다.
        if (!evFeed && !CALF.off && feedPlugin()) {
            const div0 = filterBar.createEl("span");
            div0.style.cssText = "width:1px;height:14px;background:var(--background-modifier-border);margin:0 2px;";
            const hint = filterBar.createEl("button", { text: "📅 일정 — 설정 필요" });
            hint.style.cssText = "font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;border:1px dashed var(--background-modifier-border);opacity:.55;";
            hint.title = "Google Calendar 일정을 그리려면\n① Google 인증  ② 「캘린더 뷰에 표시할 일정」에서 캘린더 선택\n설정 → 커뮤니티 플러그인 → Tasks GCal Sync (눌러서 열기)";
            hint.onclick = () => {
                try {
                    app.setting.open();
                    app.setting.openTabById("tasks-gcal-sync");
                } catch (e) {
                    new Notice("설정 → 커뮤니티 플러그인 → Tasks GCal Sync 에서 캘린더를 고르세요");
                }
            };
        }
        if (evFeed) {
            const div = filterBar.createEl("span");
            div.style.cssText = "width:1px;height:14px;background:var(--background-modifier-border);margin:0 2px;";
            const eb = filterBar.createEl("button");
            eb.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;border:1px dashed var(--background-modifier-border);opacity:${showEvents ? 1 : 0.4};`;
            eb.createEl("span", { text: "📅 일정" });
            // 설정에서 고른 캘린더 중 **이 블록이 실제로 그리는 것**만 보여준다.
            // 블록의 calendars:/exclude-calendars: 를 그대로 태워 본다.
            const sel = (() => {
                try { return evFeed.listSelectedCalendars(); } catch (e) { return []; }
            })();
            const shown = sel.filter((c) => passesCalFilter({ calendarName: c.name, calendarId: c.id }));
            // 블록에 적었지만 설정에서 안 고른 이름 — 이걸 안 알려주면 오타가 "그냥 안 나옴" 이 된다
            const known = new Set(sel.flatMap((c) => [calKey(c.name), calKey(c.id)]));
            const unknown = [...CALF.include, ...CALF.exclude].filter((n) => !known.has(n));
            eb.title = "Google Calendar 일정 표시 (읽기 전용)" +
                (shown.length ? "\n" + shown.map((c) => c.name).join(", ") : "") +
                (CALF.include.length || CALF.exclude.length ? "\n(이 블록의 gcal / gcal-exclude 적용됨)" : "") +
                (unknown.length ? `\n⚠️ 설정에 없는 이름: ${unknown.join(", ")}` : "") +
                `\n이 기간에 ${evItems.length}건` +
                "\n「완료」 토글과 카테고리 필터는 task 에만 적용됩니다";
            eb.onclick = () => { showEvents = !showEvents; render(); };
        }

        // ── 달력 (기간 막대) ──
        if (mode === "month") renderMonth(box, calTasks);
        else if (mode === "day") renderDay(box, calTasks);
        else renderWeek(box, calTasks);

        // ── 조립 끝 → 한 번에 교체하고 스크롤 위치 복원 ──
        root.replaceChildren(...box.childNodes);
        const restoreScroll = () => {
            trayBody.scrollTop = S.trayScroll || 0;
            obody.scrollTop = S.overdueScroll || 0;
            // 일간 보기 시간 그리드도 같은 타이밍에 복원한다(동기 1회 + 다음 프레임 1회).
            if (dayBox && dayBox.isConnected) {
                dayScrollRestoring = true;
                dayBox.scrollTop = S.dayScroll || 0;
                dayScrollRestoring = false;
            }
            // 통째 재실행이 일어날 경우를 대비해 높이를 컨테이너에 예약해둔다.
            // root 에는 minHeight 를 걸지 않으므로 여기서 재는 값은 항상 실제 내용 높이다
            // (예약값이 다음 측정에 누적돼 높이가 계속 커지는 일이 없다).
            const h = root.offsetHeight;
            if (h > 0) { S.h = h; HOLD.style.minHeight = h + "px"; }
            if (first) restorePageScroll();
        };
        restoreScroll();
        requestAnimationFrame(restoreScroll);   // 컨테이너가 아직 문서에 안 붙었으면 다음 프레임에 다시
    }

    renderNow();   // 첫 페인트는 동기로 — setTimeout 으로 미루면 그만큼 빈 칸으로 남는다
    // 호출부(코드블록 프로세서)가 Dataview 인덱스 변경에 물려 쓴다.
    return { refresh: () => { invalidate(); renderNow(); }, isAlive: () => root.isConnected };
}
