import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { crc32, deflateSync } from "node:zlib";
import { existsSync } from "node:fs";

// 生成一张纯色 PNG：用于验证阅读器按像素显示（原始尺寸）时，
// 图片不会被视口宽度夹住。测试素材目录是脚本建的临时目录。
export function solidPng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function renderedColors(locator: Locator, properties: string[]) {
  return locator.evaluate((element, properties) => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("无法读取渲染颜色");
    const style = getComputedStyle(element);
    return properties.map((property) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.getPropertyValue(property);
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
  }, properties);
}

export interface ManifestResponse {
  manifest: {
    scannedAt: string;
    roots: Array<{ id: string; contentKind?: string }>;
  };
}

/** 媒体根：路径 + 内容属性（照片 / 漫画，两者互斥）。 */
export interface MediaRootConfig {
  path: string;
  kind: "photo" | "comic";
}

export async function serverConfig(request: APIRequestContext) {
  return (await (await request.get("/api/config")).json()) as {
    mediaRoots: MediaRootConfig[];
  };
}

// 临时服务启动时带一个不存在的目录，用来验证「离线根不阻止启动」；
// 其余用例先把它摘掉，只留照片根与漫画根这两个真实目录。
export async function liveRoots(request: APIRequestContext) {
  const config = await serverConfig(request);
  const live = config.mediaRoots.filter((root) => existsSync(root.path));
  if (live.length !== config.mediaRoots.length) {
    const response = await request.put("/api/config", {
      data: { mediaRoots: live },
    });
    expect(response.ok()).toBeTruthy();
  }
  return live;
}

/**
 * 扫描后取某个内容属性的根目录直属相册。
 *
 * kind 是必填的：照片与漫画是两个互斥的库，测试要明确站在哪一边。
 */
export async function scannedNodes(
  request: APIRequestContext,
  kind: "photo" | "comic" = "photo",
) {
  await liveRoots(request);
  const before = (await (
    await request.get("/api/library/manifest")
  ).json()) as Partial<ManifestResponse>;
  const previousScannedAt = before.manifest?.scannedAt;
  expect((await request.post("/api/scans")).ok()).toBeTruthy();
  await expect
    .poll(async () => {
      const response = await request.get("/api/library/manifest");
      if (!response.ok()) return previousScannedAt;
      return ((await response.json()) as ManifestResponse).manifest.scannedAt;
    })
    .not.toBe(previousScannedAt);
  const manifest = (await (
    await request.get("/api/library/manifest")
  ).json()) as ManifestResponse;
  const root = manifest.manifest.roots.find(
    (item) => item.contentKind === kind,
  );
  expect(root, `${kind} 根目录缺失`).toBeTruthy();
  const response = await request.get(
    `/api/library/${root!.id}/children?limit=200&kind=${kind}`,
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    page: {
      items: Array<{
        id: string;
        name: string;
        imageCount?: number;
        modTime?: string;
        date?: string;
        contentKind?: string;
      }>;
    };
  };
  return body.page.items;
}

/**
 * 相册页地址：模式进 URL 路径，落在相册自己所属的那一侧。
 *
 * 相册的链接必须跟着它的目录属性走 —— 照片相册在 /photo/albums/…，
 * 漫画相册在 /comic/albums/…。
 */
export function albumUrl(node: { id: string; contentKind?: string }) {
  return `/${node.contentKind ?? "photo"}/albums/${node.id}`;
}

/** 相册页地址的正则：用于断言浏览器当前停在哪一页。 */
export function albumUrlPattern(node: { id: string; contentKind?: string }) {
  return new RegExp(`/${node.contentKind ?? "photo"}/albums/${node.id}$`);
}

/** 漫画阅读器地址。阅读器只属于漫画侧。 */
export function readerUrl(albumId: string, query = "") {
  return `/comic/read/${encodeURIComponent(albumId)}${query}`;
}

// 工作台模式是服务端偏好，整条用例链共用同一个临时服务。侧栏的模式切换
// 会写服务端偏好，所以每个用例开始前把它复位成「照片」，避免上一条用例
// 留下的模式污染这一条的措辞断言。
export async function setWorkbenchMode(
  request: APIRequestContext,
  mode: "photo" | "comic",
) {
  const response = await request.patch("/api/prefs", {
    data: { appMode: mode },
  });
  expect(response.ok()).toBeTruthy();
}

export async function resetWorkbenchMode(request: APIRequestContext) {
  await setWorkbenchMode(request, "photo");
}

export const taggedSortPrefix =
  "zz-[测试][空 格][C++][100%][字面%20][字面%2F][字面%25] tagged-";

export async function sortFixture(request: APIRequestContext) {
  // 排序用例覆盖「未读」页，未读属于漫画工作台，因此素材取漫画根。
  const nodes = await scannedNodes(request, "comic");
  const rootAlbums = ["A", "M", "Z"].map((suffix) =>
    nodes.find((node) => node.name === taggedSortPrefix + suffix)!,
  );
  for (const node of rootAlbums) expect(node).toBeDefined();
  const collection = nodes.find((node) => node.name === "zz-sort-collection")!;
  expect(collection).toBeDefined();
  const response = await request.get(
    `/api/library/${collection.id}/children?limit=200&kind=comic`,
  );
  expect(response.ok()).toBeTruthy();
  const children = (await response.json()) as {
    page: { items: Array<{ id: string; name: string; imageCount?: number }> };
  };
  const childAlbums = ["A", "M", "Z"].map((suffix) =>
    children.page.items.find(
      (node) => node.name === taggedSortPrefix + suffix,
    )!,
  );
  for (const node of childAlbums) expect(node).toBeDefined();
  return { rootAlbums, childAlbums, collectionId: collection.id };
}

export async function restoreHistory(
  request: APIRequestContext,
  original: {
    maxRecent: number;
    history: Array<{ albumId: string; name: string; imageCount: number }>;
  },
) {
  expect(
    (
      await request.patch("/api/prefs", {
        data: { maxRecent: original.maxRecent },
      })
    ).ok(),
  ).toBeTruthy();
  expect((await request.delete("/api/history")).ok()).toBeTruthy();
  for (const entry of [...original.history].reverse())
    expect(
      (await request.post("/api/history", { data: entry })).ok(),
    ).toBeTruthy();
}

export async function openCardProperties(page: Page, nodeId: string) {
  const card = page.locator(
    `main [data-virtuoso-scroller] a[href="/photo/albums/${nodeId}"]`,
  );
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "属性", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "属性", exact: true });
  await expect(dialog).toBeVisible();
  return { card, dialog };
}

export interface CopyAudit {
  apiValues: string[];
  selections: Array<{
    command: string;
    value: string;
    selectedValue: string;
    insideModal: boolean;
    focused: boolean;
  }>;
  throwOnSelection: boolean;
}

export type CopyAuditWindow = Window & { __copyAudit: CopyAudit };

export async function installCopyAudit(
  page: Page,
  mode: "api" | "missing" | "denied",
) {
  // 隔离系统剪贴板，记录浏览器中的真实焦点和选区。
  await page.addInitScript((mode) => {
    const audit: CopyAudit = {
      apiValues: [],
      selections: [],
      throwOnSelection: mode === "denied",
    };
    (window as CopyAuditWindow).__copyAudit = audit;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        mode === "missing"
          ? undefined
          : {
              writeText(value: string) {
                audit.apiValues.push(value);
                return mode === "api"
                  ? Promise.resolve()
                  : Promise.reject(new Error("test denied"));
              },
            },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value(command: string) {
        const textarea = document.querySelector("textarea");
        const selection = {
          command,
          value: textarea?.value ?? "",
          selectedValue:
            textarea?.value.slice(
              textarea.selectionStart,
              textarea.selectionEnd,
            ) ?? "",
          insideModal: Boolean(textarea?.closest("dialog:modal")),
          focused: document.activeElement === textarea,
        };
        audit.selections.push(selection);
        if (audit.throwOnSelection) throw new Error("test copy failed");
        return selection.focused && selection.value === selection.selectedValue;
      },
    });
  }, mode);
}

export const systemOpenRoute = /\/api\/(?:admin\/fs|fs)\/open(?:\?|$)/;

export function systemOpenRequest(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  return {
    endpoint: url.pathname,
    method: request.method(),
    body:
      request.method() === "POST" ? (request.postDataJSON() as unknown) : null,
    path: url.searchParams.get("path"),
    allowConfig: url.searchParams.get("allowConfig"),
  };
}

// 复用已经发布的测试库；需要验证重扫的用例使用 scannedNodes。
export async function ensureLibraryReady(request: APIRequestContext) {
  await liveRoots(request);
  if (!(await request.get("/api/library/manifest")).ok()) {
    expect((await request.post("/api/scans")).ok()).toBeTruthy();
  }
  await expect
    .poll(async () => (await request.get("/api/library/manifest")).status())
    .toBe(200);
}

/**
 * 让临时库带上 EXIF 解析结果。
 *
 * 坐标不是扫描时读出来的，而是元数据分析任务的产物：不跑过这一趟，库里
 * 一张带位置的照片都没有，足迹页也就没有行程可讲。已经有结果时直接返回，
 * 免得每条用例都等一遍全量分析。
 */
export async function ensureMetadataReady(request: APIRequestContext) {
  const trips = await request.get(
    "/api/locations/china/trips?granularity=city",
  );
  if (trips.ok()) {
    const body = (await trips.json()) as { trips: { total: number } };
    if (body.trips.total > 0) return;
  }
  const started = await request.post("/api/ai/jobs", {
    data: { type: "metadata", mode: "full" },
  });
  // 409 表示已有任务在跑：等那一个，不抢。
  expect(started.ok() || started.status() === 409).toBeTruthy();
  const jobId = started.ok()
    ? ((await started.json()) as { job: { id: string } }).job.id
    : await activeJobId(request);
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/ai/jobs/${encodeURIComponent(jobId)}`,
        );
        if (!response.ok()) return "missing";
        return ((await response.json()) as { job: { status: string } }).job
          .status;
      },
      { timeout: 180_000 },
    )
    .toMatch(/^(completed|failed|cancelled)$/);
}

/** 正在跑的那个分析任务。 */
async function activeJobId(request: APIRequestContext) {
  const response = await request.get("/api/ai/jobs");
  const body = (await response.json()) as {
    snapshot: { jobs: { id: string; status: string }[]; queue: string[] };
  };
  const running = body.snapshot.jobs.find(
    (job) => job.status === "running" || job.status === "pending",
  );
  expect(running, "没有正在运行的分析任务").toBeTruthy();
  return running!.id;
}
