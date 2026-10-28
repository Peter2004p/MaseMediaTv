import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

type ErrorBoundaryState = { hasError: boolean; message: string };

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error || 'Unknown rendering error');
    return { hasError: true, message: message.slice(0, 500) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep diagnostics local; never send user content or session details to a third party.
    console.error('MaseNet interface encountered an unexpected error.', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main
          role="alert"
          style={{
            minHeight: '100dvh',
            display: 'grid',
            alignContent: 'center',
            justifyItems: 'center',
            gap: '14px',
            padding: '28px',
            textAlign: 'center',
            color: '#f5f5f5',
            background: '#070910',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div aria-hidden="true" style={{ fontSize: '42px' }}>◈</div>
          <h1 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 32px)' }}>MaseNet encountered an error</h1>
          <p style={{ maxWidth: '420px', color: '#aeb7c9', lineHeight: 1.6 }}>
            Your profile and saved titles have not been intentionally changed. The technical detail below is shown to help diagnose this issue.
          </p>
          <pre
            style={{
              boxSizing: 'border-box',
              width: 'min(100%, 620px)',
              maxHeight: '28dvh',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              padding: '14px',
              borderRadius: '12px',
              border: '1px solid #ffffff25',
              background: '#111722',
              color: '#ffd8a8',
              textAlign: 'left',
              fontSize: '12px',
              lineHeight: 1.5,
            }}
          >
            {this.state.message || 'Unknown rendering error'}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              minHeight: '44px',
              padding: '0 20px',
              border: '1px solid rgba(210,173,96,.5)',
              borderRadius: '14px',
              background: '#d2ad60',
              color: '#111',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Reload MaseNet
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  );
}
