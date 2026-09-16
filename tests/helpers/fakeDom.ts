/**
 * 손으로 짠 가짜 DOM — 화면 트리를 **글자 그대로** 스냅샷하기 위한 것.
 *
 * jsdom 은 `style.cssText` 를 정규화해(순서·단축 속성·calc 처리) 바이트 비교가 안 된다.
 * 이 플러그인은 스타일을 전부 인라인 cssText 로 적으므로, 적은 그대로 남기는 쪽이 필요하다.
 * Obsidian 이 HTMLElement 에 붙이는 확장(createEl · createDiv · setText · empty)을 흉내낸다.
 */
export class FakeEl {
  tag: string;
  text = "";
  cls = "";
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  style: Record<string, any> = { cssText: "" };
  listeners: Record<string, ((e?: any) => any)[]> = {};
  onclick: ((e?: any) => any) | null = null;
  onchange: ((e?: any) => any) | null = null;
  onmousedown: ((e?: any) => any) | null = null;
  type = "";
  value = "";
  step = "";
  title = "";
  draggable = false;
  scrollTop = 0;
  removed = false;
  /** 캘린더는 문서에 붙어 있는지로 살아 있음을 판단한다(isAlive · 구독 후 재렌더). */
  isConnected = true;
  /** 높이는 재지 않는다 — 0 이면 캘린더가 minHeight 예약을 건너뛴다(결정적). */
  offsetHeight = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** 레인 계산이 쓰는 폭. 7칸 × 100px 로 두면 clientX 100 = 1칸이라 계산이 눈에 보인다. */
  rect = { left: 0, top: 0, width: 700, height: 1536 };
  classList = {
    add: (c: string) => this.addClass(c),
    remove: (c: string) => {
      this.cls = this.cls.split(" ").filter((x) => x && x !== c).join(" ");
    },
    contains: (c: string) => this.cls.split(" ").includes(c),
  };

  constructor(tag: string) {
    this.tag = tag;
  }

  /** 스크롤 컨테이너를 찾을 때 위로 거슬러 올라간다. */
  get parentElement(): FakeEl | null {
    return this.parent;
  }
  /** `replaceChildren(...box.childNodes)` — 조립한 트리를 한 번에 옮긴다. */
  get childNodes(): FakeEl[] {
    return this.children;
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(t: string) {
    this.text = t;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }
  contains(el: FakeEl | null): boolean {
    for (let e = el; e; e = e.parent) if (e === this) return true;
    return false;
  }
  removeEventListener(type: string, fn: (e?: any) => any): void {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((f) => f !== fn);
  }
  setPointerCapture(_id: number): void {}
  releasePointerCapture(_id: number): void {}
  /** 붙어 있는 리스너를 부른다. 테스트가 사용자 동작을 흉내내는 유일한 통로다. */
  fire(type: string, ev: any = {}): any[] {
    const e = { preventDefault() {}, stopPropagation() {}, ...ev };
    const out: any[] = [];
    if (type === "click" && this.onclick) out.push(this.onclick(e));
    if (type === "change" && this.onchange) out.push(this.onchange(e));
    if (type === "mousedown" && this.onmousedown) out.push(this.onmousedown(e));
    for (const fn of this.listeners[type] ?? []) out.push(fn(e));
    return out;
  }

  createEl(tag: string, o: { text?: string; cls?: string; attr?: Record<string, string> } = {}): FakeEl {
    const el = new FakeEl(tag);
    if (o.text !== undefined) el.text = o.text;
    if (o.cls) el.cls = o.cls;
    if (o.attr) Object.assign(el.attrs, o.attr);
    el.parent = this;
    this.children.push(el);
    return el;
  }
  createDiv(o: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("div", o);
  }
  createSpan(o: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("span", o);
  }
  appendChild(el: FakeEl): FakeEl {
    el.parent = this;
    this.children.push(el);
    return el;
  }
  replaceChildren(...els: FakeEl[]): void {
    this.children = [];
    for (const e of els) this.appendChild(e);
  }
  setText(t: string): void {
    this.text = t;
  }
  empty(): void {
    this.children = [];
  }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  setAttr(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (e?: any) => any): void {
    (this.listeners[type] ??= []).push(fn);
  }
  addClass(c: string): void {
    this.cls = this.cls ? `${this.cls} ${c}` : c;
  }
  /** obsidian 스텁의 Setting 레코더가 자신을 컨테이너에 붙일 때 부른다. */
  __push(node: { kind: string; setting: any }): void {
    const el = new FakeEl("setting");
    (el as any).setting = node.setting;
    el.parent = this;
    this.children.push(el);
  }
}

/** Setting 레코더 하나를 평범한 객체로. */
export function serializeSetting(s: any): any {
  const o: any = { name: s.nameText || undefined, desc: s.descText || undefined };
  if (s.infoRemoved) o.infoRemoved = true;
  const se = Object.entries(s.settingEl?.style ?? {}).filter(([, v]) => v);
  if (se.length) o.settingStyle = Object.fromEntries(se);
  const ce = Object.entries(s.controlEl?.style ?? {}).filter(([, v]) => v);
  if (ce.length) o.controlStyle = Object.fromEntries(ce);
  o.controls = s.controls.map((c: any) => {
    const x: any = { type: c.type };
    if ("value" in c) x.value = c.value;
    if (c.placeholder) x.placeholder = c.placeholder;
    if (c.options) x.options = c.options;
    if (c.inputEl) {
      const st = Object.entries(c.inputEl.style ?? {}).filter(([, v]) => v);
      if (st.length) x.inputStyle = Object.fromEntries(st);
      if (c.inputEl.type && c.inputEl.type !== "text") x.inputType = c.inputEl.type;
    }
    for (const k of ["buttonText", "icon", "tooltip"]) if (c[k]) x[k] = c[k];
    if (c.cta) x.cta = true;
    if (c.disabled) x.disabled = true;
    x.handler = !!(c.onChangeCb || c.onClickCb);
    return x;
  });
  return o;
}

/** 트리를 비교 가능한 평범한 객체로. 비어 있는 필드는 싣지 않는다. */
export function serializeEl(el: FakeEl): any {
  if ((el as any).setting) return { setting: serializeSetting((el as any).setting) };
  const o: any = { tag: el.tag };
  if (el.text) o.text = el.text;
  if (el.cls) o.cls = el.cls;
  if (Object.keys(el.attrs).length) o.attrs = el.attrs;
  const style: any = {};
  for (const [k, v] of Object.entries(el.style)) if (v !== "" && v !== undefined) style[k] = v;
  if (Object.keys(style).length) o.style = style;
  for (const k of ["type", "value", "step", "title"] as const) if (el[k]) o[k] = el[k];
  if (el.draggable) o.draggable = true;
  const handlers = [
    ...(el.onclick ? ["onclick"] : []),
    ...(el.onchange ? ["onchange"] : []),
    ...Object.keys(el.listeners).map((k) => `on:${k}`),
  ];
  if (handlers.length) o.handlers = handlers;
  if (el.children.length) o.children = el.children.map(serializeEl);
  return o;
}

/** 트리에서 조건에 맞는 요소를 문서 순서로 모은다. */
export function findAll(root: FakeEl, pred: (el: FakeEl) => boolean): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (e: FakeEl) => {
    if (pred(e)) out.push(e);
    e.children.forEach(walk);
  };
  walk(root);
  return out;
}
