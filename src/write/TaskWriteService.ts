/*
 * 노트를 고치는 유일한 경로 — createCalendar 에서 그대로 옮겼다(0.7.3).
 *
 * ⛔ **`vault.process` 는 이 파일에서만 부른다.** 드롭·리사이즈·트레이 버튼·액션시트가 전부
 *    여기로 흐르므로, 개별 어포던스 가드를 하나 빠뜨려도 GCal 일정(읽기 전용)이 노트를 고칠 수는
 *    없다 — isRO 를 applyDates·editTask·openAtLine 세 길목에서 다시 본다.
 */
import { Keymap, Notice } from "obsidian";
import { isRO } from "../core/order";
import { pkey, PendingEntry } from "../data/pending";
import { findTaskLine, patchLine, LineChanges } from "./linePatch";
import { planDropOnDate, planDropOnTime, planWriteBack, DropPlan } from "./dropRules";

export interface WriteDeps {
  app: any;
  /** 낙관적 갱신 대기표(플러그인 인스턴스가 소유한다) */
  pending: Map<string, PendingEntry>;
  /** 쓰기 → Dataview 재실행 사이에 스크롤이 튀지 않게 */
  rememberScroll: () => void;
  /** 쓴 뒤 수집 캐시를 버리고 다시 그린다 */
  afterWrite: () => void;
}

export function createWriteService(deps: WriteDeps) {
  const { app } = deps;

  /**
   * 어디에 열 것인가 — Obsidian 링크와 똑같은 규칙을 따른다.
   *   그냥 클릭 = 현재 탭 · Ctrl(Cmd)+클릭 = 새 탭 · Ctrl+Shift+클릭 = 분할 창
   * Keymap.isModEvent 가 있으면 그걸 쓴다 (사용자의 Obsidian 설정까지 반영됨).
   * dataviewjs 샌드박스에 Keymap 이 없는 버전을 대비해 직접 판정도 남겨둔다.
   */
  const openMode = (e: any): boolean | string => {
    if (!e) return false;
    if (typeof Keymap !== "undefined" && Keymap && typeof Keymap.isModEvent === "function") return Keymap.isModEvent(e);
    if (e.ctrlKey || e.metaKey) return e.shiftKey ? "split" : "tab";
    return false;
  };

  /**
   * 그 파일을 보여줄 leaf 를 고른다. 이미 어딘가 열려 있으면 새로 열지 않고 그 탭으로
   * 이동한다(중복 탭 방지). 단 Ctrl(Cmd)+클릭은 "새로 열라"는 뜻이므로 그때는 항상 새 탭/분할.
   */
  function leafForFile(path: string, mode: boolean | string): any {
    if (!mode) {
      const open = app.workspace
        .getLeavesOfType("markdown")
        .find((l: any) => l.view && l.view.file && l.view.file.path === path);
      if (open) {
        app.workspace.setActiveLeaf(open, { focus: true });
        app.workspace.revealLeaf(open); // 사이드바/접힌 탭이면 꺼내 준다
        return open;
      }
    }
    return app.workspace.getLeaf(mode); // false = 현재 탭(설정에 따라 새 탭) · "tab" = 새 탭 · "split" = 분할
  }

  /** 원본 노트의 해당 줄로 이동 (편집 모드면 커서/스크롤까지 보정) */
  async function openAtLine(task: any, evt?: any): Promise<void> {
    if (isRO(task)) return; // GCal 일정은 노트에 원본이 없다
    const f = app.vault.getAbstractFileByPath(task.path);
    if (!f) {
      new Notice("파일 없음: " + task.path);
      return;
    }
    const leaf = leafForFile(task.path, openMode(evt));
    const line = typeof task.line === "number" ? task.line : 0;
    await leaf.openFile(f, { eState: { line }, active: true });
    const ed = leaf.view && leaf.view.editor;
    if (ed) {
      ed.setCursor({ line, ch: 0 });
      ed.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
  }

  /** 우클릭 → Tasks 편집 모달(탭 이동 없이). apiV1.editTaskLineModal 로 줄을 고쳐 파일에 반영한다. */
  async function editTask(task: any): Promise<void> {
    if (isRO(task)) return; // GCal 일정은 읽기 전용
    deps.rememberScroll();
    const tp = app.plugins.plugins["obsidian-tasks-plugin"];
    const api = tp && tp.apiV1; // apiV1 은 getter(속성) — 괄호 없이 접근
    const file = app.vault.getAbstractFileByPath(task.path);
    if (!file) {
      new Notice("파일 없음: " + task.path);
      return;
    }
    // API 없으면(구버전 등) 원본 줄로 이동만
    if (!api || typeof api.editTaskLineModal !== "function") {
      await openAtLine(task);
      return;
    }
    const curLines = (await app.vault.read(file)).split("\n");
    const idx = findTaskLine(curLines, task);
    if (idx < 0) {
      new Notice("태스크 줄을 찾지 못함: " + task.path);
      return;
    }
    const cur = curLines[idx];
    const edited = await api.editTaskLineModal(cur); // 취소 시 빈 문자열/원본 반환
    if (!edited || edited === cur) return;
    let missed = false;
    let wroteAt = idx;
    await app.vault.process(file, (d: string) => {
      const lines = d.split("\n");
      const j = findTaskLine(lines, task);
      if (j < 0) {
        missed = true;
        return d;
      } // 못 찾으면 아무것도 건드리지 않는다
      lines[j] = edited;
      wroteAt = j;
      return lines.join("\n");
    });
    if (missed) {
      new Notice("태스크 줄을 찾지 못함: " + task.path);
      return;
    }
    // applyDates 와 같은 낙관적 갱신 — 인덱스가 따라올 때까지 옛 텍스트로 그려져 튀는 걸 막는다.
    // ⚠️ 오버레이의 text 는 Dataview 의 t.text 형식(불릿·체크박스 없음)이어야 한다. 파일 줄을
    //    그대로 넣으면 수집이 그걸 태스크 텍스트로 삼아 제목이 "- [ ] 제목" 이 되고,
    //    그 값이 다음 쓰기 때 patch(task.text) 로 다시 오버레이에 저장돼 계속 전파된다.
    // ⚠️ 반복(🔁) task 를 완료하면 Tasks 가 **다음 회차 줄까지 만들어 두 줄을 개행으로 이어**
    //    돌려준다. 그건 한 태스크의 텍스트가 아니므로 낙관적 갱신 대상이 아니다 — 넣으면
    //    제목이 "할일 - [x] 할일" 처럼 합쳐져 보이고, 줄이 하나 늘어 이후 조작이
    //    "태스크 줄을 찾지 못함" 으로 떨어진다. 이 경우는 Dataview 재색인에 그냥 맡긴다.
    if (!/\r?\n/.test(edited)) {
      deps.pending.set(pkey(task.path, wroteAt, task.title), {
        text: edited.replace(/^\s*[-*+]\s*\[.\]\s*/, ""),
        ts: Date.now(),
      });
    }
    deps.afterWrite();
  }

  /**
   * 원본 줄의 🛫 start / 📅 due / ⏰ time 을 직접 변경 (changes: {start?, due?, time?}).
   * 없는 필드는 새로 추가하고, time 에 null 을 주면 시각을 제거한다.
   */
  async function applyDates(task: any, changes: LineChanges): Promise<void> {
    // ★ 쓰기의 유일한 길목이다. dropOnDate·dropOnTime·writeBack·리사이즈가 전부 여기로
    //   흐르므로, 개별 어포던스 가드를 하나 빠뜨려도 GCal 일정이 노트를 고칠 수는 없다.
    if (isRO(task)) return;
    deps.rememberScroll(); // 쓰기 → Dataview 재실행 사이에 스크롤이 튀지 않게
    const file = app.vault.getAbstractFileByPath(task.path);
    if (!file) {
      new Notice("파일 없음: " + task.path);
      return;
    }
    // 줄을 고치는 규칙은 write/linePatch.ts 한 곳에 있다.
    const patch = (ln: string) => patchLine(ln, changes);
    let wroteAt = task.line; // 실제로 고친 줄 (대기표 키를 여기에 맞춰야 함)
    let missed = false;
    await app.vault.process(file, (data: string) => {
      const lines = data.split("\n");
      const i = findTaskLine(lines, task);
      if (i < 0) {
        missed = true;
        return data;
      } // 못 찾으면 아무것도 건드리지 않는다
      lines[i] = patch(lines[i]);
      wroteAt = i;
      return lines.join("\n");
    });
    if (missed) {
      new Notice("태스크 줄을 찾지 못함: " + task.path);
      return;
    }
    // Dataview 인덱스는 몇 초 늦게 따라온다 → 그 전까지 쓸 새 줄을 대기표에 올린다.
    // (이게 없으면 바로 뒤 렌더가 옛 날짜로 그렸다가 인덱스 갱신 때 막대가 튄다)
    deps.pending.set(pkey(task.path, wroteAt, task.title), { text: patch(task.text), ts: Date.now() });
    deps.afterWrite();
  }

  /** 규칙이 정한 것을 쓰고 말한다. `changes` 가 null 이면 이유만 말한다(거절). */
  const runPlan = async (task: any, plan: DropPlan): Promise<void> => {
    if (!plan.changes) {
      new Notice(plan.notice);
      return;
    }
    await applyDates(task, plan.changes);
    new Notice(plan.notice);
  };

  return {
    openMode,
    /** 트레이의 파일 헤더 클릭 — 줄이 아니라 파일을 연다. */
    openFile: (path: string, file: any, mode: boolean | string) => leafForFile(path, mode).openFile(file, { active: true }),
    openAtLine,
    editTask,
    applyDates,
    /** 배경 날짜 칸 드롭 (일반 = 기간째 이동 · Shift = 마감일만 조정) */
    dropOnDate: (task: any, iso: string, shift: boolean) => runPlan(task, planDropOnDate(task, iso, shift)),
    /** 일간 보기 시간 그리드 드롭 → 시각 지정/이동 */
    dropOnTime: (task: any, iso: string, startMin: number) => runPlan(task, planDropOnTime(task, iso, startMin)),
    /** 트레이 빠른버튼·날짜선택기 → 마감일만 지정 */
    writeBack: (task: any, newDue: string) => runPlan(task, planWriteBack(task, newDue)),
  };
}
