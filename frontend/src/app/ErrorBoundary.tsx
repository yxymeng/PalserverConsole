import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Frontend render failure", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="centered-page" role="alert"><h1>界面加载失败</h1><p className="error-detail">{this.state.error.message}</p><button className="primary-button" type="button" onClick={() => window.location.reload()}>重新加载</button></main>;
  }
}
