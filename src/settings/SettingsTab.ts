import { Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./defaults";
import { categoryColorMap, okHex, resolveEventColorInfo } from "../core/colors";

export class GcalCalendarSettingTab extends PluginSettingTab {
    plugin: any;

    constructor(app: any, plugin: any) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** 복사 버튼이 달린 코드 샘플 한 덩어리. 설정 화면에서 바로 집어 갈 수 있게 한다. */
    sample(parent: any, label: string, code: string) {
        const box = parent.createEl("div");
        box.style.cssText = "margin:0 0 10px;";
        const head = box.createEl("div");
        head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:3px;";
        const cap = head.createEl("span", { text: label });
        cap.style.cssText = "font-size:11px;opacity:.6;";
        const btn = head.createEl("button", { text: "복사" });
        btn.style.cssText = "font-size:11px;padding:1px 8px;border-radius:10px;cursor:pointer;";
        btn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(code);
                btn.setText("복사됨");
                setTimeout(() => btn.setText("복사"), 1200);
            } catch (e) {
                new Notice("복사 실패: " + e.message);
            }
        };
        const pre = box.createEl("pre");
        pre.style.cssText =
            "font-size:11px;padding:8px;border-radius:4px;background:var(--background-secondary);" +
            "margin:0;white-space:pre;overflow-x:auto;user-select:text;";
        pre.setText(code);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        // ── 사용법: 편집 대상이 아니라 붙박이 설명이다 ──
        // 예전에는 이 내용을 노트마다 콜아웃으로 복붙해 뒀다. 노트에서 지우면 조작법을
        // 어디서도 찾을 수 없게 되므로, 잊어버리지 않게 설정 화면 맨 위에 박아 둔다.
        containerEl.createEl("h3", { text: "사용법" });
        const usage = containerEl.createEl("div");
        usage.style.cssText = "font-size:12px;line-height:1.7;opacity:.85;";
        usage.createEl("p", { text: "노트에 코드블록으로 넣는다:" }).style.margin = "0 0 6px";

        this.sample(usage, "이 노트가 놓인 폴더 이하 (기본)", "```gcal-calendar\n```");
        this.sample(usage, "볼트 전체", "```gcal-calendar\nscope: vault\n```");
        this.sample(
            usage,
            "소스 쿼리 직접 지정 · 이 블록에만 붙일 설명(여러 줄, 마크다운)",
            "```gcal-calendar\n" +
                'source: "0. Note/1. Project" and !"Template"\n' +
                "note: - 이 프로젝트의 할 일만 모읍니다.\n" +
                "note: - **마감 임박**한 것부터 처리할 것.\n" +
                "note: - 배경은 [[프로젝트 개요]] 참고.\n" +
                "```"
        );
        this.sample(
            usage,
            "이 블록에 그릴 Google Calendar 일정 고르기 (#gcal/ 태그와 같은 이름, 쉼표로 구분)",
            "```gcal-calendar\ngcal: Growth, Routine\n```"
        );
        this.sample(
            usage,
            "특정 캘린더만 빼기 · 이 블록에서는 일정을 아예 안 그리기(task 전용)",
            "```gcal-calendar\ngcal-exclude: Event\n```\n\n" +
                "```gcal-calendar\ngcal: off\n```"
        );

        const ul = usage.createEl("ul");
        ul.style.cssText = "margin:0 0 4px;padding-left:18px;";
        for (const t of [
            "태스크는 기간 막대(🛫 start ~ 📅 due)로 표시. start 없으면 due 하루짜리 막대.",
            "막대·트레이 카드를 날짜로 드래그 = 기간째 이동(놓은 칸 = 🛫 시작일, 없으면 📅 마감일).",
            "Shift + 드래그 = 📅 마감일만 조정 (🛫 없으면 생성).",
            "일간 보기: 블록 드래그 = 시각 이동(15분 단위) · 아래끝 드래그 = 종료 시각 · 종일 줄 ↔ 그리드 = 시각 부여/제거.",
            "일간 보기에서 끌면 착지 지점에 그림자와 시각 배지가 뜬다 — 마우스 커서가 아니라 그 그림자에 맞춰 놓는다.",
            "클릭 = 원본 열기(현재 탭) · Ctrl+클릭 = 새 탭 · Ctrl+Shift+클릭 = 분할 창 · 우클릭 = Tasks 편집 모달.",
            "📥 날짜 없음 / 🔴 지연 카드의 빠른 버튼·날짜선택기로도 마감일 변경.",
            "카테고리 필터의 «전체» 버튼은 토글이다 — 다 켜져 있으면 «전체 해제», 비우고 볼 것만 켜면 된다.",
            "변경은 노트에 바로 쓰이고 tasks-gcal-sync 가 Google Calendar 로 올린다.",
            "시각(⏰)은 일간 보기 드래그로만 넣는다 — 줄 끝에 적으면 Tasks 가 📅 까지 못 읽는다.",
            "📆 는 Google Calendar 일정(읽기 전용)이다 — 드래그·클릭·편집이 되지 않는다. 색은 같은 이름의 카테고리를 따른다.",
            "gcal: / gcal-exclude: 의 값은 #gcal/ 태그와 같은 캘린더 이름이다. 동기화 플러그인 설정에서 고른 캘린더의 부분집합이라, 여기 적었다고 안 고른 캘린더를 가져오지는 않는다.",
        ]) {
            ul.createEl("li", { text: t });
        }

        // ── 모바일 화면 ──
        // 사용법 바로 밑에 둔다. 폰에서 화면이 달라 보이는 이유를 여기서 처음 만나야 한다.
        containerEl.createEl("h3", { text: "모바일" });
        new Setting(containerEl)
            .setName("모바일 화면")
            .setDesc(
                "폰에서는 드래그·우클릭이 터치에서 동작하지 않아 조작이 불가능합니다. " +
                "모바일 화면은 월간 요약과 날짜별 목록으로 그리고, 항목을 탭하면 뜨는 " +
                "액션시트에서 마감일·시작일·시각을 고칩니다. " +
                "«자동» 은 폰에서만 켜집니다 — 태블릿은 폰으로 잡히지 않으니 «항상» 을 쓰세요."
            )
            .addDropdown((d) => {
                d.addOption("auto", "자동 (폰에서만)");
                d.addOption("always", "항상");
                d.addOption("off", "끄기");
                d.setValue(this.plugin.settings.mobileUi || "auto");
                d.onChange(async (v) => {
                    this.plugin.settings.mobileUi = v;
                    await this.plugin.saveSettings();
                    this.plugin.refreshAll();   // 설정 창을 닫기 전에 바로 보이게 (hide() 를 기다리지 않는다)
                });
            });

        containerEl.createEl("h3", { text: "카테고리" });
        const desc = containerEl.createEl("p", {
            text: "task 의 #gcal/<key> 태그로 분류된다. 색을 Google Calendar 의 커스텀 색과 맞추면 캘린더와 GCal 이 같은 색으로 보인다.",
        });
        desc.style.cssText = "font-size:12px;opacity:.7;margin:0 0 4px;";
        // 입력칸이 셋뿐이라 무엇을 넣는 칸인지 placeholder 만으로는 헷갈린다.
        const cols = containerEl.createEl("p", { text: "key (#gcal/<key>)  ·  표시 이름  ·  색" });
        cols.style.cssText = "font-size:11px;opacity:.5;margin:0 0 6px;";

        this.plugin.settings.categories.forEach((cat: any, i: number) => {
            const row = new Setting(containerEl);
            row.infoEl.remove();   // 라벨 칸 없이 입력만 나열
            // 폰에서는 [key][표시 이름][색][🗑] 넷이 한 줄에 들어가면 입력칸이 수십 px 로
            // 찌그러져 타이핑이 안 된다. 폭이 좁을 때만 세로로 쌓는다(데스크탑은 그대로).
            if (Platform.isPhone) {
                row.settingEl.style.cssText = "display:block;padding:8px 0;";
                row.controlEl.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;";
            }
            row.addText((t) => {
                if (Platform.isPhone) t.inputEl.style.cssText = "flex:1 1 100%;min-width:0;";
                t.setPlaceholder("key (예: work)").setValue(cat.key).onChange(async (v) => {
                    cat.key = v.trim();
                    await this.plugin.saveSettings();
                });
            });
            row.addText((t) => {
                if (Platform.isPhone) t.inputEl.style.cssText = "flex:1 1 100%;min-width:0;";
                t.setPlaceholder("표시 이름").setValue(cat.label).onChange(async (v) => {
                    cat.label = v;
                    await this.plugin.saveSettings();
                });
            });
            row.addColorPicker((c) =>
                c.setValue(cat.color).onChange(async (v) => {
                    cat.color = v;
                    await this.plugin.saveSettings();
                })
            );
            row.addExtraButton((b) =>
                b.setIcon("trash").setTooltip("삭제").onClick(async () => {
                    this.plugin.settings.categories.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
        });

        new Setting(containerEl).addButton((b) =>
            b.setButtonText("카테고리 추가").onClick(async () => {
                this.plugin.settings.categories.push({ key: "", label: "", color: "#7f8c8d" });
                await this.plugin.saveSettings();
                this.display();
            })
        );

        new Setting(containerEl)
            .setName("기본 카테고리")
            .setDesc("#gcal/ 태그가 없는 task 에 쓰인다. 색 폴백도 겸한다.")
            .addDropdown((d) => {
                for (const c of this.plugin.settings.categories) {
                    if (c.key) d.addOption(c.key, c.label || c.key);
                }
                d.setValue(this.plugin.settings.defaultCategory);
                d.onChange(async (v) => {
                    this.plugin.settings.defaultCategory = v;
                    await this.plugin.saveSettings();
                });
            });

        // ── GCal 일정 캘린더 ──
        // 색은 전부 여기 있다. 어느 캘린더를 가져올지는 tasks-gcal-sync 가 정하고,
        // 어떻게 그릴지는 여기서 정한다 — 카테고리 색 바로 아래라 눈으로 맞출 수 있다.
        containerEl.createEl("h3", { text: "GCal 일정 캘린더 (읽기 전용)" });
        containerEl.createEl("p", {
            text:
                "tasks-gcal-sync 설정의 «캘린더 뷰에 표시할 일정» 에서 고른 캘린더의 회의·약속이 " +
                "📆 로 그려집니다. 기본은 같은 이름의 카테고리 색을 따르므로 (예: Growth 캘린더 → " +
                "위의 growth 카테고리), 보통은 손댈 게 없습니다.",
            cls: "setting-item-description",
        });

        const feed = this.plugin.gcalFeed();
        const sel = feed ? feed.listSelectedCalendars() : [];
        if (!sel.length) {
            containerEl.createEl("p", {
                text: feed
                    ? "고른 캘린더가 없습니다. tasks-gcal-sync 설정 → «캘린더 뷰에 표시할 일정» 에서 고르세요."
                    : "tasks-gcal-sync 가 없거나(모바일·미설치) 아직 인증/선택 전입니다.",
                cls: "setting-item-description",
            });
        }

        const catColor = categoryColorMap(this.plugin.settings);
        for (const c of sel) {
            const info = resolveEventColorInfo(this.plugin.settings, catColor, c.id, c.name);
            const own = okHex((this.plugin.settings.eventColors || {})[c.id]);
            new Setting(containerEl)
                .setName(c.name)
                .setDesc(`${info.source} ${info.color}`)
                .addColorPicker((p) =>
                    // 따르는 중이어도 **실제로 그려질 색**을 보여준다. 여기 보이는 색과
                    // 화면의 막대 색이 다르면 그것만으로 버그다.
                    p.setValue(info.color).onChange(async (v) => {
                        this.plugin.settings.eventColors = {
                            ...(this.plugin.settings.eventColors || {}),
                            [c.id]: v,
                        };
                        await this.plugin.saveSettings();
                        this.display();
                    })
                )
                .addExtraButton((b) =>
                    b
                        .setIcon("rotate-ccw")
                        .setTooltip("카테고리 색으로 되돌리기")
                        .setDisabled(!own)
                        .onClick(async () => {
                            const next = { ...(this.plugin.settings.eventColors || {}) };
                            delete next[c.id];
                            this.plugin.settings.eventColors = next;
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );
        }

        new Setting(containerEl)
            .setName("기본 색")
            .setDesc("같은 이름의 카테고리가 없는 캘린더에 쓰입니다 (예: Holidays in South Korea).")
            .addColorPicker((p) =>
                p.setValue(okHex(this.plugin.settings.eventColor) || "#7f8c8d").onChange(async (v) => {
                    this.plugin.settings.eventColor = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addExtraButton((b) =>
                b
                    .setIcon("rotate-ccw")
                    .setTooltip("기본값(#7f8c8d)으로 되돌리기")
                    .onClick(async () => {
                        this.plugin.settings.eventColor = DEFAULT_SETTINGS.eventColor;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );
    }

    hide() {
        // 설정 창을 닫을 때 한 번만 다시 그린다 — 타이핑 한 글자마다 재렌더하면 눈이 아프다.
        this.plugin.refreshAll();
    }
}
