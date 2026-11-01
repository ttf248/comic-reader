import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { hasAppHistory, useSafeBack } from "./navigation";

function BackButton({ fallback }: { fallback: string }) {
  const goBack = useSafeBack(fallback);
  const location = useLocation();
  return (
    <>
      <button onClick={goBack}>back</button>
      <output data-testid="loc">{location.pathname}</output>
    </>
  );
}

/** 模拟 React Router 写进 history.state 的应用内历史深度。 */
function setHistoryIdx(idx: number | undefined) {
  window.history.replaceState(
    idx === undefined ? null : { usr: null, key: "default", idx },
    "",
  );
}

describe("hasAppHistory", () => {
  beforeEach(() => {
    setHistoryIdx(undefined);
  });

  it("history.state 缺失或没有 idx 时视为没有应用内历史", () => {
    setHistoryIdx(undefined);
    expect(hasAppHistory()).toBe(false);
    window.history.replaceState({ usr: null, key: "default" }, "");
    expect(hasAppHistory()).toBe(false);
  });

  it("idx 大于 0 表示应用内还有可回退的历史", () => {
    setHistoryIdx(0);
    expect(hasAppHistory()).toBe(false);
    setHistoryIdx(2);
    expect(hasAppHistory()).toBe(true);
  });
});

describe("useSafeBack", () => {
  beforeEach(() => {
    setHistoryIdx(undefined);
  });

  it("没有应用内历史时回到兜底路由，而不是退出应用", () => {
    setHistoryIdx(0);
    render(
      <MemoryRouter initialEntries={["/gallery"]}>
        <BackButton fallback="/albums/a_1" />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("loc")).toHaveTextContent("/gallery");
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("loc")).toHaveTextContent("/albums/a_1");
  });

  it("兜底路由也可以是主页", () => {
    setHistoryIdx(0);
    render(
      <MemoryRouter initialEntries={["/albums/a_1"]}>
        <BackButton fallback="/" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("loc")).toHaveTextContent("/");
  });
});
