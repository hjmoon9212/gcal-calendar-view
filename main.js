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
const { Plugin, PluginSettingTab, Setting, Notice, Keymap, Modal, Platform, MarkdownRenderChild, MarkdownRenderer } = require("obsidian");

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
    // ── GCal 일정(읽기 전용)의 색 ──
    // **색은 전부 이 플러그인이 소유한다.** 그리는 쪽이 색을 갖는 게 맞고, 카테고리 색과
    // 한 화면에 있어야 "task 막대와 회의 막대를 같은 색으로" 를 눈으로 맞출 수 있다.
    // tasks-gcal-sync 는 "어느 캘린더를 가져올지" 만 정한다.
    //
    // eventColors: 캘린더 id → "#rrggbb". 여기 있으면 그 색을 쓴다(직접 지정).
    //              없으면 같은 이름의 카테고리 색 → 그것도 없으면 eventColor.
    eventColors: {},
    // 같은 이름의 카테고리가 없는 캘린더의 색 (예: "Holidays in South Korea")
    eventColor: "#7f8c8d",
    // ── 모바일 화면 ──
    // "auto" = 폰이면 모바일 화면(Platform.isPhone). "always"/"off" 로 강제할 수 있다.
    // 강제가 필요한 이유가 둘: 태블릿은 isPhone 이 false 라 데스크탑 화면을 받고,
    // 모바일 화면을 고칠 때 폰을 들지 않고 데스크탑에서 바로 볼 수 있어야 한다.
    mobileUi: "auto",   // "auto" | "always" | "off"
};

/**
 * 겹치는 시간 블록을 좌우 레인으로 나눈다. 반환: `[{t, lane, lanes, span}]`.
 *
 * 레인 수는 반드시 **"겹치는 무리(cluster)" 안에서만** 센다 — 하루 전체로 세면 오전에
 * 3중 겹침이 한 번 있었다는 이유로 저녁 단독 일정까지 1/3 폭이 된다.
 * 무리 경계: 시작 시각이 지금 무리의 최대 종료 **이상**이면 끊는다(맞닿음은 겹침이 아니다).
 *
 * 데스크탑 일간 보기와 모바일 타임라인이 **같은 배치**를 쓰도록 여기 한 곳에 둔다.
 * 순수 계산이라 DOM 도 설정도 보지 않는다 — 그래서 테스트할 수 있다(__test).
 */
function layoutTimeLanes(timed) {
    const items = [...timed].sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
    const laneEnd = [];
    const placed = [];
    let cluster = [];          // 지금 무리에 담긴 항목 (레인 수가 확정되면 placed 로 넘어간다)
    let clusterEnd = -1;
    const closeCluster = () => {
        const lanes = Math.max(laneEnd.length, 1);
        for (const it of cluster) {
            // 오른쪽 레인이 이 블록의 시간대 내내 비어 있으면 그만큼 넓힌다.
            // first-fit 이 레인을 앞에서부터 채우므로 자주 발동하진 않는다.
            let span = 1;
            while (it.lane + span < lanes &&
                !cluster.some(o => o.lane === it.lane + span && o.t.tStart < it.t.tEnd && o.t.tEnd > it.t.tStart)) span++;
            placed.push({ t: it.t, lane: it.lane, lanes, span });
        }
        cluster = [];
        laneEnd.length = 0;
    };
    for (const t of items) {
        if (t.tStart >= clusterEnd) { closeCluster(); clusterEnd = t.tEnd; }
        else clusterEnd = Math.max(clusterEnd, t.tEnd);
        let lane = laneEnd.findIndex((e) => e <= t.tStart);
        if (lane === -1) { lane = laneEnd.length; laneEnd.push(t.tEnd); }
        else laneEnd[lane] = t.tEnd;
        cluster.push({ t, lane });
    }
    closeCluster();            // 마지막 무리 — 빠뜨리면 하루의 끝 일정이 그려지지 않는다
    return placed;
}

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
 * 쉼표로 나열한 값 → 배열. 빈 항목은 버린다.
 * `calendars: Growth, Routine` 처럼 한 줄에 여러 개를 적는 옵션에 쓴다.
 */
function parseList(v) {
    return String(v || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 캘린더 이름 비교용 정규화. 사람이 손으로 적는 값이라 대소문자·공백을 무시한다. */
const calKey = (s) => String(s || "").trim().toLowerCase();

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
const okHex = (v) => (HEX6_RE.test(String(v || "")) ? String(v).toLowerCase() : null);

/**
 * GCal 일정 하나의 색과 **그 색이 어디서 왔는지**. 설정 화면과 렌더가 같은 함수를 쓴다 —
 * 설정에 보이는 색과 화면에 그려지는 색이 갈라지면 그것만으로 버그다.
 *
 * 우선순위:
 *   1) eventColors[캘린더 id]        직접 지정
 *   2) 같은 이름의 카테고리 색        기본 — task 막대와 저절로 맞는다
 *   3) eventColor                    카테고리가 없는 캘린더(예: Holidays in South Korea)
 */
function resolveEventColorInfo(settings, catColor, calId, calName) {
    const own = okHex((settings.eventColors || {})[calId]);
    if (own) return { color: own, source: "직접 지정", cat: null };
    const key = calKey(calName);
    const byCat = okHex((catColor || {})[key]);
    if (byCat) return { color: byCat, source: `카테고리 «${key}» 따름`, cat: key };
    return {
        color: okHex(settings.eventColor) || "#7f8c8d",
        source: "기본 색 따름 (같은 이름의 카테고리 없음)",
        cat: null,
    };
}
const resolveEventColor = (settings, catColor, calId, calName) =>
    resolveEventColorInfo(settings, catColor, calId, calName).color;

/** 설정 화면에서 쓸 카테고리 색 맵 (key → color). createCalendar 밖에서도 필요하다. */
function categoryColorMap(settings) {
    const m = {};
    for (const c of settings.categories || []) if (c && c.key) m[calKey(c.key)] = c.color;
    return m;
}

/**
 * 블록별 GCal 일정 필터.
 *
 *   gcal: Growth, Routine     ← 이 캘린더의 일정만 (화이트리스트)
 *   gcal-exclude: Event       ← 이것만 빼기 (블랙리스트)
 *   gcal: off                 ← 이 블록에서는 일정을 아예 안 그린다
 *
 * 이름을 `gcal` 로 잡은 이유: 값이 `#gcal/Growth` 라우팅 태그의 이름과 **글자 그대로
 * 같다.** 노트에서 쓰던 말을 그대로 쓰므로 따로 외울 게 없고, `gcal` 은 구글 캘린더
 * 쪽만 가리켜서 위젯 자체나 task 와 헷갈릴 여지가 없다.
 * (`calendars:` 는 "이 캘린더 위젯" 으로 읽혀 무엇을 거르는지가 안 보였다 → 별칭으로만 남긴다)
 *
 * 둘 다 적으면 화이트리스트를 먼저 적용하고 거기서 블랙리스트를 뺀다.
 * **동기화 플러그인 설정에서 고른 캘린더의 부분집합**이다 — 여기 적었다고 안 고른
 * 캘린더를 가져오지는 않는다(가져올 자격증명·조회는 그쪽이 한다).
 */
function resolveCalFilter(opts) {
    // 먼저 정의된 것이 이긴다. 뒤쪽 둘은 0.2.3 의 옛 이름(별칭).
    const pick = (...keys) => {
        for (const k of keys) if (opts[k] !== undefined) return opts[k];
        return undefined;
    };
    const rawInc = pick("gcal", "calendars", "include-calendars");
    const off = ["none", "off", "-"].includes(calKey(rawInc));
    return {
        off,
        include: off ? [] : parseList(rawInc).map(calKey),
        // `exclude:` 단독은 일부러 안 받는다 — 폴더/소스 제외로 읽히기 쉽다.
        // 빼는 대상이 GCal 캘린더라는 걸 이름에 남긴다.
        exclude: parseList(pick("gcal-exclude", "exclude-calendars")).map(calKey),
    };
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
function createCalendar({ plugin, api, container, source, notes, sourcePath, component, calFilter }) {
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
    const saveState = () => { S.mode = mode; S.view = view.toISODate(); S.showDone = showDone; S.showEvents = showEvents; S.cats = [...activeCats]; };

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
    // 항목의 안정 식별자. task 는 파일+줄, GCal 일정은 피드가 준 uid 를 그대로 쓴다.
    // placeBars 의 레인 메모가 이 값을 키로 삼는다 — 일정에는 path·line 이 없기 때문이다.
    const SEP = String.fromCharCode(0);
    const UID = (path, line) => path + SEP + line;
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

    // 읽기 전용 항목인가. 이 하나로 모든 쓰기·이동 경로를 막는다.
    const isRO = (t) => !!t && t.kind === "event";
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
        const cats = plugin.settings.categories.filter((c) => c.key);
        CATS = cats.map((c) => c.key);
        CATLABEL = Object.fromEntries(cats.map((c) => [c.key, c.label || c.key]));
        // 색은 실제 Google Calendar 의 커스텀 색 HEX 를 그대로 쓴다.
        CATCOLOR = Object.fromEntries(cats.map((c) => [c.key, c.color]));
        CAT_DEFAULT = plugin.settings.defaultCategory || CATS[0] || "";
        // 설정에서 사라진 카테고리는 필터에서도 뺀다. 설정에 "새로 생긴" 카테고리는
        // 켠 채로 시작한다 — 방금 만든 카테고리가 안 보이면 버그로 읽힌다.
        //
        // "새로 생겼는지" 는 반드시 지난번 카테고리 "목록"(S.knownCats)과 견줘야 한다.
        // 활성 목록(S.cats)과 견주면 꺼 둔 카테고리와 처음 보는 카테고리를 구분하지 못해
        // 꺼 둔 게 다음 렌더에 되살아난다. 클릭 한 번이 곧 렌더 한 번이라, 두 번째로 끄는
        // 순간 첫 번째가 켜져서 "한 번에 하나만 꺼진다" 로 나타났다(0.1.12 에서 수정).
        const saved = Array.isArray(S.cats) ? S.cats : null;
        // knownCats 가 없는 첫 실행: 이미 저장된 필터가 있으면 지금 목록을 다 아는 것으로 친다
        // (안 그러면 업데이트 직후 꺼 둔 게 한 번 되살아난다). 저장분이 아예 없으면 전부 켠다.
        const known = Array.isArray(S.knownCats) ? S.knownCats : (saved ? CATS : null);
        for (const c of [...activeCats]) if (!CATS.includes(c)) activeCats.delete(c);
        for (const c of CATS) if (!known || !known.includes(c)) activeCats.add(c);
        S.knownCats = [...CATS];
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
    const HOUR_H = 64;        // 일간 보기에서 1시간 높이(px). 15분 스냅 = 16px 라 15분 단위가 눈에 잡힌다
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
                // 🔁 반복 task. mkTitle 이 제목에서 지우므로 여기서 원문을 보고 잡아둔다.
                const recurring = /🔁/u.test(text);
                out.push({ kind: "task", uid: UID(p.file.path, t.line), path: p.file.path, line: t.line, text, title, due: dm ? dm[1] : null, start: sm ? sm[1] : null, tStart, tEnd, cat: gm ? gm[1].toLowerCase() : CAT_DEFAULT, done: !!t.completed, cancelled, bookmark, recurring });
            }
        }
        return out;
    }

    /**
     * 이 블록이 이 캘린더를 그리는가. 이름(대소문자·공백 무시)이나 id 로 맞춘다 —
     * 사람이 손으로 적는 값이므로 이름이 주 경로이고, id 는 이름이 겹칠 때의 탈출구다.
     */
    const passesCalFilter = (e) => {
        const name = calKey(e.calendarName);
        const id = calKey(e.calendarId);
        const hit = (list) => list.includes(name) || list.includes(id);
        if (CALF.include.length && !hit(CALF.include)) return false;
        if (CALF.exclude.length && hit(CALF.exclude)) return false;
        return true;
    };

    const HEX6 = /^#[0-9a-fA-F]{6}$/;
    /**
     * 일정의 색. **카테고리 색을 먼저 본다** — 따로 맞춰 놓을 필요가 없게.
     *
     * `#gcal/<이름>` 라우팅이 태그 이름과 캘린더 이름을 그대로 맞추므로(보정 규칙이
     * 없으면), 캘린더 이름을 소문자로 내리면 카테고리 키와 맞는다. 그래서 같은 캘린더의
     * task 막대와 회의 막대가 **저절로 같은 색**이 된다. 카테고리 색을 바꾸면 둘 다 따라온다.
     */
    /**
     * 일정의 색. **색은 전부 이 플러그인 설정이 정한다** — tasks-gcal-sync 가 실어 보내는
     * `e.color` 는 일부러 보지 않는다. 색이 두 군데 있으면 어느 쪽이 이기는지를 매번
     * 되짚어야 하고, 실제로 그렇게 헷갈렸다.
     */
    const eventColor = (e) => resolveEventColor(plugin.settings, CATCOLOR, e.calendarId, e.calendarName);

    /**
     * 피드가 준 일정 → 캘린더가 그릴 수 있는 항목.
     *
     * **task 항목과 같은 오리 모양으로 만든다** — start/due/tStart/tEnd 를 그대로 쓰므로
     * placeBars 의 레인 배치도, renderDay 의 종일/시간 분리도, 일간 클러스터 계산도
     * 손댈 게 없다. 새 레이아웃 코드를 만들지 않는 것이 이 기능의 위험을 가장 크게 줄인다.
     *
     * path·line 은 **일부러 null** 이다. isRO 가드를 하나 빠뜨려도 파일 경로가 해석되지
     * 않아 아무것도 못 고친다(이중 안전장치).
     */
    const toEventItem = (e) => ({
        kind: "event",
        uid: e.uid,
        path: null, line: null, text: "",
        title: e.title,
        start: e.startISO, due: e.endISO,
        tStart: e.tStart, tEnd: e.tEnd,
        cat: null,                       // 카테고리가 아니다 — 필터도 별도 토글로 건다
        // 기본은 **카테고리 색**이다. `#gcal/<이름>` 라우팅이 태그 이름과 캘린더 이름을
        // 그대로 맞추므로(보정 규칙이 없으면), 캘린더 "Growth" 의 회의는 growth 카테고리
        // 색이 되어 같은 캘린더의 task 막대와 저절로 같아진다. 동기화 플러그인 설정에서
        // 색을 고르면 그게 이긴다 → eventColor()
        color: eventColor(e),
        calendarName: e.calendarName || "",
        location: e.location || "", allDay: e.allDay,
        recurring: !!e.recurring,
        done: false, cancelled: false, bookmark: false,
    });

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
        // 카테고리 색이 바뀌면 캐시된 항목의 color 도 다시 계산해야 한다(eventColor 참고)
        // 색 설정이 바뀌면 캐시된 항목도 다시 칠해야 한다 → 서명을 키에 넣는다
        const key = fromISO + "|" + toISO + "|" + feedVersion + "|" +
            CATS.map((c) => CATCOLOR[c]).join(",") + "|" +
            plugin.settings.eventColor + "|" + JSON.stringify(plugin.settings.eventColors || {});
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

    // 지금 보기가 실제로 그리는 날짜 범위. 조회 창이자 peek 필터다.
    const rangeForView = () => {
        if (mode === "day") { const d = view.toISODate(); return [d, d]; }
        if (mode === "week") { const s = view.toISODate(); return [s, addDays(s, 6)]; }
        const first = sundayStart(view.startOf("month")).toISODate();
        const last = sundayStart(view.endOf("month")).toISODate();
        return [first, addDays(last, 6)];
    };

    // 원본 줄의 🛫 start / 📅 due / ⏰ time 을 직접 변경 (changes: {start?, due?, time?}).
    // 없는 필드는 새로 추가하고, time 에 null 을 주면 시각을 제거한다.
    async function applyDates(task, changes) {
        // ★ 쓰기의 유일한 길목이다. dropOnDate·dropOnTime·writeBack·리사이즈가 전부 여기로
        //   흐르므로, 개별 어포던스 가드를 하나 빠뜨려도 GCal 일정이 노트를 고칠 수는 없다.
        if (isRO(task)) return;
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
        area.addEventListener("drop", async (e) => { e.preventDefault(); const t = takeDrag(); if (t) await dropOnDate(t, addDays(weekStartISO, colAt(e.clientX)), e.shiftKey); });

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
        // uid 를 쓴다. 일정은 path·line 이 null 이라 예전 키로는 전부 한 값으로 뭉쳐
        // 여러 주에 걸친 일정 막대가 주마다 레인을 갈아탄다. task 의 uid 는 path+line 이므로
        // 결과 문자열이 예전과 바이트 동일이다(동작 변화 없음).
        const memoKey = (t) => t.uid;
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
        return Math.max(laneEnd.length, 1) * laneH;
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

    /** 항목이 차지하는 날짜 구간 [from, to]. 둘 다 없으면 null (= 날짜 없음). */
    const spanOf = (t) => {
        const a = t.start || t.due;
        const b = t.due || t.start;
        if (!a || !b) return null;
        return a <= b ? [a, b] : [b, a];
    };
    const coversDay = (t, iso) => { const s = spanOf(t); return !!s && s[0] <= iso && iso <= s[1]; };
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
        el.style.cssText =
            "display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 10px;margin-bottom:6px;" +
            "border:1px solid var(--background-modifier-border);border-left:4px solid " + colorOf(item) + ";" +
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
     * 칸을 탭하면 그 날의 일간 타임라인으로 넘어간다.
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
            const cell = grid.createEl("div");
            cell.style.cssText =
                "min-height:44px;padding:3px 2px;border-radius:6px;cursor:pointer;text-align:center;" +
                "border:1px solid " + (isToday ? "var(--interactive-accent)" : "transparent") + ";" +
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
            // 칸을 탭하면 그 날의 일간 타임라인으로 간다 — 종일/시각이 갈려 보이고 시각도 줄 수 있다.
            cell.onclick = () => { view = d.startOf("day"); mode = "day"; render(); };
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

    function renderMobileDay(box, items) {
        const iso = view.toISODate();
        // 데스크탑 renderDay 와 같은 기준: 이 날에 걸친 것(기간의 어느 하루라도 이 날이면)
        const onDay = items.filter((t) => t.due && (t.start || t.due) <= iso && t.due >= iso);
        const timed = onDay.filter((t) => t.tStart !== null);
        const allday = onDay.filter((t) => t.tStart === null);

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
            chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;font-size:12px;" +
                "border-radius:8px;cursor:pointer;max-width:100%;" +
                "background:" + c + "2b;border:1px solid " + c + ";border-left:4px solid " + c + ";" +
                (dim ? "opacity:.55;text-decoration:line-through;" : "");
            const lbl = chip.createEl("span", { text: (isRO(t) ? "📆 " : "") + (t.title || "(제목 없음)") });
            lbl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            chip.onclick = (e) => { e.stopPropagation(); openSheet(t); };
        }

        // ── 시간 그리드 ──
        // **안쪽 스크롤 박스를 만들지 않는다.** 폰에서 중첩 스크롤은 노트 스크롤과 싸운다.
        // 대신 그릴 시간대를 좁힌다 — 기본 08~20시, 항목이나 현재 시각이 벗어나면 그만큼 넓힌다.
        const fullDay = !!S.mFull;
        let h0 = 24, h1 = 0;
        for (const t of timed) {
            h0 = Math.min(h0, Math.floor(t.tStart / 60));
            h1 = Math.max(h1, Math.ceil(t.tEnd / 60));
        }
        if (iso === todayISO) { const nh = L.now().hour; h0 = Math.min(h0, nh); h1 = Math.max(h1, nh + 1); }
        if (h0 > h1) { h0 = 8; h1 = 20; }                      // 이 날에 아무것도 없을 때
        h0 = fullDay ? 0 : Math.max(0, Math.min(h0, 8));
        h1 = fullDay ? 24 : Math.min(24, Math.max(h1, 20));

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
                toHHMM(t.tStart) + " " + (ro ? "📆 " : (t.cancelled ? "✗ " : t.done ? "✓ " : "")) +
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

        // 모드는 데스크탑과 같은 S.mode 를 쓴다(기기를 옮겨도 보던 단위가 유지된다).
        // 다만 모바일에는 주간이 없다 — 폰 폭에서 7칸 막대는 글자가 안 들어간다.
        const dayMode = mode === "day";

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
        navBtn("오늘", () => {
            view = dayMode ? L.now().startOf("day") : L.now().startOf("month");
            render();
        });
        for (const [m, text] of [["month", "월간"], ["day", "일간"]]) {
            navBtn(text, () => {
                if (mode === m) return;
                // 월간 → 일간은 오늘로 연다. 보던 달의 1일로 열면 대개 지난 날이 나온다.
                view = m === "day" ? L.now().startOf("day") : view.startOf("month");
                mode = m;
                render();
            }, mode === m ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;");
        }
        navBtn(showDone ? "완료 ✓" : "완료 ✗", () => { showDone = !showDone; render(); });

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

        // ── 본문 ──
        if (dayMode) {
            // 트레이(날짜 없음·지연)는 월간에만 둔다. 폰에서는 세로가 전부라, 24시간
            // 그리드 위에 트레이가 얹히면 타임라인에 닿기까지 한참을 스크롤해야 한다.
            renderMobileDay(box, shown);
            const back = box.createEl("div");
            back.style.cssText = "font-size:11px;opacity:.5;margin-top:10px;";
            back.setText("📥 날짜 없음 " + open.filter((t) => !t.due && !t.start).length +
                " · 🔴 지연 " + open.filter((t) => t.due && t.due < todayISO).length + " — 「월간」에서 볼 수 있습니다");
        } else {
            mobileMonthGrid(box, shown);

            const undated = open.filter((t) => !t.due && !t.start);
            mobileSection(box, "📥 날짜 없음 (" + undated.length + ")", undated, "없음 🎉");

            const overdue = open.filter((t) => t.due && t.due < todayISO).sort((a, b) => (a.due < b.due ? -1 : 1));
            mobileSection(box, "🔴 지연 (" + overdue.length + ")", overdue, "없음 🎉");

            // 이 달의 날짜별. 위 지연 섹션에 이미 나온 것은 빼서 한 화면에 두 번 나오지 않게 한다.
            // (데스크탑은 트레이와 달력이 시각적으로 분리돼 있어 중복이 문제가 안 되지만,
            //  평평한 목록에서는 그냥 버그로 보인다.)
            const seen = new Set(overdue.map((t) => t.uid));
            const ym = view.toFormat("yyyy-MM");
            const byDay = new Map();
            for (const t of shown) {
                if (!t.due || seen.has(t.uid)) continue;
                if (t.due.slice(0, 7) !== ym) continue;
                if (!byDay.has(t.due)) byDay.set(t.due, []);
                byDay.get(t.due).push(t);
            }
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

/**
 * 모바일 액션시트 — 목록의 항목을 탭하면 뜬다.
 *
 * 데스크탑에서 **드래그 · Shift+드래그 · 우클릭**이 하던 일을 전부 버튼으로 편 것이다.
 * 터치에서는 그 셋이 이벤트조차 발생하지 않으므로(HTML5 DnD 는 터치에서 안 뜨고
 * contextmenu 도 없다), 폰에서 task 를 고칠 수 있는 유일한 통로다.
 *
 * ⛔ 여기서 노트를 직접 고치지 않는다. 쓰기는 전부 createCalendar 가 넘겨준 함수로
 *    흘려보낸다. 특히 ⏰ 는 반드시 applyDates 의 time 경로를 타야 한다 — 첫 Tasks 필드
 *    이모지 **앞에** 넣는 규칙이 거기에만 있고, 줄 끝에 붙이면 Tasks 가 그 앞의 📅 까지
 *    설명으로 흡수한다(마감일 쿼리가 그 task 를 놓친다).
 */
class TaskSheetModal extends Modal {
    constructor(app, task, ctx) {
        super(app);
        this.task = task;
        this.ctx = ctx;
    }

    /** 구역 제목 한 줄. */
    section(text) {
        const h = this.contentEl.createEl("div", { text });
        h.style.cssText = "font-size:12px;opacity:.6;margin:16px 0 6px;";
        return h;
    }

    /** 손가락에 맞는 컨트롤 한 줄. */
    row() {
        const r = this.contentEl.createEl("div");
        r.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;";
        return r;
    }

    /** 누르면 실행하고 닫는 버튼. 실패해도 닫는다 — 실패는 Notice 가 말한다. */
    btn(parent, label, run, extraCss) {
        const b = parent.createEl("button", { text: label });
        b.style.cssText = "min-height:40px;padding:0 14px;border-radius:8px;font-size:14px;cursor:pointer;" + (extraCss || "");
        b.onclick = async () => {
            try { await run(); } finally { this.close(); }
        };
        return b;
    }

    /** 날짜 선택기. 고르는 즉시 실행하고 닫는다(확인 버튼을 한 번 더 누르게 하지 않는다). */
    datePicker(parent, value, run) {
        const d = parent.createEl("input");
        d.type = "date";
        d.value = value || "";
        d.style.cssText = "min-height:40px;font-size:14px;padding:0 8px;border-radius:8px;";
        d.onchange = async () => {
            if (!d.value) return;
            try { await run(d.value); } finally { this.close(); }
        };
        return d;
    }

    onOpen() {
        const t = this.task;
        const c = this.ctx;
        const { contentEl } = this;
        contentEl.empty();

        // ── 머리: 무엇을 고치고 있는지 ──
        const head = contentEl.createEl("div");
        head.style.cssText = "display:flex;gap:10px;align-items:flex-start;border-left:4px solid " +
            c.colorOf(t) + ";padding-left:10px;margin-bottom:4px;";
        const hbox = head.createEl("div");
        const title = hbox.createEl("div", { text: t.title || "(제목 없음)" });
        title.style.cssText = "font-size:16px;font-weight:600;line-height:1.4;word-break:break-word;";
        const meta = hbox.createEl("div", { text: c.metaLine(t) });
        meta.style.cssText = "font-size:12px;opacity:.6;margin-top:4px;word-break:break-all;";

        // GCal 일정은 노트에 원본이 없다 — 고칠 것도, 열 곳도 없다.
        if (c.isRO(t)) {
            const p = contentEl.createEl("div", { text: "📆 Google Calendar 일정입니다 (읽기 전용)." });
            p.style.cssText = "font-size:13px;opacity:.7;margin-top:14px;";
            return;
        }

        // ── 📅 마감일 ── 가장 흔한 동작이라 맨 위에 둔다.
        this.section("📅 마감일" + (t.due ? " — 지금 " + t.due : " — 없음"));
        const due = this.row();
        this.btn(due, "오늘", () => c.writeBack(t, c.todayISO));
        this.btn(due, "내일", () => c.writeBack(t, c.addDays(c.todayISO, 1)));
        this.btn(due, "+7일", () => c.writeBack(t, c.addDays(c.todayISO, 7)));
        this.datePicker(due, t.due || c.todayISO, (iso) => c.writeBack(t, iso));

        // ── 🛫 시작일 ── 마감일이 있어야 의미가 있다(기간의 왼쪽 끝이므로).
        if (t.due) {
            this.section("🛫 시작일" + (t.start ? " — 지금 " + t.start : " — 없음"));
            const st = this.row();
            this.datePicker(st, t.start || t.due, async (iso) => {
                // applyDates 는 start 를 그대로 쓴다 — start > due 를 만들면 막대 폭이 음수가 된다.
                // 데스크탑에서는 드롭 좌표가 이 조건을 막아 주지만 여기서는 날짜를 직접 고르므로 우리가 막는다.
                if (t.due && iso > t.due) { c.notice("시작일은 마감일(📅 " + t.due + ")보다 뒤일 수 없어요"); return; }
                await c.applyDates(t, { start: iso });
                c.notice("🛫 " + iso);
            });
        }

        // ── 기간째 이동 ── 데스크탑의 "그냥 드래그" 와 같은 동작.
        //    🛫 가 없으면 마감일 지정과 결과가 같아지므로(dropOnDate 내부 분기), 그때는 숨긴다.
        if (t.start && t.due && t.start !== t.due) {
            this.section("↔ 기간째 이동 — 고른 날이 🛫 가 되고 기간 길이는 유지됩니다");
            const mv = this.row();
            this.datePicker(mv, t.start, (iso) => c.dropOnDate(t, iso, false));
        }

        // ── ⏰ 시각 ── 데스크탑에서는 일간 보기 드래그로만 넣던 값.
        //
        // **시작 하나 + 길이 버튼**이다. 종료 시각 선택기를 나란히 두면 폰에서 시각 롤러를
        // 두 번 씨름해야 하는데, 실제로 하는 일은 대개 "이 시각부터 30분" 하나다.
        // 길이 버튼은 누르는 즉시 저장한다 — 탭 두 번이면 끝난다.
        this.section("⏰ 시각" + (t.tStart !== null ? " — 지금 " + c.timeText(t.tStart, t.tEnd) : " — 없음"));
        const mkTime = (parent, val) => {
            const i = parent.createEl("input");
            i.type = "time";
            i.step = "900";   // 15분 — 데스크탑 드래그의 스냅 단위와 맞춘다
            i.value = val;
            i.style.cssText = "min-height:40px;font-size:14px;padding:0 8px;border-radius:8px;";
            return i;
        };
        // 기본 시작: 이미 있으면 그 값, 없으면 지금을 15분 위로 올린 값
        // (폰에서 시각을 주는 상황은 대개 "지금부터" 다).
        const nowUp = Math.min(1440 - 15, Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 15) * 15);
        const s0 = t.tStart !== null ? t.tStart : nowUp;

        const tr = this.row();
        const si = mkTime(tr, c.toHHMM(s0));
        // 길이 버튼. 시각이 이미 있는 task 면 **시작은 그대로, 길이만** 바뀐다
        // (데스크탑의 「블록 아랫끝 드래그 = 종료 시각」에 해당).
        const setLen = async (len) => {
            if (!si.value) { c.notice("시작 시각을 고르세요"); return; }
            const st = c.toMin(si.value);
            await c.applyDates(t, { time: c.timeText(st, Math.min(1440, st + len)) });
            c.notice("⏰ " + c.timeText(st, Math.min(1440, st + len)));
        };
        for (const [label, len] of [["15분", 15], ["30분", 30], ["1시간", 60]]) {
            this.btn(tr, label, () => setLen(len), "font-weight:600;");
        }

        // 임의 길이(2시간·90분)는 접어 둔다 — 흔하지 않은데 자리를 많이 먹는다.
        // 시작 선택기는 위의 것을 그대로 쓴다(값이 갈리지 않게).
        const det = this.contentEl.createEl("details");
        det.style.cssText = "margin-top:8px;";
        const sum = det.createEl("summary", { text: "직접 입력" });
        sum.style.cssText = "font-size:12px;opacity:.6;cursor:pointer;";
        const dr = det.createEl("div");
        dr.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;";
        dr.createEl("span", { text: "종료" }).style.cssText = "font-size:12px;opacity:.6;";
        const ei = mkTime(dr, c.toHHMM(t.tStart !== null ? t.tEnd : s0 + 60));
        this.btn(dr, "저장", async () => {
            if (!si.value || !ei.value) { c.notice("시작·종료 시각을 모두 고르세요"); return; }
            const st = c.toMin(si.value);
            let e = c.toMin(ei.value);
            if (e <= st) e = Math.min(1440, st + 60);   // 역전·0길이는 막대 높이가 0/음수가 된다
            await c.applyDates(t, { time: c.timeText(st, e) });
            c.notice("⏰ " + c.timeText(st, e));
        }, "font-weight:600;");

        if (t.tStart !== null) {
            const rm = this.row();
            this.btn(rm, "시각 제거", async () => {
                await c.applyDates(t, { time: null });
                c.notice("⏰ 제거됨");
            });
        }

        // ── 그 밖 ──
        this.section("그 밖");
        const etc = this.row();
        this.btn(etc, "✏️ 편집", () => c.editTask(t));
        this.btn(etc, "📄 원본 열기", () => c.openAtLine(t));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class GcalCalendarSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** 복사 버튼이 달린 코드 샘플 한 덩어리. 설정 화면에서 바로 집어 갈 수 있게 한다. */
    sample(parent, label, code) {
        const box = parent.createEl("div");
        box.style.cssText = "margin:0 0 10px;";
        const head = box.createEl("div");
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:3px;";
        const cap = head.createEl("span", { text: label });
        cap.style.cssText = "font-size:11px;opacity:.6;";
        const btn = head.createEl("button", { text: "복사" });
        btn.style.cssText = "font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;";
        btn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(code);
                btn.setText("복사됨");
                setTimeout(() => btn.setText("복사"), 1200);
            } catch (e) {
                new Notice("복사 실패: " + e.message);
            }
        };
        const pre = box.createEl("pre");
        pre.style.cssText =
            "font-size:11px;padding:8px;border-radius:4px;background:var(--background-secondary);" +
            "margin:0;white-space:pre;overflow-x:auto;user-select:text;";
        pre.setText(code);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        // ── 사용법: 편집 대상이 아니라 붙박이 설명이다 ──
        // 예전에는 이 내용을 노트마다 콜아웃으로 복붙해 뒀다. 노트에서 지우면 조작법을
        // 어디서도 찾을 수 없게 되므로, 잊어버리지 않게 설정 화면 맨 위에 박아 둔다.
        containerEl.createEl("h3", { text: "사용법" });
        const usage = containerEl.createEl("div");
        usage.style.cssText = "font-size:12px;line-height:1.7;opacity:.85;";
        usage.createEl("p", { text: "노트에 코드블록으로 넣는다:" }).style.margin = "0 0 6px";

        this.sample(usage, "이 노트가 놓인 폴더 이하 (기본)", "```gcal-calendar\n```");
        this.sample(usage, "볼트 전체", "```gcal-calendar\nscope: vault\n```");
        this.sample(
            usage,
            "소스 쿼리 직접 지정 · 이 블록에만 붙일 설명(여러 줄, 마크다운)",
            "```gcal-calendar\n" +
                'source: "0. Note/1. Project" and !"Template"\n' +
                "note: - 이 프로젝트의 할 일만 모읍니다.\n" +
                "note: - **마감 임박**한 것부터 처리할 것.\n" +
                "note: - 배경은 [[프로젝트 개요]] 참고.\n" +
                "```"
        );
        this.sample(
            usage,
            "이 블록에 그릴 Google Calendar 일정 고르기 (#gcal/ 태그와 같은 이름, 쉼표로 구분)",
            "```gcal-calendar\ngcal: Growth, Routine\n```"
        );
        this.sample(
            usage,
            "특정 캘린더만 빼기 · 이 블록에서는 일정을 아예 안 그리기(task 전용)",
            "```gcal-calendar\ngcal-exclude: Event\n```\n\n" +
                "```gcal-calendar\ngcal: off\n```"
        );

        const ul = usage.createEl("ul");
        ul.style.cssText = "margin:0 0 4px;padding-left:18px;";
        for (const t of [
            "태스크는 기간 막대(🛫 start ~ 📅 due)로 표시. start 없으면 due 하루짜리 막대.",
            "막대·트레이 카드를 날짜로 드래그 = 기간째 이동(놓은 칸 = 🛫 시작일, 없으면 📅 마감일).",
            "Shift + 드래그 = 📅 마감일만 조정 (🛫 없으면 생성).",
            "일간 보기: 블록 드래그 = 시각 이동(15분 단위) · 아래끝 드래그 = 종료 시각 · 종일 줄 ↔ 그리드 = 시각 부여/제거.",
            "일간 보기에서 끌면 착지 지점에 그림자와 시각 배지가 뜬다 — 마우스 커서가 아니라 그 그림자에 맞춰 놓는다.",
            "클릭 = 원본 열기(현재 탭) · Ctrl+클릭 = 새 탭 · Ctrl+Shift+클릭 = 분할 창 · 우클릭 = Tasks 편집 모달.",
            "📥 날짜 없음 / 🔴 지연 카드의 빠른 버튼·날짜선택기로도 마감일 변경.",
            "카테고리 필터의 «전체» 버튼은 토글이다 — 다 켜져 있으면 «전체 해제», 비우고 볼 것만 켜면 된다.",
            "변경은 노트에 바로 쓰이고 tasks-gcal-sync 가 Google Calendar 로 올린다.",
            "시각(⏰)은 일간 보기 드래그로만 넣는다 — 줄 끝에 적으면 Tasks 가 📅 까지 못 읽는다.",
            "📆 는 Google Calendar 일정(읽기 전용)이다 — 드래그·클릭·편집이 되지 않는다. 색은 같은 이름의 카테고리를 따른다.",
            "gcal: / gcal-exclude: 의 값은 #gcal/ 태그와 같은 캘린더 이름이다. 동기화 플러그인 설정에서 고른 캘린더의 부분집합이라, 여기 적었다고 안 고른 캘린더를 가져오지는 않는다.",
        ]) {
            ul.createEl("li", { text: t });
        }

        // ── 모바일 화면 ──
        // 사용법 바로 밑에 둔다. 폰에서 화면이 달라 보이는 이유를 여기서 처음 만나야 한다.
        containerEl.createEl("h3", { text: "모바일" });
        new Setting(containerEl)
            .setName("모바일 화면")
            .setDesc(
                "폰에서는 드래그·우클릭이 터치에서 동작하지 않아 조작이 불가능합니다. " +
                "모바일 화면은 월간 요약과 날짜별 목록으로 그리고, 항목을 탭하면 뜨는 " +
                "액션시트에서 마감일·시작일·시각을 고칩니다. " +
                "«자동» 은 폰에서만 켜집니다 — 태블릿은 폰으로 잡히지 않으니 «항상» 을 쓰세요."
            )
            .addDropdown((d) => {
                d.addOption("auto", "자동 (폰에서만)");
                d.addOption("always", "항상");
                d.addOption("off", "끄기");
                d.setValue(this.plugin.settings.mobileUi || "auto");
                d.onChange(async (v) => {
                    this.plugin.settings.mobileUi = v;
                    await this.plugin.saveSettings();
                    this.plugin.refreshAll();   // 설정 창을 닫기 전에 바로 보이게 (hide() 를 기다리지 않는다)
                });
            });

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
            // 폰에서는 [key][표시 이름][색][🗑] 넷이 한 줄에 들어가면 입력칸이 수십 px 로
            // 찌그러져 타이핑이 안 된다. 폭이 좁을 때만 세로로 쌓는다(데스크탑은 그대로).
            if (Platform.isPhone) {
                row.settingEl.style.cssText = "display:block;padding:8px 0;";
                row.controlEl.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;";
            }
            row.addText((t) => {
                if (Platform.isPhone) t.inputEl.style.cssText = "flex:1 1 100%;min-width:0;";
                t.setPlaceholder("key (예: work)").setValue(cat.key).onChange(async (v) => {
                    cat.key = v.trim();
                    await this.plugin.saveSettings();
                });
            });
            row.addText((t) => {
                if (Platform.isPhone) t.inputEl.style.cssText = "flex:1 1 100%;min-width:0;";
                t.setPlaceholder("표시 이름").setValue(cat.label).onChange(async (v) => {
                    cat.label = v;
                    await this.plugin.saveSettings();
                });
            });
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

        // ── GCal 일정 캘린더 ──
        // 색은 전부 여기 있다. 어느 캘린더를 가져올지는 tasks-gcal-sync 가 정하고,
        // 어떻게 그릴지는 여기서 정한다 — 카테고리 색 바로 아래라 눈으로 맞출 수 있다.
        containerEl.createEl("h3", { text: "GCal 일정 캘린더 (읽기 전용)" });
        containerEl.createEl("p", {
            text:
                "tasks-gcal-sync 설정의 «캘린더 뷰에 표시할 일정» 에서 고른 캘린더의 회의·약속이 " +
                "📆 로 그려집니다. 기본은 같은 이름의 카테고리 색을 따르므로 (예: Growth 캘린더 → " +
                "위의 growth 카테고리), 보통은 손댈 게 없습니다.",
            cls: "setting-item-description",
        });

        const feed = this.plugin.gcalFeed();
        const sel = feed ? feed.listSelectedCalendars() : [];
        if (!sel.length) {
            containerEl.createEl("p", {
                text: feed
                    ? "고른 캘린더가 없습니다. tasks-gcal-sync 설정 → «캘린더 뷰에 표시할 일정» 에서 고르세요."
                    : "tasks-gcal-sync 가 없거나(모바일·미설치) 아직 인증/선택 전입니다.",
                cls: "setting-item-description",
            });
        }

        const catColor = categoryColorMap(this.plugin.settings);
        for (const c of sel) {
            const info = resolveEventColorInfo(this.plugin.settings, catColor, c.id, c.name);
            const own = okHex((this.plugin.settings.eventColors || {})[c.id]);
            new Setting(containerEl)
                .setName(c.name)
                .setDesc(`${info.source} ${info.color}`)
                .addColorPicker((p) =>
                    // 따르는 중이어도 **실제로 그려질 색**을 보여준다. 여기 보이는 색과
                    // 화면의 막대 색이 다르면 그것만으로 버그다.
                    p.setValue(info.color).onChange(async (v) => {
                        this.plugin.settings.eventColors = {
                            ...(this.plugin.settings.eventColors || {}),
                            [c.id]: v,
                        };
                        await this.plugin.saveSettings();
                        this.display();
                    })
                )
                .addExtraButton((b) =>
                    b
                        .setIcon("rotate-ccw")
                        .setTooltip("카테고리 색으로 되돌리기")
                        .setDisabled(!own)
                        .onClick(async () => {
                            const next = { ...(this.plugin.settings.eventColors || {}) };
                            delete next[c.id];
                            this.plugin.settings.eventColors = next;
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );
        }

        new Setting(containerEl)
            .setName("기본 색")
            .setDesc("같은 이름의 카테고리가 없는 캘린더에 쓰입니다 (예: Holidays in South Korea).")
            .addColorPicker((p) =>
                p.setValue(okHex(this.plugin.settings.eventColor) || "#7f8c8d").onChange(async (v) => {
                    this.plugin.settings.eventColor = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addExtraButton((b) =>
                b
                    .setIcon("rotate-ccw")
                    .setTooltip("기본값(#7f8c8d)으로 되돌리기")
                    .onClick(async () => {
                        this.plugin.settings.eventColor = DEFAULT_SETTINGS.eventColor;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );
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

        // ── 커맨드 ──
        // 여태 하나도 없었다 — 폰에서는 커맨드 팔레트가 주된 진입로인데 이 플러그인은
        // 코드블록이 적힌 노트를 찾아가는 것 말고는 부를 방법이 없었다.

        // 폰에서 백틱 세 개와 블록 이름을 손으로 치는 게 가장 힘든 지점이다.
        this.addCommand({
            id: "insert-block",
            name: "캘린더 블록 삽입",
            editorCallback: (editor) => {
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
                const label = { auto: "자동 (폰에서만)", always: "항상", off: "끄기" };
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
            const a = this.app.plugins?.plugins?.["tasks-gcal-sync"]?.api;
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
        const ref = this.app.metadataCache.on("dataview:metadata-change", () => {
            if (cal.isAlive()) cal.refresh();
        });
        child.register(() => this.app.metadataCache.offref(ref));
    }
};

// 순수 함수만 테스트에서 꺼내 쓴다(스코프 결정은 노트 위치에 따라 갈리는 유일한 분기다).
// Obsidian 은 module.exports 의 기본 export 만 보므로 이 속성은 무해하다.
module.exports.__test = { parseOptions, resolveSource, parseList, resolveCalFilter, resolveEventColorInfo, categoryColorMap, layoutTimeLanes, DEFAULT_SETTINGS };
