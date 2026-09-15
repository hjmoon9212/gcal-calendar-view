/*
 * 빌드된 main.js 가 원본(src/main.js)과 **같은 물건**인지 확인한다 — `npm run build` 뒤에 돈다.
 *
 * 0.7.0 에서 배포 방식이 "커밋한 main.js 를 그대로 첨부" → "CI 가 src/ 를 esbuild 로 묶어 첨부" 로
 * 바뀌었다. 번들러가 모양을 바꾸면 BRAT 이 받는 파일이 조용히 달라진다. 그래서:
 *   1. 기본 export 가 onload 를 가진 클래스인가(Obsidian 이 module.exports 를 플러그인으로 쓴다)
 *   2. 번들에 luxon 이 끌려 들어가지 않았나(Dataview 가 주입한다 — 두 벌이면 DateTime 비교가 깨진다)
 *   3. __test 로 내보낸 순수 함수들이 원본과 번들에서 **같은 입력에 같은 출력**을 내나
 */
import esbuild from "esbuild";
import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const Module = require("module");

// obsidian 스텁을 CJS 로 묶어 require("obsidian") 자리에 끼운다
const stubOut = path.resolve(".test-build-one/obsidian-stub.cjs");
await esbuild.build({
  entryPoints: ["tests/obsidian-stub.ts"],
  outfile: stubOut,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "warning",
});
const stub = require(stubOut);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return stub;
  if (request === "luxon") throw new Error("번들이 luxon 을 require 한다 — Dataview 의 luxon 을 써야 한다");
  return origLoad.call(this, request, parent, isMain);
};

let fail = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    fail++;
    console.error("  ✗ " + msg);
  }
};

const bundle = require(path.resolve("main.js"));
const source = require(path.resolve("src/main.js"));
const Plugin = bundle.default ?? bundle;

check(typeof Plugin === "function", "기본 export 가 클래스(함수)다");
check(typeof Plugin.prototype?.onload === "function", "onload 가 있다");
check(Plugin.prototype instanceof stub.Plugin, "obsidian Plugin 을 상속한다");
check(!/require\(["']luxon["']\)/.test(readFileSync("main.js", "utf8")), "번들에 luxon require 가 없다");

const T = bundle.__test;
const S = source.__test;
check(!!T && !!S, "__test 가 원본·번들 둘 다 있다");

// 같은 입력 → 같은 출력(JSON 비교). 입력은 각 함수의 대표 경로를 고르게 건드린다.
const settings = {
  ...S.DEFAULT_SETTINGS,
  eventColors: { "cal-a": "#112233", bad: "zzz" },
  eventColor: "#7f8c8d",
};
const cases = {
  parseOptions: [["scope: vault\nsource: \"0. Note\"\nnote: - 한 줄\nnote: - 두 줄\ngcal: Growth, Work"], [""]],
  parseList: [["Growth,  Work , ,Event"], [undefined]],
  resolveSource: [[{ scope: "vault" }, "0. Note/a.md"], [{}, "0. Note/1. Project/x.md"], [{}, "root.md"], [{ source: "\"A\" and !\"B\"" }, "z.md"]],
  resolveCalFilter: [[{ gcal: "off" }], [{ gcal: "Growth, work" }], [{ calendars: "A", "gcal-exclude": "B" }], [{ "include-calendars": "X", "exclude-calendars": "Y" }], [{}]],
  resolveEventColorInfo: [
    [settings, S.categoryColorMap(settings), "cal-a", "Growth"],
    [settings, S.categoryColorMap(settings), "bad", "growth"],
    [settings, S.categoryColorMap(settings), "x", "Nope"],
  ],
  categoryColorMap: [[settings], [{}]],
  layoutTimeLanes: [
    [[{ tStart: 540, tEnd: 600 }, { tStart: 600, tEnd: 660 }, { tStart: 570, tEnd: 630 }, { tStart: 1200, tEnd: 1260 }]],
    [[]],
  ],
  dayRank: [[{ kind: "event", tStart: null }], [{ kind: "task", tStart: 540 }], [{ kind: "task", tStart: null }]],
};
for (const [fn, argsList] of Object.entries(cases)) {
  for (const args of argsList) {
    let a, b;
    try {
      a = JSON.stringify(S[fn](...structuredClone(args)));
    } catch (e) {
      a = "THREW " + e.message;
    }
    try {
      b = JSON.stringify(T[fn](...structuredClone(args)));
    } catch (e) {
      b = "THREW " + e.message;
    }
    check(a === b, `${fn}(${JSON.stringify(args).slice(0, 50)}) 원본 = 번들`);
  }
}
const items = [
  { kind: "task", due: "2026-08-07", tStart: null, tEnd: null },
  { kind: "event", due: "2026-08-07", tStart: null, tEnd: null },
  { kind: "task", due: "2026-08-07", tStart: 600, tEnd: 660 },
  { kind: "event", due: "2026-08-06", tStart: 540, tEnd: 600 },
];
check(
  JSON.stringify([...items].sort(S.byDayOrder)) === JSON.stringify([...items].sort(T.byDayOrder)),
  "byDayOrder 정렬 결과 원본 = 번들"
);
check(JSON.stringify(S.DEFAULT_SETTINGS) === JSON.stringify(T.DEFAULT_SETTINGS), "DEFAULT_SETTINGS 원본 = 번들");

if (fail) {
  console.error(`\nsmoke: ${fail}건 실패`);
  process.exit(1);
}
console.log("\nsmoke: 번들이 원본과 같다");
