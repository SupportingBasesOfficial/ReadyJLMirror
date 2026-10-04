import { Component } from "react";
import type { ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            gap: "12px",
            fontFamily: "system-ui, sans-serif",
            padding: "24px",
            background: "var(--surface, #0f0f0f)",
            color: "var(--text, #e8e8e8)",
          }}
        >
          <p style={{ fontSize: 14, color: "var(--red, #f87171)" }}>
            Algo deu errado. Recarregue a página.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              fontSize: 12,
              padding: "6px 16px",
              borderRadius: 8,
              border: "1px solid var(--border, #333)",
              background: "var(--surface-2, #1a1a1a)",
              color: "var(--text, #e8e8e8)",
              cursor: "pointer",
            }}
          >
            Recarregar
          </button>
          {import.meta.env.DEV && (
            <pre
              style={{
                fontSize: 11,
                color: "var(--text-muted, #888)",
                maxWidth: 600,
                overflow: "auto",
                textAlign: "left",
                background: "var(--surface-2, #1a1a1a)",
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--border, #333)",
              }}
            >
              {this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
