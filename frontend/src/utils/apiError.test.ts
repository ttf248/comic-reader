import { describe, it, expect } from "vitest";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "./apiError";

describe("apiErrorMessage", () => {
  it("按错误码给出中文提示", () => {
    const error = new ApiError(
      400,
      "resource type does not support this operation",
      undefined,
      "invalid_resource_kind",
    );
    expect(apiErrorMessage(error, "加载失败")).toBe(
      "该目录不是相册，无法读取其中的媒体",
    );
  });

  it("未知错误码使用兜底文案，不把英文原文抛给用户", () => {
    const error = new ApiError(500, "boom", undefined, "some_new_code");
    expect(apiErrorMessage(error, "加载失败")).toBe("加载失败");
  });

  it("没有错误码时也使用兜底文案", () => {
    const error = new ApiError(502, "Bad Gateway");
    expect(apiErrorMessage(error, "无法连接服务")).toBe("无法连接服务");
  });

  it("网络层异常使用兜底文案", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "无法连接服务")).toBe(
      "无法连接服务",
    );
  });
});
