'use strict';
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
const { Plugin, PluginSettingTab, Setting, Notice, Keymap, MarkdownRenderChild, MarkdownRenderer } = require("obsidian");

const DEFAULT_SETTINGS = {
    // 기본값은 개인 볼트 기준. 업무 볼트처럼 카테고리가 하나면 설정에서 지우면 된다.
    categories: [
        { key: "work", label: "Work", color: "#3f51b5" },
        { key: "growth", label: "Growth", color: "#0b8043" },
        { key: "routine", label: "Routine", color: "#9e69af" },
        { key: "personal", label: "Personal", color: "#e67c73" },
        { key: "hobby", label: "Hobby", color: "#e4c441" },
        { key: "event", label: "Event", color: "#a2845e" },
        { key: "non-core", label: "Non-core", color: "#a79b8e" },
    ],
    defaultCategory: "personal",
};

/**
 * 코드블록 본문 파싱: `scope: vault` · `source: <쿼리>` · `note: <설명>`
 * (빈 블록이면 폴더 스코프)
 *
 * `note` 만 여러 줄을 허용해 배열로 모은다 — 설명이 길면 줄을 나눠 쓰는 게 자연스럽다.
 */
function parseOptions(src) {
    const o = { note: [] };
    for (const raw of (src || "").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf(":");
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const val = line.slice(i + 1).trim();
        if (key === "note") {
            if (val) o.note.push(val);
        } else {
            o[key] = val;
        }
    }
    return o;
}

/**
 * 수집 스코프를 정한다. Template 폴더는 항상 제외한다 — 템플릿의 예시 task 가
 * 캘린더에 섞이면 안 된다.
 */
function resolveSource(opts, sourcePath) {
    if (opts.source) return opts.source;
    if ((opts.scope || "").toLowerCase() === "vault") return '!"Template"';
    const folder = (sourcePath || "").split("/").slice(0, -1).join("/");
    return folder ? '"' + folder + '" and !"Template"' : '!"Template"';
}

/**
 * 캘린더 한 개를 container 안에 그린다. 반환값의 refresh() 를 호출부가 인덱스 변경에 물린다.
 * 본문은 dataviewjs 시절 로직 그대로다(레인 배치·드래그·낙관적 갱신·스크롤 복원·⏰).
 */
function createCalendar({ plugin, api, container, source, notes, sourcePath, component }) {
    const app = plugin.app;
    const L = api.luxon.DateTime;   // Dataview 가 들고 있는 luxon 재사용
    const root = container.createEl("div");
    root.style.width = "100%";
    root.classList.add("gcal-cal");
    // 이 캘린더가 수집할 스코프 (코드블록 옵션에서 결정돼 주입된다)
    const SOURCE = source;

    // ── 재실행 대비 전역 보관함 ────────────────────────────────────────────────
    // Dataview 는 볼트의 파일이 바뀔 때마다 이 dataviewjs 블록을 통째로 재실행한다
    // (설정: refreshInterval, 기본 2500ms). 그때 스크립트 지역변수는 전부 초기화되므로
    // 보던 달/주·필터·스크롤이 되돌아가고, 방금 옮긴 막대도 옛 자리로 그려져 깜빡여 보인다.
    // → 유지해야 할 값은 window 에 두고 재실행 직후 복원한다. 캘린더(스코프)별로 분리.
    const G = plugin.store;   // 상태·대기표는 플러그인 인스턴스가 소유(구 window.__gcalCal)
    const S = (G.state[SOURCE] = G.state[SOURCE] || {});
    const saveState = () => { S.mode = mode; S.view = view.toISODate(); S.showDone = showDone; S.cats = [...activeCats]; };

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

    // 낙관적 갱신 대기표: 파일에 방금 쓴 줄을 Dataview 인덱스가 따라올 때까지 임시로 덮어쓴다.
    const PENDING_TTL = 20000;   // ms — 인덱스가 끝내 안 따라오면 이 시간 뒤 자동 해제
    // 키에 줄 번호가 반드시 들어가야 한다. title 은 날짜·태그·🆔 를 지운 값이라
    // 같은 파일에 제목이 똑같은 태스크(예: 매주 반복 로그)가 여러 개면 전부 같은 키가 되고,
    // 하나를 옮기면 나머지가 그 줄로 덮여 그려진 뒤 applyDates 가 엉뚱한 줄에 쓰게 된다.
    const pkey = (path, line, title) => path + "\u0000" + line + "\u0000" + title;
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
    let mode = S.mode || "month";                 // "month" | "week" (재실행 후에도 유지)
    let view = S.view ? L.fromISO(S.view) : L.now().startOf("month");
    let dragging = null;
    let showDone = S.showDone !== false;   // 달력에 완료 항목 표시 여부

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
        const cats = plugin.settings.categories.filter((c) => c.key);
        CATS = cats.map((c) => c.key);
        CATLABEL = Object.fromEntries(cats.map((c) => [c.key, c.label || c.key]));
        // 색은 실제 Google Calendar 의 커스텀 색 HEX 를 그대로 쓴다.
        CATCOLOR = Object.fromEntries(cats.map((c) => [c.key, c.color]));
        CAT_DEFAULT = plugin.settings.defaultCategory || CATS[0] || "";
        // 설정에서 사라진 카테고리는 필터에서도 뺀다. 저장된 필터에 없던 새 카테고리는
        // 켠 채로 시작한다 — 방금 만든 카테고리가 안 보이면 버그로 읽힌다.
        const saved = Array.isArray(S.cats) ? S.cats : null;
        for (const c of [...activeCats]) if (!CATS.includes(c)) activeCats.delete(c);
        for (const c of CATS) if (!saved || !saved.includes(c)) activeCats.add(c);
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

    // ---- 날짜 헬퍼 (날짜만, TZ 안전) ----
    const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const diffDays = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
    const sundayStart = (d) => d.minus({ days: d.weekday % 7 });   // 일요일 시작
    const todayISO = L.now().toISODate();

    // ---- 시간(타임블록) ----
    // 문법: ⏰ HH:MM-HH:MM (종료 생략 시 시작 + DEFAULT_MIN 분)
    //
    // ⚠️ 줄에 새로 넣을 때는 반드시 "첫 Tasks 필드 이모지 앞"에 삽입한다. 줄 끝에 붙이면 안 된다.
    //    Tasks 8.3.0 은 필드 정규식을 전부 "$" 앵커로 만들고(Da()), deserialize() 가 줄 끝에서부터
    //    하나씩 벗겨내는 do-while 루프다. 끝에 Tasks 가 모르는 토큰이 있으면 첫 바퀴에 아무것도
    //    매치되지 않아 루프가 끝나고, 그 앞의 📅🛫 까지 통째로 설명(description)으로 흡수된다
    //    → 마감일 기반 쿼리·정렬이 그 태스크를 놓친다.
    // 그래서 시각은 사용자가 타이핑하지 않고 일간 보기 드래그로만 설정한다(위치를 코드가 통제).
    const TIME_PAT = "\\u{23F0}\\s*(\\d{1,2}:\\d{2})(?:\\s*-\\s*(\\d{1,2}:\\d{2}))?";
    const timeRe = () => new RegExp(TIME_PAT, "u");
    const timeReStrip = () => new RegExp("\\s*" + TIME_PAT, "gu");
    // 첫 Tasks 필드 이모지 = 삽입 기준점 (우선순위 이모지 포함)
    const FIELD_EMOJI = /[\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{1F6EB}\u{23F3}\u{231B}\u{2705}\u{2795}\u{274C}\u{1F501}\u{1F194}\u{26D4}\u{1F3C1}\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]/u;
    const DEFAULT_MIN = 60;   // 종료 시각이 없을 때의 기본 길이
    const SNAP_MIN = 15;      // 드래그 스냅 단위(분)
    const HOUR_H = 44;        // 일간 보기에서 1시간 높이(px)
    const DAY_BOX_H = 560;    // 시간 그리드 스크롤 박스 높이(px)
    const GUTTER = 52;        // 시각 라벨이 차지하는 왼쪽 폭(px)

    const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
    const toHHMM = (min) => { const x = Math.max(0, Math.min(1439, Math.round(min))); return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
    const snapMin = (m) => Math.round(m / SNAP_MIN) * SNAP_MIN;
    const timeText = (s, e) => toHHMM(s) + "-" + toHHMM(e);

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

    // 원본 노트의 해당 줄로 이동 (편집 모드면 커서/스크롤까지 보정)
    async function openAtLine(task, evt) {
        const f = app.vault.getAbstractFileByPath(task.path);
        if (!f) { new Notice("파일 없음: " + task.path); return; }
        const leaf = app.workspace.getLeaf(openMode(evt));   // false = 현재 탭 · "tab" = 새 탭 · "split" = 분할
        const line = typeof task.line === "number" ? task.line : 0;
        await leaf.openFile(f, { eState: { line } });
        const ed = leaf.view && leaf.view.editor;
        if (ed) { ed.setCursor({ line, ch: 0 }); ed.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true); }
    }

    // 파일의 줄 배열에서 이 태스크의 실제 줄 인덱스를 찾는다. 못 찾으면 -1.
    // task.line 이 맞으면 그대로 쓰고, 어긋났으면(외부 편집으로 줄이 밀렸을 때) text 로 재탐색한다.
    // ⚠️ 확인 없이 task.line 을 그냥 쓰면 태스크가 아닌 줄을 덮어쓴다 → 호출부는 반드시 -1 을 처리할 것.
    const findTaskLine = (lines, task) => {
        const i = task.line;
        if (lines[i] !== undefined && lines[i].includes(task.text)) return i;
        return lines.findIndex(l => l.includes(task.text));
    };

    // 우클릭 → Tasks 편집 모달(탭 이동 없이). apiV1.editTaskLineModal 로 줄을 수정 → 파일 반영 → 제자리 갱신.
    async function editTask(task) {
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
        el.addEventListener("drop", async (e) => { e.preventDefault(); e.stopPropagation(); el.style.background = baseBg; if (dragging) { const t = dragging; dragging = null; await dropOnDate(t, iso, e.shiftKey); } });
    }

    function gather() {
        const out = [];
        const now = Date.now();
        // 만료된 대기표는 그 줄을 다시 만나야 풀렸다 → 줄이 지워지면 영원히 남는다. 매 수집마다 일괄 청소.
        for (const [k, v] of G.pending) if (now - v.ts > PENDING_TTL) G.pending.delete(k);
        // 제목 = 날짜·태그를 지운 값 → 날짜를 바꿔도 변하지 않으므로 대기표 키로 안전
        const mkTitle = (s) => s
            // 🔁 뒤에는 날짜가 아니라 문장이 온다(예: 🔁 every week on Monday) → 다음 필드/태그 전까지 제거
            .replace(/🔁[^📅🛫⏳✅➕❌🆔⛔🔺⏫🔼🔽⏬#]*/gu, "")
            .replace(/(?:📅|🛫|⏳|✅|➕|❌)\s*\d{4}-\d{2}-\d{2}/gu, "")
            .replace(timeReStrip(), "")        // ⏰ 시각 필드 제거 (제목에 섞이면 GCal 이벤트 제목이 더러워진다)
            .replace(/(?:🆔|⛔)\s*\S+/gu, "")   // 🆔 id · ⛔ 의존성 제거 (u 플래그로 이모지 정확 매칭)
            .replace(/[🔺⏫🔼🔽⏬📅🛫⏳✅➕❌🔁]/gu, "")   // 우선순위 표시 · 남은 필드 마커 제거
            .replace(/#\S+/g, "")
            .replace(/\s+/g, " ").trim();
        for (const p of api.pages(SOURCE)) {
            for (const t of p.file.tasks) {
                let text = String(t.text || "");
                if (!/#task\b/.test(text)) continue;
                let title = mkTitle(text);
                // 낙관적 갱신: 방금 쓴 줄이 아직 인덱스에 안 반영됐으면 그 줄로 대체해서 그린다
                const key = pkey(p.file.path, t.line, title);
                const ov = G.pending.get(key);
                if (ov) {
                    if (ov.text === text) G.pending.delete(key);   // 인덱스가 따라옴 → 해제
                    else { text = ov.text; title = mkTitle(text); }   // 편집 모달로 제목이 바뀐 경우까지 반영
                }
                const dm = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
                const sm = text.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
                const gm = text.match(/#gcal\/([\w-]+)/);
                const cancelled = t.status === "-";   // - [-] = Tasks 취소 상태
                const bookmark = t.status === "b";    // - [b] = 북마크 상태
                // ⏰ 시각. 종료가 없거나 역전돼 있으면 기본 길이로 보정한다(막대 높이가 0/음수가 되지 않게).
                const tm = text.match(timeRe());
                let tStart = null, tEnd = null;
                if (tm) {
                    tStart = Math.min(1439, toMin(tm[1]));
                    tEnd = tm[2] ? toMin(tm[2]) : tStart + DEFAULT_MIN;
                    if (tEnd <= tStart) tEnd = tStart + DEFAULT_MIN;
                    tEnd = Math.min(1440, tEnd);
                }
                out.push({ path: p.file.path, line: t.line, text, title, due: dm ? dm[1] : null, start: sm ? sm[1] : null, tStart, tEnd, cat: gm ? gm[1].toLowerCase() : CAT_DEFAULT, done: !!t.completed, cancelled, bookmark });
            }
        }
        return out;
    }

    // 원본 줄의 🛫 start / 📅 due / ⏰ time 을 직접 변경 (changes: {start?, due?, time?}).
    // 없는 필드는 새로 추가하고, time 에 null 을 주면 시각을 제거한다.
    async function applyDates(task, changes) {
        rememberScroll();   // 쓰기 → Dataview 재실행 사이에 스크롤이 튀지 않게
        const file = app.vault.getAbstractFileByPath(task.path);
        if (!file) { new Notice("파일 없음: " + task.path); return; }
        // 파일의 실제 줄과 task.text 에 똑같이 적용하기 위해 변경을 함수로 분리
        const patch = (ln) => {
            if (changes.start !== undefined) {
                if (/🛫\s*\d{4}-\d{2}-\d{2}/.test(ln)) ln = ln.replace(/🛫\s*\d{4}-\d{2}-\d{2}/, "🛫 " + changes.start);
                else ln = ln.replace(/\s*$/, "") + " 🛫 " + changes.start;
            }
            if (changes.due !== undefined) {
                if (/📅\s*\d{4}-\d{2}-\d{2}/.test(ln)) ln = ln.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "📅 " + changes.due);
                else ln = ln.replace(/\s*$/, "") + " 📅 " + changes.due;
            }
            // ⏰ 는 마지막에 처리한다 — 위에서 📅/🛫 를 새로 붙였을 수 있고, 시각은 그것들보다 앞에 와야 한다.
            if (changes.time !== undefined) {
                const cleaned = ln.replace(timeReStrip(), "");
                if (changes.time === null) ln = cleaned;
                else {
                    const field = "⏰ " + changes.time;
                    const m = cleaned.match(FIELD_EMOJI);
                    // 첫 Tasks 필드 이모지 앞에 삽입. 줄 끝 append 는 Tasks 파싱을 깨뜨리므로 금지
                    // (필드 정규식이 "$" 앵커라, 끝에 모르는 토큰이 있으면 그 앞 필드까지 안 읽힌다).
                    ln = m
                        ? cleaned.slice(0, m.index).replace(/\s*$/, "") + " " + field + " " + cleaned.slice(m.index)
                        : cleaned.replace(/\s*$/, "") + " " + field;
                }
            }
            return ln;
        };
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

    // 날짜 칸에 드롭. 드롭한 칸(iso)이 무엇이 되는지가 두 동작의 차이다.
    //   일반   = 기간 이동 : iso 가 🛫 시작일(없으면 📅 마감일)이 되고 기간 길이는 그대로 유지.
    //   Shift  = 마감 조정 : iso 가 📅 마감일이 되고 🛫 시작일은 고정 — 없으면 원래 마감일 자리에 새로 생김.
    // 어느 쪽이든 start > due 상태는 만들지 않는다 (막대 폭이 음수가 되어 CSS 가 무효화된다).
    async function dropOnDate(task, iso, shift) {
        if (shift) {
            const base = task.start || task.due;   // 고정될 왼쪽 끝
            if (!base) { await applyDates(task, { due: iso }); new Notice("📅 " + iso); return; }
            if (iso < base) { new Notice("마감일은 시작일(🛫 " + base + ")보다 앞설 수 없어요"); return; }
            // 시작일이 없던 태스크는 원래 마감일을 시작일로 굳혀서 기간이 생기게 한다
            await applyDates(task, task.start ? { due: iso } : { start: base, due: iso });
            new Notice("📅 " + iso + (task.start ? "" : "  (🛫 " + base + " 생성)"));
        } else {
            if (!task.due) { await applyDates(task, { due: iso }); new Notice("📅 " + iso); return; }
            if (!task.start) { await applyDates(task, { due: iso }); new Notice("📅 " + iso); return; }
            const span = diffDays(task.due, task.start);       // 기간 길이(일) 보존
            const newDue = addDays(iso, span);
            await applyDates(task, { start: iso, due: newDue });
            new Notice("🛫 " + iso + " → 📅 " + newDue);
        }
    }

    // 일간 보기 시간 그리드에 드롭 → 시각 지정/이동. 길이는 보존(없던 태스크는 DEFAULT_MIN).
    // 다른 날짜(트레이 포함)에서 끌어온 단일일 태스크는 마감일도 이 날짜로 맞춘다.
    // 기간(🛫~📅)이 있는 태스크는 날짜를 건드리지 않는다 — 기간 이동은 월/주간 보기의 역할이다.
    async function dropOnTime(task, iso, startMin) {
        const len = task.tStart !== null ? task.tEnd - task.tStart : DEFAULT_MIN;
        const s = Math.max(0, Math.min(1440 - SNAP_MIN, snapMin(startMin)));
        const e = Math.min(1440, s + len);
        const changes = { time: timeText(s, e) };
        const spans = task.start && task.due && task.start !== task.due;
        if (!spans && task.due !== iso) changes.due = iso;
        await applyDates(task, changes);
        new Notice("⏰ " + timeText(s, e) + (changes.due ? "  📅 " + iso : ""));
    }

    // 트레이 빠른버튼/날짜선택기 → 마감일만 지정 (버튼 라벨이 곧 마감일이므로 기간 이동이 아니다)
    async function writeBack(task, newDue) {
        if (task.start && newDue < task.start) { new Notice("마감일은 시작일(🛫 " + task.start + ")보다 앞설 수 없어요"); return; }
        await applyDates(task, { due: newDue });
        new Notice("📅 " + newDue);
    }

    // 한 주(weekStartISO~+6)에 걸치는 태스크를 기간 막대로 area 위에 배치.
    // 막대 본체 드래그=기간째 이동, Shift+드래그=마감일 조정, 클릭=원본 열기. 반환=막대영역 높이(px).
    function placeBars(area, tasks, weekStartISO, laneH, topOffset, laneMemo) {
        const clampCol = (c) => Math.max(0, Math.min(6, c));
        const colAt = (clientX) => { const r = area.getBoundingClientRect(); return clampCol(Math.floor((clientX - r.left) / r.width * 7)); };

        // 막대 위에 떨궈도 처리되도록 area 자체가 드롭 받음 (빈 칸은 각 셀이 처리)
        area.addEventListener("dragover", (e) => e.preventDefault());
        area.addEventListener("drop", async (e) => { e.preventDefault(); if (dragging) { const t = dragging; dragging = null; await dropOnDate(t, addDays(weekStartISO, colAt(e.clientX)), e.shiftKey); } });

        const weekEndISO = addDays(weekStartISO, 6);
        const vis = tasks.filter(t => t.due && (t.start || t.due) <= weekEndISO && t.due >= weekStartISO);
        // 시작일 → 시각 → 마감일 순. 같은 날이면 시각이 있는 것을 먼저(시각순), 없는 것은 뒤로.
        vis.sort((a, b) => {
            const sa = a.start || a.due, sb = b.start || b.due;
            if (sa !== sb) return sa < sb ? -1 : 1;
            const ta = a.tStart, tb = b.tStart;
            if (ta !== null && tb !== null && ta !== tb) return ta - tb;
            if (ta !== null && tb === null) return -1;
            if (ta === null && tb !== null) return 1;
            return a.due < b.due ? -1 : 1;
        });
        const laneEnd = [];
        const placed = [];
        // 주 경계를 넘는 막대는 지난주에 쓰던 레인을 그대로 이어받는다(비어 있을 때만).
        // 주마다 독립 배치하면 연속된 막대가 다음 줄에서 다른 높이로 그려져 끊겨 보인다.
        const memoKey = (t) => t.path + "\u0000" + t.line;
        const occupy = (lane, eCol) => { while (laneEnd.length <= lane) laneEnd.push(-1); laneEnd[lane] = eCol; };
        for (const t of vis) {
            const sISO = t.start || t.due;
            const rawS = diffDays(sISO, weekStartISO), rawE = diffDays(t.due, weekStartISO);
            const sCol = clampCol(rawS), eCol = clampCol(rawE);
            const prev = laneMemo ? laneMemo.get(memoKey(t)) : undefined;
            let lane = (prev !== undefined && (laneEnd[prev] === undefined || laneEnd[prev] < sCol)) ? prev : laneEnd.findIndex(le => le < sCol);
            if (lane === -1) lane = laneEnd.length;
            occupy(lane, eCol);
            if (laneMemo) laneMemo.set(memoKey(t), lane);
            placed.push({ t, sCol, eCol, lane, clipL: rawS < 0, clipR: rawE > 6 });
        }
        for (const b of placed) {
            const t = b.t, c = CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT];
            const dim = t.done || t.cancelled;          // 취소[-] 도 완료처럼 흐리게
            const overdue = !dim && t.due < todayISO;    // 취소된 건 지연으로 치지 않는다
            const bar = area.createEl("div");
            bar.title = `${t.title}\n🛫 ${t.start || "-"}  📅 ${t.due}` + (t.tStart !== null ? `  ⏰ ${timeText(t.tStart, t.tEnd)}` : "") + (dim ? (t.cancelled ? "\n(취소됨)" : "\n(완료됨)") : "\n드래그=기간째 이동(놓은 칸=시작일) · Shift+드래그=마감일만 조정 · 클릭=열기 · Ctrl+클릭=새 탭");
            bar.style.cssText = `position:absolute;left:calc(${b.sCol / 7 * 100}% + 2px);width:calc(${(b.eCol - b.sCol + 1) / 7 * 100}% - 4px);top:${topOffset + b.lane * laneH}px;height:${laneH - 3}px;z-index:1;box-sizing:border-box;background:${c}2b;border:1px solid ${overdue ? "#e05a7a" : c};border-left:4px solid ${c};border-radius:${b.clipL ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipL ? "0" : "4px"};display:flex;align-items:center;padding:0 7px;font-size:11px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:grab;${dim ? "opacity:0.55;text-decoration:line-through;" : ""}`;
            bar.appendChild(document.createTextNode((t.cancelled ? "✗ " : t.done ? "✓ " : "") + (t.bookmark ? "🔖 " : "") + (b.clipL ? "◀ " : "") + (t.tStart !== null && !b.clipL ? toHHMM(t.tStart) + " " : "") + (t.title || "(제목 없음)") + (b.clipR ? " ▶" : "")));
            bar.draggable = true;
            // dragend 로 반드시 비운다 — 캘린더 밖에 떨궈 취소하면 dragging 이 남고,
            // 그 뒤 외부 드래그(파일 끌어오기 등)가 캘린더에 떨어지면 엉뚱한 태스크가 이동한다.
            bar.addEventListener("dragstart", (e) => { dragging = t; e.dataTransfer.effectAllowed = "move"; });
            bar.addEventListener("dragend", () => { dragging = null; });
            bar.addEventListener("click", (e) => openAtLine(t, e));
            bar.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(t); });   // 우클릭=편집 모달
        }
        return Math.max(laneEnd.length, 1) * laneH;
    }

    // 날짜 없음 트레이용 — 잘리지 않는 카드
    function trayItem(task) {
        const c = CATCOLOR[task.cat] || CATCOLOR[CAT_DEFAULT];
        const el = document.createElement("div");
        el.draggable = true;
        el.title = task.text;
        el.style.cssText = `background:var(--background-primary);border:1px solid var(--background-modifier-border);border-left:4px solid ${c};border-radius:5px;padding:5px 8px;cursor:grab;`;
        const t1 = el.createEl("div", { text: (task.bookmark ? "🔖 " : "") + (task.title || "(제목 없음)") });
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
            hdr.onclick = async (e) => { const f = app.vault.getAbstractFileByPath(path); if (f) await app.workspace.getLeaf(openMode(e)).openFile(f); };
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
        const barsH = placeBars(area, tasks, weekStart, 26, 6);
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
            const barsH = placeBars(row, tasks, weekStartISO, 20, 17, laneMemo);
            row.style.minHeight = (17 + barsH + 4) + "px";
        }
    }

    // 일간 보기용 칩 (종일 스트립에 놓이는, 시각 없는 태스크)
    function dayChip(task) {
        const c = CATCOLOR[task.cat] || CATCOLOR[CAT_DEFAULT];
        const el = document.createElement("div");
        el.draggable = true;
        el.title = task.title + "\n시간 그리드로 드래그하면 시각이 지정됩니다";
        el.style.cssText = `background:${c}2b;border:1px solid ${c};border-left:4px solid ${c};border-radius:4px;padding:2px 7px;font-size:11px;line-height:16px;cursor:grab;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${task.done || task.cancelled ? "opacity:.55;text-decoration:line-through;" : ""}`;
        el.appendChild(document.createTextNode((task.bookmark ? "🔖 " : "") + (task.title || "(제목 없음)")));
        el.addEventListener("dragstart", (e) => { dragging = task; e.dataTransfer.effectAllowed = "move"; });
        el.addEventListener("dragend", () => { dragging = null; });
        el.addEventListener("click", (e) => openAtLine(task, e));
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); editTask(task); });
        return el;
    }

    // 하루를 시간 그리드로. 시각 있는 태스크는 블록, 없는 태스크는 위쪽 종일 스트립.
    //   블록 드래그      = 시작 시각 이동(길이 유지)
    //   블록 하단 핸들   = 종료 시각만 변경
    //   종일 → 그리드    = 시각 부여 · 그리드 → 종일 = 시각 제거
    function renderDay(container, tasks) {
        const iso = view.toISODate();
        const onDay = tasks.filter(t => t.due && (t.start || t.due) <= iso && t.due >= iso);
        const timed = onDay.filter(t => t.tStart !== null).sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
        const allday = onDay.filter(t => t.tStart === null);

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
            const t = dragging; dragging = null;
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
        grid.addEventListener("dragover", (e) => e.preventDefault());
        grid.addEventListener("drop", async (e) => {
            e.preventDefault();
            const t = dragging; dragging = null;
            if (t) await dropOnTime(t, iso, minAt(e.clientY));
        });

        // 겹치는 블록은 좌우로 나눠 놓는다 (시작 시각 순 그리디 레인 배치)
        const laneEnd = [];
        const placed = [];
        for (const t of timed) {
            let lane = laneEnd.findIndex(e => e <= t.tStart);
            if (lane === -1) { lane = laneEnd.length; laneEnd.push(t.tEnd); }
            else laneEnd[lane] = t.tEnd;
            placed.push({ t, lane });
        }
        const lanes = Math.max(laneEnd.length, 1);
        for (const { t, lane } of placed) {
            const c = CATCOLOR[t.cat] || CATCOLOR[CAT_DEFAULT];
            const dim = t.done || t.cancelled;
            const top = t.tStart / 60 * HOUR_H;
            const h = Math.max(16, (t.tEnd - t.tStart) / 60 * HOUR_H - 2);
            const blk = grid.createEl("div");
            blk.draggable = true;
            blk.title = `${t.title}\n⏰ ${timeText(t.tStart, t.tEnd)}\n드래그=시각 이동 · 아래끝 드래그=종료 시각 · 종일 줄로 드래그=시각 제거 · 클릭=열기`;
            blk.style.cssText = `position:absolute;left:calc(${GUTTER}px + (100% - ${GUTTER}px) * ${lane / lanes});width:calc((100% - ${GUTTER}px) * ${1 / lanes} - 5px);top:${top}px;height:${h}px;z-index:2;box-sizing:border-box;background:${c}2b;border:1px solid ${c};border-left:4px solid ${c};border-radius:4px;padding:2px 6px;font-size:11px;line-height:1.3;overflow:hidden;cursor:grab;${dim ? "opacity:.55;text-decoration:line-through;" : ""}`;
            blk.appendChild(document.createTextNode(`${toHHMM(t.tStart)} ${(t.cancelled ? "✗ " : t.done ? "✓ " : "")}${t.title || "(제목 없음)"}`));
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

        // 첫 표시 위치: 사용자가 보던 곳 → 없으면 가장 이른 일정 → 없으면 08:00.
        // 계산한 값은 곧바로 S 에 고정한다. 안 그러면 드롭으로 "가장 이른 일정"이 바뀔 때마다
        // 재렌더에서 스크롤이 다른 곳으로 튀어 화면이 새로고침된 것처럼 보인다.
        if (S.dayScroll === undefined) S.dayScroll = Math.max(0, (timed.length ? timed[0].tStart : 8 * 60) / 60 * HOUR_H - HOUR_H);
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
        const calTasks = showDone ? all : tasks;   // 달력 = 토글에 따라 완료·취소 포함

        // ── 툴바: 네비 + 뷰 전환 ──
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
            b.style.cssText = `font-size:11px;padding:2px 9px;border-radius:10px;cursor:pointer;${m === mode ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;"}`;
            b.onclick = () => {
                if (m === mode) return;
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
        todayBtn.onclick = () => { view = mode === "month" ? L.now().startOf("month") : mode === "day" ? L.now().startOf("day") : sundayStart(L.now()); render(); };

        // ── 카테고리 필터 토글 ──
        const filterBar = box.createEl("div");
        filterBar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;";
        const allBtn = filterBar.createEl("button", { text: "전체" });
        allBtn.style.cssText = "font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;";
        allBtn.onclick = () => { CATS.forEach(c => activeCats.add(c)); render(); };
        for (const cat of CATS) {
            const on = activeCats.has(cat);
            const b = filterBar.createEl("button");
            b.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;border:1px solid var(--background-modifier-border);opacity:${on ? 1 : 0.4};`;
            const dot = b.createEl("span");
            dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${CATCOLOR[cat]};display:inline-block;`;
            b.createEl("span", { text: CATLABEL[cat] });
            b.onclick = () => { if (activeCats.has(cat)) activeCats.delete(cat); else activeCats.add(cat); render(); };
        }

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

class GcalCalendarSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h3", { text: "카테고리" });
        const desc = containerEl.createEl("p", {
            text: "task 의 #gcal/<key> 태그로 분류된다. 색을 Google Calendar 의 커스텀 색과 맞추면 캘린더와 GCal 이 같은 색으로 보인다.",
        });
        desc.style.cssText = "font-size:12px;opacity:.7;margin:0 0 4px;";
        // 입력칸이 셋뿐이라 무엇을 넣는 칸인지 placeholder 만으로는 헷갈린다.
        const cols = containerEl.createEl("p", { text: "key (#gcal/<key>)  ·  표시 이름  ·  색" });
        cols.style.cssText = "font-size:11px;opacity:.5;margin:0 0 6px;";

        this.plugin.settings.categories.forEach((cat, i) => {
            const row = new Setting(containerEl);
            row.infoEl.remove();   // 라벨 칸 없이 입력만 나열
            row.addText((t) =>
                t.setPlaceholder("key (예: work)").setValue(cat.key).onChange(async (v) => {
                    cat.key = v.trim();
                    await this.plugin.saveSettings();
                })
            );
            row.addText((t) =>
                t.setPlaceholder("표시 이름").setValue(cat.label).onChange(async (v) => {
                    cat.label = v;
                    await this.plugin.saveSettings();
                })
            );
            row.addColorPicker((c) =>
                c.setValue(cat.color).onChange(async (v) => {
                    cat.color = v;
                    await this.plugin.saveSettings();
                })
            );
            row.addExtraButton((b) =>
                b.setIcon("trash").setTooltip("삭제").onClick(async () => {
                    this.plugin.settings.categories.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
        });

        new Setting(containerEl).addButton((b) =>
            b.setButtonText("카테고리 추가").onClick(async () => {
                this.plugin.settings.categories.push({ key: "", label: "", color: "#7f8c8d" });
                await this.plugin.saveSettings();
                this.display();
            })
        );

        // ── 사용법: 편집 대상이 아니라 붙박이 설명이다 ──
        // 예전에는 이 내용을 노트마다 콜아웃으로 복붙해 뒀다. 노트에서 지우면 조작법을
        // 어디서도 찾을 수 없게 되므로, 잊어버리지 않게 설정 화면에 박아 둔다.
        containerEl.createEl("h3", { text: "사용법" });
        const usage = containerEl.createEl("div");
        usage.style.cssText = "font-size:12px;line-height:1.7;opacity:.85;";

        usage.createEl("p", { text: "노트에 코드블록으로 넣는다:" }).style.margin = "0 0 4px";
        const code = usage.createEl("pre");
        code.style.cssText = "font-size:11px;padding:8px;border-radius:4px;background:var(--background-secondary);margin:0 0 10px;white-space:pre;";
        code.setText(
            "```gcal-calendar\n" +
            "```                     ← 이 노트가 놓인 폴더 이하 (기본)\n\n" +
            "```gcal-calendar\n" +
            "scope: vault            ← 볼트 전체\n" +
            "```\n\n" +
            "```gcal-calendar\n" +
            'source: "0. Note" and !"Template"   ← Dataview 소스 쿼리 직접 지정\n' +
            "note: 이 블록에만 붙일 설명 (마크다운, 여러 줄 가능)\n" +
            "```"
        );

        const ul = usage.createEl("ul");
        ul.style.cssText = "margin:0;padding-left:18px;";
        for (const t of [
            "태스크는 기간 막대(🛫 start ~ 📅 due)로 표시. start 없으면 due 하루짜리 막대.",
            "막대·트레이 카드를 날짜로 드래그 = 기간째 이동(놓은 칸 = 🛫 시작일, 없으면 📅 마감일).",
            "Shift + 드래그 = 📅 마감일만 조정 (🛫 없으면 생성).",
            "일간 보기: 블록 드래그 = 시각 이동(15분 단위) · 아래끝 드래그 = 종료 시각 · 종일 줄 ↔ 그리드 = 시각 부여/제거.",
            "클릭 = 원본 열기(현재 탭) · Ctrl+클릭 = 새 탭 · Ctrl+Shift+클릭 = 분할 창 · 우클릭 = Tasks 편집 모달.",
            "📥 날짜 없음 / 🔴 지연 카드의 빠른 버튼·날짜선택기로도 마감일 변경.",
            "변경은 노트에 바로 쓰이고 tasks-gcal-sync 가 Google Calendar 로 올린다.",
            "시각(⏰)은 일간 보기 드래그로만 넣는다 — 줄 끝에 적으면 Tasks 가 📅 까지 못 읽는다.",
        ]) {
            ul.createEl("li", { text: t });
        }

        containerEl.createEl("h3", { text: "기타" });
        new Setting(containerEl)
            .setName("기본 카테고리")
            .setDesc("#gcal/ 태그가 없는 task 에 쓰인다. 색 폴백도 겸한다.")
            .addDropdown((d) => {
                for (const c of this.plugin.settings.categories) {
                    if (c.key) d.addOption(c.key, c.label || c.key);
                }
                d.setValue(this.plugin.settings.defaultCategory);
                d.onChange(async (v) => {
                    this.plugin.settings.defaultCategory = v;
                    await this.plugin.saveSettings();
                });
            });
    }

    hide() {
        // 설정 창을 닫을 때 한 번만 다시 그린다 — 타이핑 한 글자마다 재렌더하면 눈이 아프다.
        this.plugin.refreshAll();
    }
}

module.exports = class GcalCalendarViewPlugin extends Plugin {
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
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /** 열려 있는 캘린더를 모두 다시 그린다 (설정 변경 후). */
    refreshAll() {
        for (const cal of this.views) {
            if (cal.isAlive()) cal.refresh();
        }
    }

    renderBlock(src, el, ctx) {
        const child = new MarkdownRenderChild(el);
        ctx.addChild(child);

        const api = this.app.plugins.plugins.dataview && this.app.plugins.plugins.dataview.api;
        if (!api) {
            // 로드 순서상 우리가 먼저일 수 있다. 안내를 띄우고 인덱스가 준비되면 한 번 다시 그린다.
            const warn = el.createEl("div", {
                text: "Dataview 플러그인이 필요합니다 — 활성화되면 자동으로 다시 그립니다.",
            });
            warn.style.cssText =
                "padding:8px;border:1px dashed var(--background-modifier-border);border-radius:4px;font-size:12px;opacity:.8;";
            let done = false;
            const ref = this.app.metadataCache.on("dataview:index-ready", () => {
                if (done) return;
                done = true;
                this.app.metadataCache.offref(ref);
                el.empty();
                this.renderBlock(src, el, ctx);
            });
            child.register(() => {
                if (!done) this.app.metadataCache.offref(ref);
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
        const ref = this.app.metadataCache.on("dataview:metadata-change", () => {
            if (cal.isAlive()) cal.refresh();
        });
        child.register(() => this.app.metadataCache.offref(ref));
    }
};

// 순수 함수만 테스트에서 꺼내 쓴다(스코프 결정은 노트 위치에 따라 갈리는 유일한 분기다).
// Obsidian 은 module.exports 의 기본 export 만 보므로 이 속성은 무해하다.
module.exports.__test = { parseOptions, resolveSource };
