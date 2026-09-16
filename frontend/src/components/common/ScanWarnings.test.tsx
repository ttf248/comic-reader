import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ScanWarnings from "./ScanWarnings";

describe("ScanWarnings", () => {
  it("默认折叠告警详情，并在展开后显示脱敏路径与截断提示", () => {
    render(
      <ScanWarnings
        total={3}
        warnings={[
          {
            code: "directory_unreadable",
            path: "books/private",
            message: "目录无法读取",
          },
          {
            code: "metadata_unavailable",
            path: "books/video.mp4",
            message: "无法读取媒体元数据",
          },
        ]}
      />,
    );

    const toggle = screen.getByRole("button", { name: /扫描发现 3 个问题/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "扫描问题详情" }),
    ).toBeInTheDocument();
    expect(screen.getByText("books/private")).toBeInTheDocument();
    expect(screen.getByText("目录无法读取")).toBeInTheDocument();
    expect(
      screen.getByText("仅展示前 2 条，完整数量为 3 条。"),
    ).toBeInTheDocument();
  });

  it("没有告警时不渲染入口", () => {
    const { container } = render(<ScanWarnings total={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
