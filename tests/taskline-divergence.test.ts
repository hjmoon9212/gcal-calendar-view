/**
 * view 의 현재 쓰기 규칙과 **정본 TaskLine** 이 어디서 갈리는지 나란히 고정한다(0.7.6).
 *
 * 두 규칙은 같은 노트 줄을 고치는데 결과가 다르다. 어느 쪽이 맞는지는 여기서 정하지 않는다 —
 * 지금 무엇이 다른지를 박아 두고, 채택은 0.8.x 에서 한 건씩 한다(계획의 D1~D7).
 *
 * ⛔ 이 파일이 초록이라고 "같다"는 뜻이 아니다. **다름이 그대로**라는 뜻이다.
 *    골든(taskline.divergence.json)이 달라지면 둘 중 한쪽이 움직인 것이다.
 */
import { installFakeEnv } from "./helpers/fakeEnv";
installFakeEnv();

import { eq, ok, done } from "./helpers/assert";
import { golden } from "./helpers/golden";
// view 의 규칙
import { patchLine, findTaskLine } from "../src/write/linePatch";
import { mkTitle, parseTaskItem } from "../src/data/gather";
import { parseTimeField } from "../src/core/time";
// 정본(tasks-gcal-sync 에서 복사)
import { cleanTitle, isTaskLine, parseTaskLine, removeTime, setDue, setStart, setTime } from "../src/shared/tasks/TaskLine";
import { normalizeTimeRange } from "../src/shared/tasks/timeRange";

const pending = new Map();
const parse = (text: string) => parseTaskItem("a.md", { text, line: 0 }, { catDefault: "personal", pending });

const table: Record<string, { 입력: string; view: string | null; taskline: string | null; 같나: boolean }> = {};
function compare(id: string, input: string, viewOut: string | null, canonOut: string | null) {
  table[id] = { 입력: input, view: viewOut, taskline: canonOut, 같나: viewOut === canonOut };
}

// ── D1. 망가진 날짜: view 는 일부만 치환, 정본은 자가치유 ──
{
  const line = "- [ ] #task 할일 📅 2026-08-038-03";
  compare("D1.깨진 날짜에 📅 쓰기", line, patchLine(line, { due: "2026-08-20" }), setDue(line, "2026-08-20"));
}
// 🛫 도 같은 규칙인지
{
  const line = "- [ ] #task 할일 🛫 2026-08-0";
  compare("D1b.깨진 날짜에 🛫 쓰기", line, patchLine(line, { start: "2026-08-20" }), setStart(line, "2026-08-20"));
}

// ── D2. ⏰ 제거 범위 · 끝 시각 없는 23:30 ──
{
  const line = "- [ ] #task 할일 ⏰ 09:00-10:00 ⏰ 11:00-12:00 📅 2026-08-06";
  compare("D2.⏰ 가 둘일 때 제거", line, patchLine(line, { time: null }), removeTime(line));
}
{
  // 끝 시각이 없을 때 view 는 시작+60(=자정 넘으면 1440→'23:59'), 정본은 23:59 로 잘라 적는다
  const view = parseTimeField("⏰ 23:30");
  compare(
    "D2b.끝 시각 없는 23:30",
    "⏰ 23:30",
    `tStart=${view.tStart} tEnd=${view.tEnd}`,
    `normalizeTimeRange("23:30") = ${normalizeTimeRange("23:30")}`
  );
}

// ── D3. 📆 🗓 ⌛ 가 있는 줄의 ⏰ 삽입 위치 ──
for (const [id, line] of [
  ["D3.📆 앞", "- [ ] #task 할일 📆 2026-08-06"],
  ["D3b.🗓 앞", "- [ ] #task 할일 🗓 2026-08-06"],
  ["D3c.⌛ 앞", "- [ ] #task 할일 ⌛ 2026-08-06"],
  ["D3d.📅 앞(같아야 한다)", "- [ ] #task 할일 📅 2026-08-06"],
] as [string, string][]) {
  compare(id, line, patchLine(line, { time: "09:00-10:00" }), setTime(line, "09:00-10:00"));
}

// ── D4. 제목 정리: view 는 모든 #태그 제거, 정본은 globalFilter 만 ──
{
  const body = "#task #gcal/work 보고서 #프로젝트/알파 📅 2026-08-06";
  compare("D4.제목 정리", body, mkTitle(body), cleanTitle(body, "#task"));
}

// ── D5. 한글 카테고리 태그 ──
{
  const text = "#task #gcal/개인 우유 사기 📅 2026-08-06";
  const item = parse(text)!;
  compare("D5.한글 #gcal/개인", text, item.cat, "gcal 라우팅은 sync 의 resolveCalendar 가 판정");
  eq(item.cat, "personal", "⚠️ view 는 한글 카테고리를 못 읽어 기본값으로 떨어진다");
}

// ── D6. 무엇을 task 로 보는가 ──
for (const [id, text] of [
  ["D6.#task", "#task 할일"],
  ["D6b.#task/minor", "#task/minor 할일"],
  ["D6c.#taskforce", "#taskforce 회의"],
  ["D6d.태그 없음", "그냥 할일"],
] as [string, string][]) {
  const line = "- [ ] " + text;
  compare(id, line, parse(text) ? "task" : "아님", isTaskLine(line) && line.includes("#task") ? "task" : "아님");
}

// ── D7. 줄 찾기: view 는 본문 포함으로 퍼지 검색 ──
{
  const lines = ["- [ ] #task 할일 A", "- [ ] #task 할일 A 사본", "- [ ] #task 할일 B"];
  // 줄 번호가 밀렸을 때 view 는 **첫 매치**를 쓴다 — 같은 본문이 둘이면 엉뚱한 줄을 고칠 수 있다
  eq(findTaskLine(lines, { line: 5, text: "#task 할일 A" }), 0, "⚠️ view: 첫 매치를 쓴다(가장 가까운 줄이 아니다)");
  eq(findTaskLine(lines, { line: 1, text: "#task 할일 A" }), 1, "줄 번호가 맞으면 그 줄");
  compare("D7.밀린 줄 찾기", "줄 5 → 본문 재탐색", "0번 줄(첫 매치)", "TaskWriter 는 드리프트로 보고 쓰기를 거부한다");
}

// ── 정본이 view 와 **같은** 곳(옮겨도 안전한 자리) ──
{
  const line = "- [ ] #task 할일 📅 2026-08-06";
  ok(patchLine(line, { due: "2026-08-09" }) === setDue(line, "2026-08-09"), "정상 📅 치환은 같다");
  ok(patchLine(line, { time: "09:00-10:00" }) === setTime(line, "09:00-10:00"), "정상 ⏰ 삽입 위치는 같다");
  ok(parseTaskLine(line, "#task")!.body.includes("할일"), "정본 파서도 같은 줄을 읽는다");
}

golden("taskline.divergence", table);
done();
