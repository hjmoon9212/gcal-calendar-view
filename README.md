# Gcal Calendar View

Obsidian 노트의 `#task` 를 **기간 막대**와 **타임블록**으로 그리는 캘린더. 막대를 끌어 날짜·시각을 바꾸면 노트의 `🛫`/`📅`/`⏰` 가 그 자리에서 수정되고, [`tasks-gcal-sync`](https://github.com/hjmoon9212/tasks-gcal-sync) 가 Google Calendar 로 올린다.

## 왜 플러그인인가

원래는 볼트마다 놓인 dataviewjs 스크립트(`Scripts/View/GcalCalendarView.js`)였다. 볼트가 둘이 되자 **사본이 갈라졌다** — 한쪽만 고치면 다른 쪽은 옛 동작으로 남고, 손으로 맞춰야 했다. 플러그인으로 옮기면 BRAT 이 모든 볼트·기기에 같은 버전을 배포하고, 볼트마다 달라야 하는 값(카테고리·색)은 코드가 아니라 **설정**에 둘 수 있다.

## 사용법

노트에 코드블록을 넣는다.

````markdown
```gcal-calendar
```
````

빈 블록이면 **이 노트가 놓인 폴더 이하**를 모은다. 노트를 옮기면 스코프도 따라간다.

````markdown
```gcal-calendar
scope: vault
```
````

볼트 전체(대시보드용).

````markdown
```gcal-calendar
source: "0. Note/1. Project" and !"Template"
```
````

Dataview 소스 쿼리를 직접 지정한다. `Template` 폴더는 어느 경우에도 제외된다.

````markdown
```gcal-calendar
note: 이 프로젝트 폴더의 할 일만 봅니다.
note: 마감 임박한 것부터 처리할 것.
```
````

**이 블록에서만** 다른 설명을 쓸 때 사용한다. 공통 설명은 아래 [설정](#설정)에 둔다 — 블록에 `note:` 가 있으면 그 블록에서는 이쪽이 이긴다.

`note:` 를 여러 줄 쓰면 줄바꿈으로 이어 붙이고 **마크다운으로 렌더**한다 — `**굵게**`·`` `코드` ``·`- 목록`·`[[링크]]` 가 그대로 동작한다.

````markdown
```gcal-calendar
note: - **드래그** = 기간째 이동(놓은 칸 = 🛫 시작일)
note: - **Shift+드래그** = 📅 마감일만 조정
note: - 변경은 `tasks-gcal-sync` 가 자동 푸시
```
````

| 옵션 | 값 | 기본 |
|---|---|---|
| `scope` | `vault` | (없음 = 노트가 놓인 폴더) |
| `source` | Dataview 소스 쿼리 | (없음) |
| `note` | 자유 텍스트 (여러 줄 가능) | (없음) |

## 조작

| 동작 | 결과 |
|---|---|
| 막대 드래그 | 기간째 이동 (놓은 칸 = 🛫 시작일, 없으면 📅 마감일) |
| Shift + 막대 드래그 | 📅 마감일만 조정 (🛫 없으면 생성) |
| 클릭 / Ctrl+클릭 / Ctrl+Shift+클릭 | 원본 열기 (현재 탭 / 새 탭 / 분할) |
| 우클릭 | Tasks 편집 모달 |
| 트레이 카드의 빠른 버튼·날짜선택기 | 마감일 변경 |
| **일간 보기** 블록 드래그 | 시각 이동 (길이 유지, 15분 스냅) |
| **일간 보기** 블록 아래끝 드래그 | 종료 시각만 변경 |
| 종일 줄 ↔ 시간 그리드 드래그 | 시각 부여 / 제거 |

## 타임블록 문법 — `⏰ HH:MM-HH:MM`

시각은 손으로 적지 않고 일간 보기에서 드래그로 넣는다. 삽입 위치가 중요하기 때문이다.

**`⏰` 는 반드시 첫 Tasks 필드 이모지 앞에 들어간다.** Obsidian Tasks 는 필드 정규식을 전부 `$` 앵커로 만들고 줄 끝에서부터 벗겨내며 파싱한다. 줄 끝에 Tasks 가 모르는 토큰이 있으면 첫 바퀴에 아무것도 매치되지 않아 **그 앞의 `📅`·`🛫` 까지 통째로 설명으로 흡수된다** — 마감일 기반 쿼리가 그 task 를 놓친다.

```
- [ ] #task #gcal/work 보고서 작성 ⏰ 14:00-15:00 📅 2026-08-20 🆔 ab12cd
                                   ^^^^^^^^^^^^^^ 필드들보다 앞
```

읽기 모드에서 `⏰` 를 숨기려면 [`hide-task-element`](https://github.com/hjmoon9212/hide-task-element) 를 함께 쓴다.

## 설정

설정 → 커뮤니티 플러그인 → Gcal Calendar View.

| 항목 | 내용 |
|---|---|
| **카테고리** | `#gcal/<key>` 로 분류되는 목록. key · 표시 이름 · 색을 편집한다. 볼트마다 다른 유일한 값이라 코드가 아니라 여기에 둔다 |
| **기본 카테고리** | `#gcal/` 태그가 없는 task 에 쓰인다. 색 폴백도 겸한다 |
| **캘린더 위에 표시할 설명** | 모든 캘린더 위에 공통으로 뜨는 마크다운. 예전에 노트마다 콜아웃으로 복붙해 두던 조작법을 여기 한 곳에 둔다 — 조작법이 바뀌면 여기만 고치면 모든 노트에 반영된다. 비우면 아무것도 그리지 않는다 |

설정 변경은 **플러그인을 껐다 켜지 않아도** 반영된다(설정 창을 닫을 때 열려 있는 캘린더를 다시 그린다).

## 요구 사항

- **Dataview** — 페이지 수집(`api.pages`)과 luxon 을 빌려 쓴다
- **Tasks** — 편집 모달(우클릭)에 쓰인다. 없으면 원본 줄로 이동만 한다

## 설치 (BRAT)

1. [BRAT](https://github.com/TfTHacker/obsidian42-brat) 설치
2. `Add beta plugin` → `hjmoon9212/gcal-calendar-view`
3. 설정 탭에서 카테고리(`#gcal/<key>`)와 색을 볼트에 맞게 조정

## 배포

빌드 단계가 없다(순수 JS).

```bash
node version-bump.mjs 0.2.0    # manifest.json + versions.json
git commit -am "v0.2.0"
git tag 0.2.0 && git push origin main 0.2.0
```

태그를 push 하면 `.github/workflows/release.yml` 이 `main.js`·`manifest.json`·`styles.css`·`versions.json` 을 첨부한 Release 를 만들고 BRAT 이 받아간다. 태그와 `manifest.json` 의 version 이 다르면 워크플로가 실패한다.
