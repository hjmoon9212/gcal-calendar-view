#!/usr/bin/env node
/*
 * 구조 불변식 검사 — `npm test` 가 돌린다.
 *
 * 테스트는 "지금 이렇게 동작한다" 를 지키고, 이 스크립트는 **"이렇게 짜야 한다"** 를 지킨다.
 * 셋 다 문서(§ 유지보수)에 적힌 규칙이고, 어겨도 테스트는 초록으로 남기 때문에 따로 본다.
 *
 *   1) 노트를 고치는 곳은 `src/write/` 하나다
 *      `vault.process`/`vault.modify` 가 다른 데서 불리면, 드리프트 가드·대기표·isRO 를
 *      우회하는 두 번째 쓰기 경로가 생긴 것이다.
 *   2) luxon 을 **값으로** 가져오지 않는다
 *      Dataview 가 주입한 luxon 을 빌려 쓴다(`api.luxon`). 번들에 두 벌이 들어가면 DateTime
 *      비교가 조용히 어긋난다 — 타입만 import 하는 것은 괜찮다.
 *   3) 정렬·레인 배치는 한 번만 정의한다
 *      `byDayOrder`·`layoutTimeLanes` 는 데스크탑·모바일·액션시트가 같은 것을 써야 한다.
 *      사본이 갈라지면 "같은 날 순서가 화면마다 다르다" 가 된다.
 *   4) `src/` 에 `.js` 가 없다(0.7.5~)
 *      한 파일만 JS 로 남으면 그 파일만 타입 검사에서 빠진다.
 *
 * 사용: node scripts/check-invariants.mjs   → 어기면 exit 1
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve("src");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(ROOT);
const rel = (p) => path.relative(".", p).replace(/\\/g, "/");
let fail = 0;
const bad = (msg) => {
  fail++;
  console.error("  ✗ " + msg);
};
const okMsg = (msg) => console.log("  ✓ " + msg);

// ── 1. 노트 쓰기는 src/write/ 에서만 ──
{
  const offenders = files.filter((f) => {
    const r = rel(f);
    if (r.startsWith("src/write/")) return false;
    return /vault\.(process|modify)\s*\(/.test(readFileSync(f, "utf8"));
  });
  if (offenders.length) bad(`노트 쓰기가 src/write/ 밖에 있다: ${offenders.map(rel).join(", ")}`);
  else okMsg("vault.process / vault.modify 는 src/write/ 안에서만 부른다");
}

// ── 2. luxon 을 값으로 import 하지 않는다 ──
{
  const offenders = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return [...src.matchAll(/^\s*import\s+(?!type\s)[^;]*from\s+["']luxon["']/gm)].length > 0;
  });
  if (offenders.length) bad(`luxon 을 값으로 가져온다(Dataview 것을 빌려 쓸 것): ${offenders.map(rel).join(", ")}`);
  else okMsg("luxon 은 번들에 들어가지 않는다 (Dataview 의 것을 빌려 쓴다)");
}

// ── 3. 공통 함수는 한 번만 정의 ──
for (const name of ["byDayOrder", "layoutTimeLanes"]) {
  const re = new RegExp(`export\\s+(?:function|const)\\s+${name}\\b`);
  const defs = files.filter((f) => re.test(readFileSync(f, "utf8")));
  if (defs.length !== 1) bad(`${name} 정의가 ${defs.length}개다(1개여야 한다): ${defs.map(rel).join(", ")}`);
  else okMsg(`${name} 은 ${rel(defs[0])} 한 곳에만 있다`);
}

// ── 4. src 는 전부 TypeScript ──
{
  const js = files.filter((f) => f.endsWith(".js"));
  if (js.length) bad(`src 에 JS 파일이 남아 있다(타입 검사에서 빠진다): ${js.map(rel).join(", ")}`);
  else okMsg("src 는 전부 .ts 다");
}

console.log(fail ? "\n불변식 위반" : "\ninvariants: 이상 없음");
process.exit(fail ? 1 : 0);
