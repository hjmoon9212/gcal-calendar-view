// 버전 일괄 관리 스크립트.
// 사용법:
//   node version-bump.mjs 1.2.0   → manifest.json / package.json / versions.json 을 1.2.0 으로 통일
//   node version-bump.mjs         → manifest.json 의 현재 version 기준으로 나머지 둘만 동기화
//
// 배포 절차(0.7.0~ 빌드형):
//   1) npm test && npm run build && npm run smoke
//   2) node version-bump.mjs <버전>
//   3) git commit … && git push origin main
//   4) git tag <버전> && git push origin <버전>   # v 접두사 없이 manifest.version 과 동일
// 태그 push → .github/workflows/release.yml 이 빌드·테스트 후 Release 를 생성 → BRAT 가 내려받는다.
// main.js 는 저장소에 없다(gitignore) — CI 가 src/ 에서 만든다.
import { readFileSync, writeFileSync, existsSync } from "fs";

const write = (f, obj) => writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.argv[2] ?? manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`버전 형식이 올바르지 않습니다: ${target} (예: 1.2.0)`);
  process.exit(1);
}

manifest.version = target;
write("manifest.json", manifest);

if (existsSync("package.json")) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  pkg.version = target;
  write("package.json", pkg);
}

// versions.json: 플러그인 버전 → 요구 최소 Obsidian 버전.
// 이 플러그인은 **한 줄형**으로 관리한다(현재 버전 하나만 남긴다) — tasks-gcal-sync 만 전 버전을
// 누적한다. BRAT 은 latest 릴리스를 보므로 어느 쪽이든 동작하지만, 플러그인별로 하던 방식을
// 유지한다. → [[자작 플러그인 배포 (BRAT)]]
write("versions.json", { [target]: manifest.minAppVersion });

console.log(`manifest.json / package.json / versions.json → ${target} (minAppVersion ${manifest.minAppVersion})`);
