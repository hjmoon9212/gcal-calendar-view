/**
 * 모바일 액션시트(TaskSheetModal)의 현재 동작(0.7.1 — TS 로 옮기기 전에 고정).
 *
 * ⛔ 이 시트는 노트를 직접 고치지 않는다 — 쓰기는 전부 ctx 로 넘겨받은 함수(writeBack ·
 *    applyDates · dropOnDate · editTask)로 흘러간다. 여기서는 **어떤 버튼이 어떤 함수를 어떤 인자로
 *    부르는지**와 화면 트리를 골든으로 둔다. 시각 기본값이 "지금" 을 보므로 시계를 고정한다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv(); // 2026-08-06 12:00 로컬 → nowUp = 12:00

import { done } from "./helpers/assert";
import { golden } from "./helpers/golden";
import { FakeEl, findAll, serializeEl } from "./helpers/fakeDom";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require("../src/main.js").__test;

const pad = (n: number) => String(n).padStart(2, "0");
function makeCtx() {
  const calls: any[] = [];
  const rec = (name: string) => async (...args: any[]) => {
    calls.push([name, ...args.map((a) => (a && typeof a === "object" && "title" in a ? `task:${a.title}` : a))]);
  };
  const ctx = {
    calls,
    colorOf: () => "#123456",
    metaLine: (t: any) => `${t.path ?? "-"} · ${t.due ?? "날짜 없음"}`,
    isRO: (t: any) => !!t && t.kind === "event",
    todayISO: "2026-08-06",
    addDays: (iso: string, n: number) => {
      const d = new Date(iso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    },
    toHHMM: (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`,
    toMin: (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)),
    timeText: (s: number, e: number) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}-${pad(Math.floor(e / 60))}:${pad(e % 60)}`,
    writeBack: rec("writeBack"),
    applyDates: rec("applyDates"),
    dropOnDate: rec("dropOnDate"),
    editTask: rec("editTask"),
    openAtLine: rec("openAtLine"),
    notice: (m: string) => calls.push(["notice", m]),
  };
  return ctx;
}

function open(task: any) {
  const ctx = makeCtx();
  const m: any = new T.TaskSheetModal({}, task, ctx);
  m.contentEl = new FakeEl("div");
  let closes = 0;
  const realClose = m.close.bind(m);
  m.close = () => {
    closes++;
    realClose();
  };
  m.open();
  return { m, ctx, closes: () => closes };
}

const TASKS: Record<string, any> = {
  "span-timed": { kind: "task", title: "보고서", path: "note.md", due: "2026-08-10", start: "2026-08-08", tStart: 540, tEnd: 600 },
  "due-only": { kind: "task", title: "장보기", path: "a.md", due: "2026-08-07", start: null, tStart: null, tEnd: null },
  "no-due": { kind: "task", title: "", path: "b.md", due: null, start: null, tStart: null, tEnd: null },
  event: { kind: "event", title: "회의", path: null, due: "2026-08-06", start: "2026-08-06", tStart: 600, tEnd: 660 },
};

(async () => {
  for (const [name, task] of Object.entries(TASKS)) {
    const { m } = open({ ...task });
    golden(`taskSheet.tree.${name}`, serializeEl(m.contentEl));
  }

  // ── 핸들러: 버튼 onclick · 날짜 input onchange 를 하나씩 ──
  for (const name of ["span-timed", "due-only", "no-due"]) {
    const probe = open({ ...TASKS[name] });
    const n = findAll(probe.m.contentEl, (e) => !!e.onclick || !!e.onchange).length;
    const out: any[] = [];
    for (let i = 0; i < n; i++) {
      const { m, ctx, closes } = open({ ...TASKS[name] });
      const el = findAll(m.contentEl, (e) => !!e.onclick || !!e.onchange)[i];
      const label = el.onclick ? `button ${el.text}` : `input[${el.type}] ${el.value}`;
      if (el.onchange) {
        // 날짜 선택기: 값을 바꾼 뒤 onchange — 마감일보다 뒤·앞 둘 다 보려고 "2026-08-20"
        el.value = "2026-08-20";
        await el.onchange();
      } else {
        await el.onclick!();
      }
      out.push({ target: label, calls: ctx.calls, closed: closes() });
    }
    // 빈 날짜 선택은 아무것도 안 한다
    {
      const { m, ctx, closes } = open({ ...TASKS[name] });
      const d = findAll(m.contentEl, (e) => e.type === "date")[0];
      if (d) {
        d.value = "";
        await d.onchange!();
        out.push({ target: "input[date] (빈 값)", calls: ctx.calls, closed: closes() });
      }
    }
    golden(`taskSheet.handlers.${name}`, out);
  }

  // 시작일 선택기: 마감일보다 이르면 저장, 늦으면 거절
  {
    const { m, ctx } = open({ ...TASKS["span-timed"] });
    const start = findAll(m.contentEl, (e) => e.type === "date")[1];
    start.value = "2026-08-09";
    await start.onchange!();
    golden("taskSheet.start-before-due", ctx.calls);
  }
  // 시작 시각을 비우면 길이 버튼이 거절한다
  {
    const { m, ctx } = open({ ...TASKS["due-only"] });
    const [si] = findAll(m.contentEl, (e) => e.type === "time");
    si.value = "";
    const btn30 = findAll(m.contentEl, (e) => e.text === "30분")[0];
    await btn30.onclick!();
    golden("taskSheet.length-without-start", ctx.calls);
  }
  // 종료가 시작보다 이르면 저장은 +60분으로 고친다
  {
    const { m, ctx } = open({ ...TASKS["due-only"] });
    const [si, ei] = findAll(m.contentEl, (e) => e.type === "time");
    si.value = "14:00";
    ei.value = "13:00";
    const save = findAll(m.contentEl, (e) => e.text === "저장")[0];
    await save.onclick!();
    golden("taskSheet.save-inverted", ctx.calls);
  }
  // 닫으면 비운다
  {
    const { m } = open({ ...TASKS["due-only"] });
    m.close();
    golden("taskSheet.after-close", serializeEl(m.contentEl));
  }

  done();
})();
