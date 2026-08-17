import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时显示什么，以及给用户一条出路 */
  label: string;
}

interface State {
  error: Error | null;
}

/**
 * 隔离渲染层的异常。
 *
 * 画布跑在 canvas 上，一次渲染异常（比如 Konva 在 0 宽高时 drawImage 抛错）
 * 会顺着 React 把整棵树卸掉——连对话面板一起白屏，用户连"发生了什么"都看不到。
 * 把画布圈起来，至少让人还能说话、还能刷新。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] 渲染异常`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-title">{this.props.label}出错了</div>
        <div className="crash-detail">{this.state.error.message}</div>
        <div className="crash-actions">
          <button onClick={() => this.setState({ error: null })}>重试</button>
          <button onClick={() => location.reload()}>重新加载页面</button>
        </div>
        <div className="crash-note">你的内容存在服务端，刷新不会丢。</div>
      </div>
    );
  }
}
