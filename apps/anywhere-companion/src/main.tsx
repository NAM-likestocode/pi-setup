import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class AppErrorBoundary extends Component<
	{ children: ReactNode },
	{ error: Error | null }
> {
	state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("Pimo Companion crashed", error, info.componentStack);
	}

	render() {
		if (this.state.error) {
			return (
				<main className="fatal-screen">
					<section className="fatal-card" role="alert">
						<p className="kicker">RECOVERABLE ERROR</p>
						<h1>The companion hit a snag.</h1>
						<p>{this.state.error.message}</p>
						<button
							className="primary-button"
							type="button"
							onClick={() => window.location.reload()}
						>
							Reload companion
						</button>
					</section>
				</main>
			);
		}
		return this.props.children;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("Companion root element is missing.");

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<AppErrorBoundary>
			<App />
		</AppErrorBoundary>
	</React.StrictMode>,
);
