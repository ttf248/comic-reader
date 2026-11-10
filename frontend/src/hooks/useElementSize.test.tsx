import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useElementSize } from "./useElementSize";

// jsdom 不实现 ResizeObserver；这里补一个最小的，只记录被观察的元素。
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  disconnect() {
    this.observed = [];
  }
  trigger() {
    this.callback();
  }
}

function Probe({ mount }: { mount: boolean }) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  return (
    <div>
      {mount ? <div ref={ref} data-testid="target" /> : null}
      <span data-testid="width">{width}</span>
    </div>
  );
}

function Later() {
  const [mount, setMount] = useState(false);
  const { ref, width } = useElementSize<HTMLDivElement>();
  return (
    <div>
      <button type="button" onClick={() => setMount(true)}>
        挂上
      </button>
      {mount ? <div ref={ref} data-testid="target" /> : null}
      <span data-testid="width">{width}</span>
    </div>
  );
}

describe("useElementSize", () => {
  it("元素首帧就在时量得到宽度", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const spy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(640);
    render(<Probe mount />);
    expect(screen.getByTestId("width").textContent).toBe("640");
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  // 回归：列表视图那一支是点「列表视图」才挂上去的。effect 只跑一次，
  // 首帧拿不到节点就永远量不到，列数会一直停在 1 列。
  it("元素后挂上时也能量到宽度", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const spy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(960);
    render(<Later />);
    expect(screen.getByTestId("width").textContent).toBe("0");
    act(() => {
      screen.getByRole("button", { name: "挂上" }).click();
    });
    expect(screen.getByTestId("width").textContent).toBe("960");
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
});
