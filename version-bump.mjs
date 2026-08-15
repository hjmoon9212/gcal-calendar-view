// 버전 일괄 관리 스크립트 (빌드 없는 순수 JS 플러그인용).
// 사용법:
//   node version-bump.mjs 1.2.0   → manifest.json / versions.json 을 1.2.0 으로 통일
//   node version-bump.mjs         → manifest.json 의 현재 version 기준으로 versions.json 만 동기화
//
// 배포 절차:
//   1) node version-bump.mjs <버전>
//   2) git commit -am "v<버전>"
//   3) git tag <버전> && git push origin main <버전>   # v 접두사 없이 manifest.version 과 동일
// 태그 push → .github/workflows/release.yml 이 Release 를 생성 → BRAT 가 내려받는다.
import { readFileSync, writeFileSync } from "fs";

const write = (f, obj) => writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.argv[2] ?? manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`버전 형식이 올바르지 않습니다: ${target} (예: 1.2.0)`);
  process.exit(1);
}

manifest.version = target;
write("manifest.json", manifest);

// versions.json: 플러그인 버전 → 요구 최소 Obsidian 버전.
// 빌드 없는 자작 플러그인은 **한 줄형**으로 관리한다(현재 버전 하나만 남긴다) —
// tasks-gcal-sync 만 전 버전을 누적한다. BRAT 은 latest 릴리스를 보므로 어느 쪽이든 동작하지만,
// 플러그인별로 하던 방식을 유지한다. → [[자작 플러그인 배포 (BRAT)]]
write("versions.json", { [target]: manifest.minAppVersion });

console.log(`manifest.json / versions.json → ${target} (minAppVersion ${manifest.minAppVersion})`);
