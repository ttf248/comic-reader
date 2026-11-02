import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("子组件抛错时显示可读提示，而不是整页空白", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): React.ReactElement {
      throw new Error("渲染炸了");
    }

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("图像库加载异常");
    expect(alert).toHaveTextContent("渲染炸了");
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
  });

  it("点击重试会重新渲染子树", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let boom = true;
    function MaybeBoom(): React.ReactElement {
      if (boom) throw new Error("第一次渲染失败");
      return <div>恢复正常</div>;
    }

    render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    boom = false;
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    expect(screen.getByText("恢复正常")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
