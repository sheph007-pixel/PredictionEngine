import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// React 18 silently unmounts the whole tree if any component throws during
// render, leaving a blank page. This boundary catches the error, paints it
// visibly with the stack, and gives a one-click fix for the most common cause
// (stale localStorage with a shape the new code doesn't expect).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
    this.setState({ info });
  }
  resetLocal() {
    try {
      localStorage.removeItem('kennion.state.v1');
      localStorage.removeItem('kennion.library.v1');
    } catch {}
    location.reload();
  }
  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    const stack = (e && e.stack) || (this.state.info && this.state.info.componentStack) || '';
    return (
      <div style={{ font: '14px/1.5 ui-monospace,monospace', padding: 32, maxWidth: 900, margin: '40px auto', background: '#fff5f5', border: '1px solid #c44', borderRadius: 6, color: '#222' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#a33', marginBottom: 8 }}>Prediction Engine — render error</div>
        <div style={{ marginBottom: 8 }}>The app crashed during rendering. Most common cause: stale browser data left over from a previous version.</div>
        <div style={{ background: '#fff', padding: 12, borderRadius: 4, border: '1px solid #eed', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, marginBottom: 12 }}>
          {(e && e.message) || String(e)}
          {stack ? '\n\n' + stack : ''}
        </div>
        <button onClick={() => this.resetLocal()} style={{ padding: '8px 14px', background: '#a33', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
          Reset local data and reload
        </button>
        <div style={{ marginTop: 8, color: '#666', fontSize: 12 }}>This clears localStorage (buyer cache, library cache) and reloads. Your server-side data in Postgres is unaffected.</div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary><App /></ErrorBoundary>
);
