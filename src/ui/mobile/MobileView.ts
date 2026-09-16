/*
 * 모바일 화면 — 트레이 카드 · 월간 점 그리드 · 날짜별 목록 · 일간 타임라인. 본문은
 * createCalendar 에서 **그대로** 옮겼다(0.7.4).
 *
 * 규칙 셋(0.3.0~): 드래그 없음 · 우클릭 없음 · 중첩 스크롤 없음. 모든 수정은 행을 탭해 여는
 * 액션시트(TaskSheetModal)로 간다 — 쓰기 경로는 데스크탑과 **같은** writer 를 쓴다.
 */
import { Notice } from "obsidian";
import { CalItem, Categories, catKey, El, itemColor, ViewCtx } from "../types";
import { byDayOrder, isRO } from "../../core/order";
import { layoutTimeLanes } from "../../core/timeLanes";
import { addDays, coversDay, diffDays, onDay, sundayStart } from "../../core/dates";
import { timeText, toHHMM, toMin } from "../../core/time";
import { mobileHourRange } from "../mobileHours";
import { TaskSheetModal } from "../TaskSheetModal";
import { dimCss, mobileRowSkinCss, skinCss, timeBlockLabel, titleOf, OVERDUE_RED, SUNDAY_RED, WARN_YELLOW } from "../style";

export function createMobileView(ctx: ViewCtx) {
    const {
        app, plugin, root, L, todayISO,
        S, st, ctrl, activeCats, saveState, syncCategories, collect, render,
        restorePageScroll,
        openAtLine, editTask, applyDates, dropOnDate, writeBack,
        feed, feedPlugin, eventsFor, rangeForView,
        noteMarkdown, noteBlock, CALF,
    } = ctx;
    let CATS: string[] = [];
    let CATLABEL: Record<string, string> = {};
    let CATCOLOR: Record<string, string> = {};
    let CAT_DEFAULT = "";

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

    const colorOf = (t: CalItem) => itemColor(t, CATCOLOR, CAT_DEFAULT, "#7f8c8d");
    const fileName = (p: any) => (p ? p.split("/").pop().replace(/\.md$/, "") : "");
    const metaLine = (t: CalItem) => {
        const bits = [CATLABEL[catKey(t)] || catKey(t) || "-"];
        if (t.path) bits.push("📄 " + fileName(t.path));
        return bits.join("  ·  ");
    };
    const mmdd = (iso: string) => iso.slice(5).replace("-", ".");
    const dateBadge = (t: CalItem) => {
        if (t.start && t.due && t.start !== t.due) return "🛫 " + mmdd(t.start) + " ~ 📅 " + mmdd(t.due);
        if (t.due) return "📅 " + mmdd(t.due);
        if (t.start) return "🛫 " + mmdd(t.start);
        return "";
    };

    /** 액션시트를 연다. 쓰기 함수를 그대로 넘긴다 — 모달은 노트를 직접 고치지 않는다. */
    const openSheet = (t: CalItem) => {
        new TaskSheetModal(app, t, {
            applyDates, dropOnDate, writeBack, editTask, openAtLine,
            isRO, colorOf, metaLine, timeText, toMin, toHHMM, addDays, todayISO,
            notice: (m: any) => new Notice(m),
        }).open();
    };

    /**
     * 목록의 한 줄. **task 와 GCal 일정을 같은 함수로 그린다** — 지금 모바일에는 일정이
     * 오지 않지만(피드가 데스크탑 전용이다), 나중에 넣을 때 목록 코드를 다시 짜지 않으려고
     * 처음부터 isRO 로 갈라 둔다.
     */
    function mobileRow(item: CalItem) {
        const ro = isRO(item);
        const el = document.createElement("div");
        // 📆 읽기 전용은 **데스크탑과 같은 서명**으로 그린다 — 점선 테두리 · 옅은 배경 ·
        // **좌측 레일 없음**(굵은 레일은 task 막대의 서명이다). 0.4.0 은 데이터만 연결하고
        // 이 구분을 빠뜨려서, 탭해 보기 전에는 고칠 수 있는 항목인지 알 수 없었다.
        const c = colorOf(item);
        el.style.cssText =
            "display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 10px;margin-bottom:6px;" +
            mobileRowSkinCss(c, ro) +
            "border-radius:8px;cursor:pointer;";
        const box = el.createEl("div");
        box.style.cssText = "flex:1 1 auto;min-width:0;";
        const ttl = box.createEl("div", { text: (ro ? "📆 " : "") + titleOf(item) });
        ttl.style.cssText = "font-size:14px;line-height:1.35;word-break:break-word;" +
            (item.done || item.cancelled ? "opacity:.5;text-decoration:line-through;" : "");
        const sub = box.createEl("div");
        sub.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;font-size:11px;opacity:.6;margin-top:3px;";
        const badge = dateBadge(item);
        if (badge) sub.createEl("span", { text: badge });
        if (item.tStart !== null && item.tStart !== undefined) sub.createEl("span", { text: "⏰ " + timeText(item.tStart, item.tEnd!) });
        if (item.recurring) sub.createEl("span", { text: "🔁" });
        if (!ro) sub.createEl("span", { text: "📄 " + fileName(item.path) });
        // 지연은 색으로 말한다 — 목록에서 눈에 띄어야 하는 건 이것 하나다.
        if (item.due && !item.done && !item.cancelled) {
            const od = diffDays(todayISO, item.due);
            if (od > 0) {
                const w = sub.createEl("span", { text: od + "일 지남" });
                w.style.cssText = "color:" + WARN_YELLOW + ";font-weight:700;opacity:1;";
            }
        }
        const chev = el.createEl("span", { text: "›" });
        chev.style.cssText = "opacity:.35;font-size:18px;flex:0 0 auto;";
        el.onclick = () => openSheet(item);
        return el;
    }

    /** 제목 + 행들. 비어 있으면 빈 이유를 한 줄로 말한다 (빈 화면은 고장과 구분되지 않는다). */
    function mobileSection(box: El, label: string, items: CalItem[], emptyText?: string) {
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
    function mobileMonthGrid(box: El, items: CalItem[]) {
        const first = st.view.startOf("month");
        const gridStart = sundayStart(first);
        const gridEnd = sundayStart(first.endOf("month")).plus({ days: 6 });
        const wrap = box.createEl("div");
        wrap.style.cssText = "margin-bottom:12px;";
        const head = wrap.createEl("div");
        head.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:2px;";
        ["일", "월", "화", "수", "목", "금", "토"].forEach((d, i) => {
            const c = head.createEl("div", { text: d });
            c.style.cssText = "text-align:center;font-size:10px;opacity:.5;" + (i === 0 ? "color:" + SUNDAY_RED + ";" : "");
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
            const cols: string[] = [];
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
    function mobileTrays(box: El, open: CalItem[]) {
        const card = (title: string, items: CalItem[], empty: any, accent: string) => {
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
            open.filter((t: CalItem) => !t.due), "없음 🎉", "");
        const overdue = open
            .filter((t: CalItem) => t.due && t.due < todayISO)
            .sort((a: any, b: any) => (a.due < b.due ? -1 : 1));
        card("🔴 지연 (" + overdue.length + ")", overdue, "없음 🎉", OVERDUE_RED);
    }

    function renderMobileDay(box: El, items: CalItem[]) {
        const iso = st.view.toISODate();
        // 데스크탑 renderDay 와 같은 기준: 이 날에 걸친 것(기간의 어느 하루라도 이 날이면)
        const today = items.filter((t: CalItem) => onDay(t, iso));
        const timed = today.filter((t: CalItem) => t.tStart !== null);
        // 종일 줄 안에서도 📆 일정이 먼저 — 데스크탑 renderDay 와 같은 규칙
        const allday = today.filter((t: CalItem) => t.tStart === null).sort(byDayOrder);

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
                skinCss(c, ro) + dimCss(dim);
            const lbl = chip.createEl("span", { text: (ro ? "📆 " : "") + titleOf(t) });
            lbl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            chip.onclick = (e: any) => { e.stopPropagation(); openSheet(t); };
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
                    ((m - h0 * 60) / 60 * M_HOUR_H) + "px;border-top:2px solid " + OVERDUE_RED + ";z-index:3;pointer-events:none;";
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
                skinCss(c, ro) +
                "border-radius:6px;padding:2px 6px;font-size:11px;line-height:1.3;overflow:hidden;cursor:pointer;" +
                dimCss(dim);
            blk.appendChild(document.createTextNode(timeBlockLabel(t, ro, timeText(t.tStart, t.tEnd))));
            // 블록 탭은 그리드까지 내려가면 안 된다 — 배치 중이라면 제 위에 자기를 놓게 된다.
            blk.onclick = (e: any) => { e.stopPropagation(); openSheet(t); };
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
        const first = ctrl.takeFirstRender();
        // 분리된 DOM 에 조립한 뒤 한 번에 교체 — 데스크탑 경로와 같은 이유(빈 프레임 방지).
        const box = document.createElement("div");
        const noteMd = noteMarkdown();
        if (noteMd) box.appendChild(noteBlock(noteMd));

        const all = collect().filter((t) => activeCats.has(catKey(t)));
        const open = all.filter((t) => !t.done && !t.cancelled);
        const shown = st.showDone ? all : open;

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
        const dayMode = st.mode === "day";
        // 고른 날은 **보고 있는 달 안에 있을 때만** 유효하다. ◀▶ 로 달을 넘기면
        // 그리드에 없는 날의 카드만 떠 있는 상태가 되므로 그때는 없는 것으로 친다.
        const selDay = !dayMode && S.mDay && S.mDay.slice(0, 7) === st.view.toFormat("yyyy-MM") ? S.mDay : null;

        // ── 헤더: 이동 · 오늘 · 월간/일간 · 완료 토글 ──
        const bar = box.createEl("div");
        bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;";
        const navBtn = (label: string, fn: any, extra?: any) => {
            const b = bar.createEl("button", { text: label });
            b.style.cssText = "min-height:36px;padding:0 12px;border-radius:8px;font-size:13px;cursor:pointer;" + (extra || "");
            b.onclick = fn;
            return b;
        };
        navBtn("◀", () => {
            st.view = dayMode ? st.view.minus({ days: 1 }) : st.view.startOf("month").minus({ months: 1 });
            render();
        });
        const lab = bar.createEl("b", {
            text: dayMode ? st.view.toFormat("M월 d일") + " (" + WD[st.view.weekday % 7] + ")" : st.view.toFormat("yyyy년 M월"),
        });
        lab.style.cssText = "font-size:15px;flex:1 1 auto;text-align:center;";
        navBtn("▶", () => {
            st.view = dayMode ? st.view.plus({ days: 1 }) : st.view.startOf("month").plus({ months: 1 });
            render();
        });
        // 「오늘로」는 한 곳에 모은다 — 「오늘」 버튼과 보기 전환 버튼이 같은 자리로 간다.
        // 월간은 이번 달을 열면서 **오늘을 고른 상태**로 둬서 아래 목록이 곧바로 오늘
        // 카드가 된다. 달만 맞추면 그리드에서 오늘을 한 번 더 찾아 탭해야 하고,
        // 그 사이에 이 달 전체 목록이 한 번 펼쳐진다.
        const goToday = (m: any) => {
            if (m === "day") {
                st.view = L.now().startOf("day");
            } else {
                st.view = L.now().startOf("month");
                S.mDay = todayISO;
            }
            st.mode = m;
            render();
        };

        // 「오늘」은 **보고 있는 쪽을 그대로 두고** 오늘로만 돌아온다.
        navBtn("오늘", () => goToday(st.mode === "day" ? "day" : "month"));

        // 보기 전환도 오늘 기준으로 연다. 이미 그 보기에 있어도 되돌린다(early return 없음) —
        // 예전 「오늘」 버튼이 이미 이번 달일 때 아무것도 안 해서 반응이 없던 것과 같은 함정이다.
        for (const [m, text] of [["month", "월간"], ["day", "일간"]]) {
            navBtn(text, () => goToday(m),
                st.mode === m ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;");
        }
        navBtn(st.showDone ? "완료 ✓" : "완료 ✗", () => { st.showDone = !st.showDone; render(); });
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
                "opacity:" + (st.showEvents ? 1 : 0.4) + ";";
            // ⚠️ 꺼져 있으면 `eventsFor` 가 []를 돌려준다 — 그때 건수를 적으면 "0건" 으로
            //    오해된다. 켜져 있을 때만 숫자를 붙인다.
            eb.createEl("span", {
                text: st.showEvents ? "📅 일정 " + evItems.length : "📅 일정",
            });
            eb.onclick = () => { st.showEvents = !st.showEvents; render(); };
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
            const ym = st.view.toFormat("yyyy-MM");
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
                mobileSection(box, st.view.toFormat("yyyy년 M월"), [], "이 달에 마감일이 있는 항목이 없습니다.");
            } else {
                for (const iso of days) {
                    const wd = ["일", "월", "화", "수", "목", "금", "토"][L.fromISO(iso).weekday % 7];
                    const mark = iso === todayISO ? "  ← 오늘" : "";
                    mobileSection(box, mmdd(iso) + " (" + wd + ")" + mark, byDay.get(iso));
                }
            }
        }

        // ── 조립 끝 ──
        root.replaceChildren(...(box.childNodes as any));
        ctrl.holdHeight(root.offsetHeight);
        if (first) restorePageScroll();
    }

    return {
        setCategories: (v: Categories) => { ({ CATS, CATLABEL, CATCOLOR, CAT_DEFAULT } = v); },
        renderMobileNow,
    };
}
