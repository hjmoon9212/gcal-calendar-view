import { Modal } from "obsidian";

/**
 * 모바일 액션시트 — 목록의 항목을 탭하면 뜬다.
 *
 * 데스크탑에서 **드래그 · Shift+드래그 · 우클릭**이 하던 일을 버튼으로 편 것이다.
 * 터치에서는 그 셋이 이벤트조차 발생하지 않으므로(HTML5 DnD 는 터치에서 안 뜨고
 * contextmenu 도 없다), 폰에서 task 를 고칠 수 있는 유일한 통로다.
 * 태블릿은 데스크탑 화면에서도 탭하면 이 시트가 뜬다(ui/tapAction.ts).
 *
 * 배치(0.11.1~): 날짜·시각 줄은 **같은 4열 격자**를 쓴다 — 버튼 셋 + 넓은 오른쪽 열. 날짜 칸 ·
 * 「시각 저장」 · 「시각 제거」가 그 오른쪽 열에 세로로 선다. 버튼과 입력칸은 높이·모서리·글자
 * 크기가 같다(CTL) — 테마가 button 과 input 에 다른 높이를 주므로 인라인으로 고정한다.
 * 맨 아래 줄은 「편집 · 원본 열기 · 완료」 셋이고 완료가 오른쪽 끝이다.
 * 「기간째 이동」은 뺐다(0.11.1) — 마감일·시작일을 따로 고치는 것으로 충분하다.
 *
 * ⛔ 여기서 노트를 직접 고치지 않는다. 쓰기는 전부 createCalendar 가 넘겨준 함수로
 *    흘려보낸다. 특히 ⏰ 는 반드시 applyDates 의 time 경로를 타야 한다 — 첫 Tasks 필드
 *    이모지 **앞에** 넣는 규칙이 거기에만 있고, 줄 끝에 붙이면 Tasks 가 그 앞의 📅 까지
 *    설명으로 흡수한다(마감일 쿼리가 그 task 를 놓친다).
 */

/** 버튼·입력칸 공통 치수. 테마가 둘에 다른 높이·여백을 주므로 여기서 고정한다. */
const CTL =
    "height:40px;min-height:40px;box-sizing:border-box;margin:0;width:100%;min-width:0;" +
    "padding:0 8px;border-radius:8px;font-size:14px;line-height:1;white-space:nowrap;";
/** 버튼 셋 + 넓은 오른쪽 열. 오른쪽 열 최소폭은 날짜 입력칸이 잘리지 않는 폭이다. */
const GRID =
    "display:grid;gap:8px;align-items:center;margin-top:8px;" +
    "grid-template-columns:repeat(3,minmax(0,1fr)) minmax(118px,1.8fr);";
/** 격자의 왼쪽 세 칸을 통째로 쓴다(줄 제목 · 시각 입력 쌍). */
const SPAN3 = "grid-column:1 / 4;min-width:0;";
const LABEL = "font-size:12px;opacity:.6;";

export class TaskSheetModal extends Modal {
    task: any;
    ctx: any;

    constructor(app: any, task: any, ctx: any) {
        super(app);
        this.task = task;
        this.ctx = ctx;
    }

    /** 구역 제목 한 줄. */
    section(text: string) {
        const h = this.contentEl.createEl("div", { text });
        h.style.cssText = LABEL + "margin-top:16px;";
        return h;
    }

    /** 4열 격자 한 줄. */
    grid(extraCss?: string) {
        const r = this.contentEl.createEl("div");
        r.style.cssText = GRID + (extraCss || "");
        return r;
    }

    /** 격자 안에 들어가는 줄 제목(왼쪽 세 칸). 오른쪽 열에 그 줄의 입력칸이 온다. */
    inlineLabel(parent: any, text: string) {
        const l = parent.createEl("div", { text });
        l.style.cssText = LABEL + SPAN3;
        return l;
    }

    /** 누르면 실행하고 닫는 버튼. 실패해도 닫는다 — 실패는 Notice 가 말한다. */
    btn(parent: any, label: string, run: () => any, extraCss?: string) {
        const b = parent.createEl("button", { text: label });
        b.style.cssText = CTL + "cursor:pointer;" + (extraCss || "");
        b.onclick = async () => {
            try { await run(); } finally { this.close(); }
        };
        return b;
    }

    /** 날짜 선택기. 고르는 즉시 실행하고 닫는다(확인 버튼을 한 번 더 누르게 하지 않는다). */
    datePicker(parent: any, value: string, run: (iso: string) => any) {
        const d = parent.createEl("input");
        d.type = "date";
        d.value = value || "";
        d.style.cssText = CTL;
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
            c.colorOf(t) + ";padding-left:10px;";
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

        // ── 📅 마감일 ── 날짜 동작 중 가장 흔한 것이라 맨 위에 둔다.
        this.section("📅 마감일" + (t.due ? " — 지금 " + t.due : " — 없음"));
        const due = this.grid();
        this.btn(due, "오늘", () => c.writeBack(t, c.todayISO));
        this.btn(due, "내일", () => c.writeBack(t, c.addDays(c.todayISO, 1)));
        this.btn(due, "+7일", () => c.writeBack(t, c.addDays(c.todayISO, 7)));
        this.datePicker(due, t.due || c.todayISO, (iso) => c.writeBack(t, iso));

        // ── 🛫 시작일 ── 마감일이 있어야 의미가 있다(기간의 왼쪽 끝이므로).
        //    제목과 날짜 칸을 한 줄에 둔다 — 날짜 칸이 위 마감일 칸과 같은 열에 선다.
        if (t.due) {
            const st = this.grid("margin-top:16px;");
            this.inlineLabel(st, "🛫 시작일" + (t.start ? " — 지금 " + t.start : " — 없음"));
            this.datePicker(st, t.start || t.due, async (iso) => {
                // applyDates 는 start 를 그대로 쓴다 — start > due 를 만들면 막대 폭이 음수가 된다.
                // 데스크탑에서는 드롭 좌표가 이 조건을 막아 주지만 여기서는 날짜를 직접 고르므로 우리가 막는다.
                if (t.due && iso > t.due) { c.notice("시작일은 마감일(📅 " + t.due + ")보다 뒤일 수 없어요"); return; }
                await c.applyDates(t, { start: iso });
                c.notice("🛫 " + iso);
            });
        }

        // ── ⏰ 시각 ── 데스크탑에서는 일간 보기 드래그로만 넣던 값.
        //
        // **시작 하나 + 길이 버튼**이다. 실제로 하는 일은 대개 "이 시각부터 30분" 하나라,
        // 길이 버튼은 누르는 즉시 저장한다 — 탭 두 번이면 끝난다.
        this.section("⏰ 시각" + (t.tStart !== null ? " — 지금 " + c.timeText(t.tStart, t.tEnd) : " — 없음"));
        const mkTime = (parent: any, val: string) => {
            const i = parent.createEl("input");
            i.type = "time";
            i.step = "900";   // 15분 — 데스크탑 드래그의 스냅 단위와 맞춘다
            i.value = val;
            i.style.cssText = CTL;
            return i;
        };
        // 기본 시작: 이미 있으면 그 값, 없으면 지금을 15분 위로 올린 값
        // (폰에서 시각을 주는 상황은 대개 "지금부터" 다).
        const nowUp = Math.min(1440 - 15, Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 15) * 15);
        const s0 = t.tStart !== null ? t.tStart : nowUp;

        const e0 = t.tStart !== null ? t.tEnd : Math.min(1440, s0 + 60);

        // 시작 ~ 종료를 나란히 **보여준다.** 지금 몇 시까지인지가 안 보이면 길이 버튼을
        // 누른 결과도, 손으로 고칠 값도 눈으로 확인할 수가 없다.
        const tr = this.grid();
        const pair = tr.createEl("div");
        pair.style.cssText = SPAN3 + "display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:6px;align-items:center;";
        const si = mkTime(pair, c.toHHMM(s0));
        pair.createEl("span", { text: "~" }).style.cssText = "opacity:.5;";
        const ei = mkTime(pair, c.toHHMM(e0));

        // 저장은 한 곳으로 모은다 — 길이 버튼도 「시각 저장」도 여기로 흐른다.
        const saveTime = async (st: number, e: number) => {
            if (e <= st) e = Math.min(1440, st + 60);   // 역전·0길이는 막대 높이가 0/음수가 된다
            await c.applyDates(t, { time: c.timeText(st, e) });
            c.notice("⏰ " + c.timeText(st, e));
        };

        // 종료를 손으로 고쳤을 때. 2시간·90분처럼 버튼에 없는 길이가 여기로 온다.
        // 이 시트에서 **누르기 전까지 저장되지 않는 값은 시각 입력칸뿐**이라, 버튼을 그 옆에 붙이고
        // 이름에 「시각」을 적는다 — 그냥 「저장」이면 시트 전체를 저장하는 버튼으로 읽힌다.
        this.btn(tr, "시각 저장", async () => {
            if (!si.value || !ei.value) { c.notice("시작·종료 시각을 모두 고르세요"); return; }
            await saveTime(c.toMin(si.value), c.toMin(ei.value));
        }, "font-weight:600;");

        // 길이 버튼 = **종료 시각 퀵 세팅**. 종료를 시작+N 으로 맞추고 그 자리에서 저장한다.
        // 시각이 이미 있는 task 면 시작은 그대로 — 데스크탑의 「블록 아랫끝 드래그」에 해당.
        const lens = this.grid();
        for (const [label, len] of [["15분", 15], ["30분", 30], ["1시간", 60]] as [string, number][]) {
            this.btn(lens, label, async () => {
                if (!si.value) { c.notice("시작 시각을 고르세요"); return; }
                const st = c.toMin(si.value);
                const e = Math.min(1440, st + len);
                ei.value = c.toHHMM(e);
                await saveTime(st, e);
            });
        }
        if (t.tStart !== null) {
            this.btn(lens, "시각 제거", async () => {
                await c.applyDates(t, { time: null });
                c.notice("⏰ 제거됨");
            });
        }

        // ── 맨 아래: 편집 · 원본 열기 · 완료 ── 구분선 아래 같은 폭 세 칸, **완료가 오른쪽 끝**.
        //    완료는 취소(`- [-]`) task 에는 두지 않는다 — 누르면 취소가 완료로 덮인다. 그때는 두 칸.
        //    완료 숨김(「완료 ✗」)이면 누르는 즉시 카드가 사라지므로 되돌리기는 「완료 ✓」에서 한다.
        const hasDone = !t.cancelled && !!c.toggleDone;
        const foot = contentEl.createEl("div");
        foot.style.cssText = "display:grid;grid-template-columns:repeat(" + (hasDone ? 3 : 2) + ",minmax(0,1fr));gap:8px;" +
            "margin-top:16px;padding-top:16px;border-top:1px solid var(--background-modifier-border);";
        this.btn(foot, "✏️ 편집", () => c.editTask(t));
        this.btn(foot, "📄 원본 열기", () => c.openAtLine(t));
        if (hasDone) {
            this.btn(foot, t.done ? "↩ 완료 취소" : "✅ 완료", () => c.toggleDone(t), t.done ? "" : "font-weight:600;");
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
