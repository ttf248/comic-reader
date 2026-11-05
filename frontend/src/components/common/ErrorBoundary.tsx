import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 全局 React 错误边界,包在 <Outlet> 外,渲染期未捕获的异常落到这里。
//
// 仅 catch 同步 render 错误 + lifecycle 错误;event handler 内的
// 异常需要单独 try/catch。reset 按钮清状态重新渲染子树(重置 key)。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不在生产环境上报(没有 telemetry);本地用 console 即可
    console.error(
      "[ErrorBoundary] uncaught render error:",
      error,
      info.componentStack,
    );
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
        >
          <div className="text-page-sm font-semibold text-fg">图像库加载异常</div>
          <div className="max-w-md text-body text-fg-muted">
            {this.state.error.message || "未知错误,详见浏览器控制台"}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-md border border-border bg-bg-elevated px-4 py-2 text-body hover:bg-bg-overlay"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
