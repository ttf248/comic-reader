import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

test("保存媒体根后自动扫描，等价配置不重扫", async ({ page,request }) => {
  const original=await (await request.get("/api/config")).json() as {mediaRoots:{path:string;kind:"photo"|"comic"}[]};
  const live=original.mediaRoots.filter(root=>existsSync(root.path));
  const root=path.join(path.dirname(live[0].path),"auto-scan-media");
  const album=path.join(root,"automatic-album");
  mkdirSync(album,{recursive:true});
  writeFileSync(path.join(album,"page.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=","base64"));
  const starts:string[]=[];
  page.on("request",req=>{ if(new URL(req.url()).pathname==="/api/scans" && req.method()==="POST") starts.push(req.url()); });
  try {
    await request.put("/api/config",{data:{mediaRoots:live}});
    await page.goto("/settings");
    const saved=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/config" && response.request().method()==="PUT");
    await page.getByRole("textbox",{name:"媒体根目录 1",exact:true}).fill(root);
    await page.getByRole("textbox",{name:"媒体根目录 1",exact:true}).press("Enter");
    const response=await saved;
    expect(response.ok()).toBeTruthy();
    const result=await response.json() as {scanId?:string;mediaRootsChanged:boolean};
    expect(result.mediaRootsChanged).toBe(true);expect(result.scanId).toBeTruthy();
    await expect.poll(async()=>{
      const response=await request.get("/api/library/manifest");
      if(!response.ok())return 0;
      return ((await response.json()) as {manifest:{statistics:{photoAlbumCount:number}}}).manifest.statistics.photoAlbumCount;
    }).toBe(1);
    expect(starts).toHaveLength(0);
    const confirmed=await (await request.get("/api/config")).json() as typeof original;
    const same=await request.put("/api/config",{data:{mediaRoots:[...confirmed.mediaRoots].reverse()}});
    const unchanged=await same.json() as {mediaRootsChanged:boolean;scanId?:string};
    expect(unchanged.mediaRootsChanged).toBe(false);expect(unchanged.scanId).toBeUndefined();
    mkdirSync(".smoke/roadmap-auto-scan",{recursive:true});
    await page.screenshot({path:".smoke/roadmap-auto-scan/settings.png",fullPage:true});
  } finally { await request.put("/api/config",{data:{mediaRoots:live}}); }
});
