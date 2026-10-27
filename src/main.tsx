import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // Keep diagnostics local; never send user content or session details to a third party.
    console.error('MaseNet interface encountered an unexpected error.', error.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main
          role="alert"
          style={{
            minHeight: '100dvh',
            display: 'grid',
            placeContent: 'center',
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
          <h1 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 32px)' }}>MaseNet needs a quick refresh</h1>
          <p style={{ maxWidth: '420px', color: '#aeb7c9', lineHeight: 1.6 }}>
            Something unexpected interrupted this page. Your account and saved library have not been intentionally changed.
          </p>
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
            Refresh MaseNet
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
