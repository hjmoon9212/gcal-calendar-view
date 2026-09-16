/*
 * 데스크탑 화면 — 트레이 · 툴바 · 카테고리 칩 · 월/주/일 달력. 본문은 createCalendar 에서
 * **그대로** 옮겼다(0.7.4). 조작이 전부 HTML5 드래그와 우클릭이라 터치에서는 쓸 수 없다
 * (폰 화면은 ui/mobile/MobileView.js).
 *
 * 값은 ctx 로 받는다 — 상태(ctrl.st)·쓰기(writer)·피드는 전부 바깥이 들고 있고, 여기서는
 * 그리기만 한다. 카테고리 네 값만 매 렌더 새로 오므로 setCategories 로 갈아 끼운다.
 */
import { Notice } from "obsidian";
import { byDayOrder, isRO } from "../../core/order";
import { layoutTimeLanes } from "../../core/timeLanes";
import { addDays, diffDays, onDay, sundayStart } from "../../core/dates";
import { DEFAULT_MIN, SNAP_MIN, snapMin, timeText, toHHMM } from "../../core/time";
import { calKey } from "../../core/blockOptions";
import { layoutWeekBars } from "../lanes";
import { barLabel, barTooltip, dayChipLabel, dayChipTooltip, dimCss, grabCss, skinCss, timeBlockLabel, timeBlockTooltip, titleOf, weekdayColor, OVERDUE_RED, WARN_YELLOW } from "../style";

export function createDesktopView(ctx) {
    const {
        app, plugin, root, L, todayISO, CALF,
        S, st, ctrl, activeCats, saveState, syncCategories, collect, render, takeDrag,
        restorePageScroll, rememberScroll,
        openAtLine, editTask, applyDates, dropOnDate, dropOnTime, writeBack, openMode, writer,
        feed, feedPlugin, eventsFor, passesCalFilter, rangeForView,
        noteMarkdown, noteBlock, attachDrop,
        HOUR_H, DAY_BOX_H, GUTTER,
    } = ctx;
    // 매 렌더 새로 오는 값(설정에서 바뀔 수 있다)
    let CATS = [], CATLABEL = {}, CATCOLOR = {}, CAT_DEFAULT = "";

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
            bar.title = barTooltip(t, ro, dim);
            // 일정은 더 옅은 배경 · 점선 테두리 · 굵은 좌측 레일 없음 · 커서 default 로
            // "잡을 수 없는 것" 임을 알린다. 레일은 task 막대의 서명이라 일정에는 주지 않는다.
            bar.style.cssText = `position:absolute;left:calc(${b.sCol / 7 * 100}% + 2px);width:calc(${(b.eCol - b.sCol + 1) / 7 * 100}% - 4px);top:${topOffset + b.lane * laneH}px;height:${laneH - 3}px;z-index:1;box-sizing:border-box;${skinCss(c, ro, overdue)}border-radius:${b.clipL ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipR ? "0" : "4px"} ${b.clipL ? "0" : "4px"};display:flex;align-items:center;padding:0 7px;font-size:11px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${grabCss(ro)}${dimCss(dim, "0.55")}`;
            bar.appendChild(document.createTextNode(barLabel(t, ro, b.clipL, b.clipR, toHHMM)));
            if (!ro) {
                bar.draggable = true;
                // dragend 로 반드시 비운다 — 캘린더 밖에 떨궈 취소하면 st.dragging 이 남고,
                // 그 뒤 외부 드래그(파일 끌어오기 등)가 캘린더에 떨어지면 엉뚱한 태스크가 이동한다.
                bar.addEventListener("dragstart", (e) => { st.dragging = t; e.dataTransfer.effectAllowed = "move"; });
                bar.addEventListener("dragend", () => { st.dragging = null; });
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
        const t1 = el.createEl("div", { text: (task.recurring ? "🔁 " : "") + (task.bookmark ? "🔖 " : "") + titleOf(task) });
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
                w.style.cssText = `color:${WARN_YELLOW};font-weight:700;`;
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

        el.addEventListener("dragstart", (e) => { st.dragging = task; e.dataTransfer.effectAllowed = "move"; });
        el.addEventListener("dragend", () => { st.dragging = null; });   // 취소된 드래그가 남지 않게
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
            hdr.onclick = async (e) => { const f = app.vault.getAbstractFileByPath(path); if (f) await writer.openFile(path, f, openMode(e)); };
            const body = grp.createEl("div");
            body.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px;";
            for (const t of byFile.get(path)) body.appendChild(trayItem(t));
        }
    }

    function renderWeek(container, tasks) {
        const weekStart = st.view.toISODate();
        const wd = ["일", "월", "화", "수", "목", "금", "토"];
        const head = container.createEl("div");
        head.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);";
        for (let i = 0; i < 7; i++) {
            const iso = addDays(weekStart, i);
            const h = head.createEl("div", { text: `${wd[i]} ${parseInt(iso.slice(8, 10), 10)}` });
            h.style.cssText = `text-align:center;font-size:11px;font-weight:600;padding:3px 0;color:${weekdayColor(i)};${iso === todayISO ? "background:var(--background-modifier-hover);border-radius:4px 4px 0 0;" : ""}`;
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
            hh.style.cssText = `text-align:center;font-size:11px;font-weight:600;opacity:0.7;color:${weekdayColor(i)};`;
        }
        const gridStart = sundayStart(st.view);
        const ym = st.view.toFormat("yyyy-MM");
        // 이 달을 덮는 데 필요한 주 수만 그린다 (6주 고정이면 5주로 끝나는 달에 빈 줄이 남는다)
        const weeks = Math.ceil((diffDays(st.view.endOf("month").toISODate(), gridStart.toISODate()) + 1) / 7);
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
        el.title = dayChipTooltip(task, ro);
        el.style.cssText = `${skinCss(c, ro)}border-radius:4px;padding:2px 7px;font-size:11px;line-height:16px;${grabCss(ro)}max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${dimCss(task.done || task.cancelled)}`;
        el.appendChild(document.createTextNode(dayChipLabel(task, ro)));
        if (!ro) {
            el.draggable = true;
            el.addEventListener("dragstart", (e) => { st.dragging = task; e.dataTransfer.effectAllowed = "move"; });
            el.addEventListener("dragend", () => { st.dragging = null; });
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
        const iso = st.view.toISODate();
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
            nl.style.cssText = `position:absolute;left:${GUTTER}px;right:0;top:${(now.hour * 60 + now.minute) / 60 * HOUR_H}px;border-top:2px solid ${OVERDUE_RED};z-index:3;pointer-events:none;`;
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
            const t = st.dragging;
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
            blk.title = timeBlockTooltip(t, ro);
            // 일정은 z-index 1 — 겹치면 task 가 클릭을 가져간다(조작할 수 있는 쪽이 이겨야 한다)
            blk.style.cssText = `position:absolute;left:calc(${GUTTER}px + (100% - ${GUTTER}px) * ${lane / lanes});width:calc((100% - ${GUTTER}px) * ${span / lanes} - 5px);top:${top}px;height:${h}px;z-index:${ro ? 1 : 2};box-sizing:border-box;${skinCss(c, ro)}border-radius:4px;padding:2px 6px;font-size:11px;line-height:1.3;overflow:hidden;${grabCss(ro)}${dimCss(dim)}`;
            blk.appendChild(document.createTextNode(timeBlockLabel(t, ro, toHHMM(t.tStart))));
            if (ro) continue;   // ↓ 아래는 전부 조작 경로 — 일정에는 리사이즈 레일조차 만들지 않는다
            blk.draggable = true;
            blk.addEventListener("dragstart", (e) => { st.dragging = t; e.dataTransfer.effectAllowed = "move"; });
            blk.addEventListener("dragend", () => { st.dragging = null; });
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

    // 일간 보기 시간 그리드의 스크롤 컨테이너. 복원은 renderNow 의 restoreScroll 이 맡는다
    // (거기서 동기 + rAF 두 번 시도한다 — 한 번만 하면 아직 레이아웃 전이라 대입이 0으로 잘린다).
    let dayBox = null;
    let dayScrollRestoring = false;   // 복원 중 발생하는 scroll 이벤트가 저장값을 덮지 않게

    function renderDesktop() {
        syncCategories();   // 설정이 바뀌었을 수 있다 (플러그인 재시작 없이 반영하려면 매번 읽어야 한다)
        saveState();
        const first = ctrl.takeFirstRender();
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
        const calTasks = (st.showDone ? all : tasks).concat(evItems);   // 달력 = 토글에 따라 완료·취소 포함

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
            st.mode === "month" ? st.view.toFormat("yyyy년 M월")
                : st.mode === "day" ? st.view.toFormat("yyyy.MM.dd") + " (" + ["일", "월", "화", "수", "목", "금", "토"][st.view.weekday % 7] + ")"
                    : st.view.toFormat("yyyy.MM.dd") + " ~ " + st.view.plus({ days: 6 }).toFormat("MM.dd"));
        const next = bar.createEl("button", { text: "▶" });
        const todayBtn = bar.createEl("button", { text: "오늘" });
        // 보기 전환은 세 개의 명시적 버튼으로. (순환 버튼이면 월간에서 일간까지 두 번 눌러야 해서
        //  "일간 보기가 없다"고 느껴진다 — 현재 보기가 어디인지도 드러나지 않는다.)
        for (const [m, lab] of [["month", "월간"], ["week", "주간"], ["day", "일간"]]) {
            const b = bar.createEl("button", { text: lab });
            if (m === "day") b.title = "일간 보기 — 누르면 현재 시각으로 맞춘다";
            b.style.cssText = `font-size:11px;padding:2px 9px;border-radius:10px;cursor:pointer;${m === st.mode ? "border:1px solid var(--interactive-accent);font-weight:700;" : "opacity:.6;"}`;
            b.onclick = () => {
                // 이미 일간이면 다시 눌러 "지금 시각으로 되돌리기" 로 쓴다
                if (m === st.mode) { if (m === "day") { S.dayScroll = undefined; render(); } return; }
                st.mode = m;
                // 주간·일간은 항상 "오늘" 기준으로 연다 (보던 달의 1일 기준이면 대개 지난 주가 열린다)
                st.view = m === "month" ? st.view.startOf("month") : m === "week" ? sundayStart(L.now()) : L.now().startOf("day");
                if (m === "day") S.dayScroll = undefined;
                render();
            };
        }
        const doneBtn = bar.createEl("button", { text: st.showDone ? "완료 ✓" : "완료 ✗" });
        doneBtn.title = "달력에 완료·취소 항목 표시/숨김";
        doneBtn.onclick = () => { st.showDone = !st.showDone; render(); };
        const step = (n) => (st.mode === "month" ? st.view.plus({ months: n }) : st.mode === "day" ? st.view.plus({ days: n }) : st.view.plus({ weeks: n }));
        prev.onclick = () => { st.view = step(-1); render(); };
        next.onclick = () => { st.view = step(1); render(); };
        todayBtn.onclick = () => {
            st.view = st.mode === "month" ? L.now().startOf("month") : st.mode === "day" ? L.now().startOf("day") : sundayStart(L.now());
            if (st.mode === "day") S.dayScroll = undefined;   // "오늘" 은 지금 시각까지 데려다 준다
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
            eb.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;border:1px dashed var(--background-modifier-border);opacity:${st.showEvents ? 1 : 0.4};`;
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
            eb.onclick = () => { st.showEvents = !st.showEvents; render(); };
        }

        // ── 달력 (기간 막대) ──
        if (st.mode === "month") renderMonth(box, calTasks);
        else if (st.mode === "day") renderDay(box, calTasks);
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
            ctrl.holdHeight(root.offsetHeight);
            if (first) restorePageScroll();
        };
        restoreScroll();
        requestAnimationFrame(restoreScroll);   // 컨테이너가 아직 문서에 안 붙었으면 다음 프레임에 다시
    }

    return {
        setCategories: (v) => { ({ CATS, CATLABEL, CATCOLOR, CAT_DEFAULT } = v); },
        renderDesktop,
    };
}
