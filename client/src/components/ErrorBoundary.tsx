import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="min-h-screen flex items-center justify-center bg-bg-base p-4">
          <div className="bg-bg-surface border border-red-500/20 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>

              <h2 className="text-xl font-bold text-text-main">Something went wrong</h2>

              <div className="bg-bg-base p-3 rounded-lg w-full overflow-hidden">
                <p className="text-sm text-text-muted font-mono wrap-break-word text-left">
                  {this.state.error?.message || 'Unknown error occurred'}
                </p>
              </div>

              <p className="text-text-muted text-sm">
                We apologize for the inconvenience. Please try refreshing the page.
              </p>

              <button
                onClick={this.handleReload}
                className="flex items-center gap-2 px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors font-medium"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Application
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
