import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { prefsApi } from "../../api/prefs";
import { ApiError } from "../../api/client";
import { stateBackupApi, type StatePreview } from "../../api/stateBackup";
import StateBackupPanel from "./StateBackupPanel";

vi.mock("../../api/stateBackup", async (original) => ({
  ...(await original<typeof import("../../api/stateBackup")>()),
  stateBackupApi: { export: vi.fn(), preview: vi.fn(), restore: vi.fn() },
}));
vi.mock("../../api/prefs", () => ({ prefsApi: { get: vi.fn() } }));
const preview: StatePreview = {
  versions: { preferences: "one", activities: "two", covers: "three" },
  libraryRevision: 1,
  ready: true,
  counts: {
    favorites: 1,
    history: 0,
    preferences: 1,
    activities: 0,
    covers: 0,
  },
  missing: { favorites: 1 },
  skippedCovers: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(stateBackupApi.preview).mockResolvedValue(preview);
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StateBackupPanel />
    </QueryClientProvider>,
  );
  return client;
}
async function chooseFile() {
  const file = new File(["{}"], "backup.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => '{"version":1}' });
  fireEvent.change(screen.getByLabelText("状态备份文件"), {
    target: { files: [file] },
  });
  await screen.findByRole("button", { name: "确认覆盖恢复" });
}

it("预览后可仅覆盖收藏，保留其他类别并展示结果", async () => {
  vi.mocked(stateBackupApi.restore).mockResolvedValue({
    completed: ["favorites"],
    pending: [],
    skippedCovers: 0,
  });
  setup();
  await chooseFile();
  expect(screen.getByText(/1 条资源缺失/)).toBeInTheDocument();
  for (const name of [
    /最近访问 ·/,
    /服务端偏好 ·/,
    /阅读与播放活动 ·/,
    /自定义封面 ·/,
  ])
    fireEvent.click(screen.getByRole("checkbox", { name }));
  fireEvent.click(screen.getByRole("button", { name: "确认覆盖恢复" }));
  await waitFor(() =>
    expect(stateBackupApi.restore).toHaveBeenCalledWith(
      { version: 1 },
      ["favorites"],
      preview,
    ),
  );
  expect(await screen.findByText("已完成：收藏")).toBeInTheDocument();
});

it("预览过期要求重新预览，恢复请求不自动重放", async () => {
  vi.mocked(stateBackupApi.restore).mockRejectedValue(
    new ApiError(409, "changed", undefined, "state_changed"),
  );
  setup();
  await chooseFile();
  fireEvent.click(screen.getByRole("button", { name: "确认覆盖恢复" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "预览后状态已有变化",
  );
  expect(stateBackupApi.restore).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "确认覆盖恢复" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新预览备份" }));
  await waitFor(() => expect(stateBackupApi.preview).toHaveBeenCalledTimes(2));
});

it("部分失败显示已完成和未执行类别", async () => {
  vi.mocked(stateBackupApi.restore).mockResolvedValue({
    completed: ["favorites", "history", "preferences"],
    failed: "activities",
    pending: ["covers"],
    code: "state_restore_failed",
    skippedCovers: 0,
  });
  vi.mocked(prefsApi.get).mockRejectedValue(new Error("offline"));
  setup();
  await chooseFile();
  fireEvent.click(screen.getByRole("button", { name: "确认覆盖恢复" }));
  // 模拟偏好重新读取失败：已完成写入的报告仍须保留。
  expect(
    await screen.findByText("已完成：收藏、最近访问、服务端偏好"),
  ).toBeInTheDocument();
  expect(screen.getByText("未执行：自定义封面")).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("恢复结果已确认");
});

it("不完整 JSON 不发送预览请求", async () => {
  setup();
  const file = new File(["invalid"], "bad.json");
  Object.defineProperty(file, "text", { value: async () => "invalid" });
  await act(async () =>
    fireEvent.change(screen.getByLabelText("状态备份文件"), {
      target: { files: [file] },
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 JSON");
  expect(stateBackupApi.preview).not.toHaveBeenCalled();
});
