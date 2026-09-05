/** Follow content growth using the position BEFORE mutation, not the new bottom. */
export class ChatScrollFollower {
  private revision = 0;
  private lastTop: number;
  private disposed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private onScroll = () => {
    if (this.el.scrollTop < this.lastTop - 1) this.revision++;
    this.lastTop = this.el.scrollTop;
  };
  private onWheel = (event: WheelEvent) => { if (event.deltaY < 0) this.revision++; };
  private onTouch = () => { this.revision++; };
  private onKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) this.revision++;
  };

  constructor(private el: HTMLElement, private enabled: () => boolean) {
    this.lastTop = el.scrollTop;
    el.addEventListener("scroll", this.onScroll, { passive: true });
    el.addEventListener("wheel", this.onWheel, { passive: true });
    el.addEventListener("touchmove", this.onTouch, { passive: true });
    el.addEventListener("keydown", this.onKey);
  }

  nearBottom(threshold = 80): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight <= threshold;
  }

  capture(): () => void {
    const follow = this.enabled() && this.nearBottom();
    const revision = this.revision;
    return () => {
      if (follow && revision === this.revision && !this.disposed) this.scroll(true, true);
    };
  }

  scroll(immediate = true, force = false): void {
    if (this.disposed || !this.enabled() || (!force && !this.nearBottom())) return;
    const revision = this.revision;
    const apply = () => {
      if (this.disposed || !this.enabled() || revision !== this.revision) return;
      this.el.scrollTop = this.el.scrollHeight;
      this.lastTop = this.el.scrollTop;
    };
    // Coalesce compensation work during dense token/tool streams.
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (immediate) apply();
    for (const delay of [50, 150]) {
      const timer = setTimeout(() => { this.timers.delete(timer); apply(); }, delay);
      this.timers.add(timer);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.el.removeEventListener("scroll", this.onScroll);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("touchmove", this.onTouch);
    this.el.removeEventListener("keydown", this.onKey);
  }
}
