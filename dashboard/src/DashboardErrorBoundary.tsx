import { CircleAlert, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { useUiPreferences } from "./ui-preferences";

function DashboardCrashFallback({ error }: { error: Error }) {
  const { t } = useUiPreferences();
  return (
    <main className="loading-shell error-shell" aria-live="assertive">
      <div className="loading-mark error-mark">
        <CircleAlert size={18} />
      </div>
      <p className="pane-kicker">Skill Reviewer</p>
      <h1>{t("dashboardRenderFailed")}</h1>
      <p>{error.message}</p>
      <p>{t("dashboardRenderRecovery")}</p>
      <button
        type="button"
        className="primary-action"
        onClick={() => window.location.reload()}
      >
        <RefreshCw size={13} />
        {t("reloadDashboard")}
      </button>
    </main>
  );
}

interface DashboardErrorBoundaryProps {
  children: ReactNode;
}

interface DashboardErrorBoundaryState {
  error: Error | null;
}

export class DashboardErrorBoundary extends Component<
  DashboardErrorBoundaryProps,
  DashboardErrorBoundaryState
> {
  state: DashboardErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DashboardErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard render failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <DashboardCrashFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
