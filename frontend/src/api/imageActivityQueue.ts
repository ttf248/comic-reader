import type { ActivityInput, ImageActivity } from "./activity";

type ImageInput = Extract<ActivityInput, { mediaKind: "image" }>;
type Waiter = {
  resolve: (value: ImageActivity) => void;
  reject: (reason: unknown) => void;
};
type ProgressTask = {
  kind: "progress";
  input: ImageInput;
  waiters: Waiter[];
};
type Task = ProgressTask | { kind: "barrier"; execute: () => Promise<void> };

// 一个浏览器会话只有一个图片写入者。尚未发送的同相册进度合并为最新值；
// 显式已读、删除和批量操作构成顺序边界，不会被跨过或合并。
export class ImageActivityQueue {
  private pending: Task[] = [];
  private running: Task | null = null;

  constructor(
    private readonly send: (input: ImageInput) => Promise<ImageActivity>,
  ) {}

  progress(input: ImageInput): Promise<ImageActivity> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const task = this.pending[i];
        if (task.kind === "barrier") break;
        if (task.input.albumId === input.albumId) {
          task.input = input;
          task.waiters.push(waiter);
          return;
        }
      }
      const current = this.running;
      if (
        this.pending.length === 0 &&
        current?.kind === "progress" &&
        current.input.albumId === input.albumId &&
        current.input.pageIndex === input.pageIndex &&
        current.input.pageCount === input.pageCount
      ) {
        current.waiters.push(waiter);
        return;
      }
      this.pending.push({ kind: "progress", input, waiters: [waiter] });
      void this.pump();
    });
  }

  barrier<T>(action: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        kind: "barrier",
        execute: async () => {
          try {
            resolve(await action());
          } catch (error) {
            reject(error);
          }
        },
      });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    let task: Task | undefined;
    while ((task = this.pending.shift())) {
      this.running = task;
      if (task.kind === "barrier") {
        await task.execute();
      } else {
        try {
          const result = await this.send(task.input);
          for (const waiter of task.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of task.waiters) waiter.reject(error);
        }
      }
      this.running = null;
    }
  }
}
