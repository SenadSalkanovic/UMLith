import React from 'react';
import type { WorkspaceError } from '../types';
import { AlertOctagon, RefreshCw, Terminal, CheckCircle2, ArrowLeft } from 'lucide-react';

interface ErrorViewProps {
  error: WorkspaceError;
  onRetry: () => void;
  onBackToEmpty?: () => void;
}

export const ErrorView: React.FC<ErrorViewProps> = ({
  error,
  onRetry,
  onBackToEmpty,
}) => {
  return (
    <div className="error-view-container" data-testid="error-state">
      <div className="error-card">
        <div className="error-header">
          <AlertOctagon size={40} className="error-icon" />
          <div className="error-title-group">
            <h1 className="error-title" data-testid="error-title">{error.title}</h1>
            {error.statusCode && (
              <span className="error-status-badge">Status {error.statusCode}</span>
            )}
          </div>
        </div>

        <div className="error-message-box" data-testid="error-message">
          <p>{error.message}</p>
        </div>

        <div className="actionable-steps-section" data-testid="actionable-steps">
          <h2 className="steps-title">
            <Terminal size={18} />
            <span>Recommended Actions to Resolve</span>
          </h2>
          <ul className="steps-list">
            {error.actionableSteps.map((step, idx) => (
              <li key={idx} className="step-item">
                <CheckCircle2 size={16} className="step-bullet" />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="error-actions">
          <button
            className="btn btn-primary"
            onClick={onRetry}
            data-testid="retry-btn"
          >
            <RefreshCw size={16} />
            <span>Retry Connection</span>
          </button>

          {onBackToEmpty && (
            <button
              className="btn btn-secondary"
              onClick={onBackToEmpty}
              data-testid="error-back-btn"
            >
              <ArrowLeft size={16} />
              <span>Workspace Home</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
